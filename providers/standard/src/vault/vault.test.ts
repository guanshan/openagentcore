import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspect } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentLoop,
  CredentialExpiredError,
  CredentialReleasedError,
  CredentialScopeError,
  InMemoryEventLog,
  ScriptedModelPort,
  ToolRegistry,
  defineCredentialScope,
  withCredential,
  type CredentialToolPort,
  type ShortLivedCredential,
  type ToolExecutionRequest,
  type ToolExecutionResult,
} from '@openagentcore/kernel';
import { describe, expect, it, vi } from 'vitest';

import { OtlpTracePort } from '../trace/otlp.js';
import {
  EncryptedFileVault,
  EnvironmentVault,
  KmsVault,
  environmentVariableForScope,
  writeEncryptedVaultFile,
} from './vault.js';

describe('Vault adapters', () => {
  it('enforces expiry, refresh, and exact scope targets without exposing material', async () => {
    const material = runtimeMaterial();
    let now = Date.parse('2026-08-12T00:00:00Z');
    let authenticatedRequests = 0;
    const scope = defineCredentialScope('service/a', {
      targets: [{ urlPrefix: 'https://vault-conformance.invalid/a', methods: ['POST'] }],
    });
    const otherScope = defineCredentialScope('service/b', {
      targets: [{ urlPrefix: 'https://vault-conformance.invalid/b', methods: ['POST'] }],
    });
    const vault = new EnvironmentVault({
      environment: { [environmentVariableForScope(scope.id)]: material },
      ttlMs: 100,
      now: () => now,
      fetch: async (_input, init) => {
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${material}`);
        authenticatedRequests += 1;
        return new Response('ok', { status: 200 });
      },
    });

    const credential = await vault.issue(scope);
    expect(inspect(credential, { showHidden: true, depth: 8 })).not.toContain(material);
    await expect(
      credential.request(
        { url: 'https://vault-conformance.invalid/b/operation', method: 'POST' },
        signal(),
      ),
    ).rejects.toBeInstanceOf(CredentialScopeError);
    await credential.request(
      { url: 'https://vault-conformance.invalid/a/operation', method: 'POST' },
      signal(),
    );

    now += 101;
    await expect(
      credential.request(
        { url: 'https://vault-conformance.invalid/a/operation', method: 'POST' },
        signal(),
      ),
    ).rejects.toBeInstanceOf(CredentialExpiredError);
    const refreshed = await credential.refresh(signal());
    await expect(credential.refresh(signal())).rejects.toBeInstanceOf(CredentialReleasedError);
    await refreshed.request(
      { url: 'https://vault-conformance.invalid/a/operation', method: 'POST' },
      signal(),
    );
    expect(refreshed.scope.id).not.toBe(otherScope.id);
    expect(authenticatedRequests).toBe(2);
  });

  it('round-trips an encrypted 0600 file without persisting plaintext', async () => {
    const material = runtimeMaterial();
    const passphrase = runtimeMaterial();
    const filename = join(tmpdir(), `oac-vault-${randomUUID()}.json`);
    const scope = defineCredentialScope('encrypted/service', {
      targets: [{ urlPrefix: 'https://encrypted-vault.invalid/api' }],
    });
    await writeEncryptedVaultFile({
      filename,
      passphrase,
      credentials: { [scope.id]: material },
    });
    expect(await readFile(filename, 'utf8')).not.toContain(material);

    let authenticated = false;
    const vault = new EncryptedFileVault({
      filename,
      passphrase,
      fetch: async (_input, init) => {
        authenticated = new Headers(init?.headers).get('authorization') === `Bearer ${material}`;
        return new Response(null, { status: 204 });
      },
    });
    const credential = await vault.issue(scope);
    await credential.request({ url: 'https://encrypted-vault.invalid/api/check' }, signal());
    expect(authenticated).toBe(true);
  });

  it('reserves cloud KMS behind a provider-owned short-lived issuer', async () => {
    const material = runtimeMaterial();
    const scope = defineCredentialScope('kms/service');
    const close = vi.fn<() => Promise<void>>(async () => undefined);
    const vault = new KmsVault({
      issuer: {
        issue: async () => ({
          value: material,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        close,
      },
    });

    const credential = await vault.issue(scope);
    expect(credential.scope.id).toBe(scope.id);
    expect(inspect(vault, { showHidden: true, depth: 8 })).not.toContain(material);
    await vault.close();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('withCredential', () => {
  it('keeps long-lived material out of tool reflection, events, traces, and logs', async () => {
    const material = runtimeMaterial();
    const scope = defineCredentialScope('tool/reflection', {
      targets: [{ urlPrefix: 'https://credential-tool.invalid/invoke', methods: ['POST'] }],
    });
    const rawTool = new ReflectingCredentialTool();
    const tool = withCredential(scope)(rawTool);
    let authenticated = false;
    const vault = new EnvironmentVault({
      environment: { [environmentVariableForScope(scope.id)]: material },
      fetch: async (_input, init) => {
        authenticated = new Headers(init?.headers).get('authorization') === `Bearer ${material}`;
        return new Response(JSON.stringify({ accepted: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const exported: string[] = [];
    const trace = new OtlpTracePort({
      endpoint: 'https://trace.invalid',
      fetch: async (_input, init) => {
        exported.push(String(init?.body));
        return new Response(null, { status: 200 });
      },
    });
    const eventLog = new InMemoryEventLog({ tenantId: 'vault-test', sessionId: randomUUID() });
    const model = new ScriptedModelPort([
      [
        { kind: 'tool-call', callId: 'credential-call', tool: tool.name, args: {} },
        { kind: 'finish', reason: 'tool-calls' },
      ],
      [
        { kind: 'text', text: 'complete' },
        { kind: 'finish', reason: 'stop' },
      ],
    ]);
    const loop = new AgentLoop({
      eventLog,
      model,
      tools: new ToolRegistry().register(tool),
      trace,
      vault,
    });

    await loop.runTurn({ content: 'Use the credential-bound tool.' });
    await trace.forceFlush();
    const events = await collect(eventLog.read(0));
    const serializedAudit = JSON.stringify({ events, exported });

    expect(authenticated).toBe(true);
    expect(rawTool.reflection).not.toContain(material);
    expect(serializedAudit).not.toContain(material);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'credential.used',
        callId: 'credential-call',
        tool: tool.name,
        scope: scope.id,
        attempt: 1,
      }),
    );
    expect(exported.join('\n')).toContain('openagentcore.credential.scope');
    expect(exported.join('\n')).toContain(scope.id);
  });
});

class ReflectingCredentialTool implements CredentialToolPort {
  readonly name = 'credential-reflection';
  readonly inputSchema = Object.freeze({ type: 'object', additionalProperties: false });
  readonly permission = Object.freeze({ kind: 'external-request' });
  reflection = '';

  async execute(
    request: ToolExecutionRequest,
    credential: ShortLivedCredential,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    this.reflection = inspect({ tool: this, credential }, { showHidden: true, depth: 12 });
    const response = await credential.request(
      {
        url: 'https://credential-tool.invalid/invoke',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.args),
      },
      signal,
    );
    return {
      outcome: response.status === 200 ? 'succeeded' : 'failed',
      result: { status: response.status },
    };
  }
}

function runtimeMaterial(): string {
  return randomBytes(32).toString('base64url');
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function collect<T>(values: AsyncIterable<T>): Promise<readonly T[]> {
  const collected: T[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}
