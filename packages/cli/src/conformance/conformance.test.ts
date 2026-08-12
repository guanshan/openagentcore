import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  InMemoryEventLog,
  LocalProcessSandbox,
  NoopTracer,
  ScriptedModelPort,
  type ModelPort,
  type SandboxPort,
  type StorePort,
  type TracePort,
  defineCredentialScope,
} from '@openagentcore/kernel';
import {
  EnvironmentVault,
  SqliteStore,
  environmentVariableForScope,
} from '@openagentcore/standard';
import { describe, expect, it } from 'vitest';

import { runModelConformance } from './model.js';
import { createConformanceReport, formatCapabilityMatrix, formatHumanReport } from './report.js';
import { runSandboxConformance } from './sandbox.js';
import { runStoreConformance } from './store.js';
import { runTraceConformance } from './trace.js';
import { runVaultConformance } from './vault.js';

describe('Port conformance suites', () => {
  it('passes honest model and local sandbox adapters', async () => {
    const model = await runModelConformance({
      name: 'honest-model',
      create: () =>
        new ScriptedModelPort([
          [
            { kind: 'text', text: 'ok' },
            { kind: 'finish', reason: 'stop' },
          ],
        ]),
    });
    const sandbox = await runSandboxConformance({
      name: 'honest-sandbox',
      create: (root) => new LocalProcessSandbox({ root }),
    });

    expect(model.status).toBe('passed');
    expect(sandbox.status).toBe('passed');
  });

  it('marks a deliberately dishonest model adapter red', async () => {
    const dishonest: ModelPort = {
      capabilities: {
        streaming: true,
        toolUse: 'none',
        promptCaching: false,
        structuredOutput: false,
        maxContext: 1,
        vision: false,
      },
      countTokens: async () => 1,
      stream: async function* () {
        yield* [];
        throw new Error('streaming is not actually supported');
      },
    };

    const result = await runModelConformance({ name: 'dishonest-model', create: () => dishonest });

    expect(result.status).toBe('failed');
    expect(result.cases).toContainEqual(
      expect.objectContaining({
        name: 'declared stream mode produces exactly one terminal finish',
        status: 'failed',
      }),
    );
  });

  it('marks a dishonest snapshot declaration red and keeps unavailable adapters skipped', async () => {
    const dishonest = await runSandboxConformance({
      name: 'dishonest-sandbox',
      create: (root) => {
        const local = new LocalProcessSandbox({ root });
        return {
          ...local,
          capabilities: { snapshot: true },
          workspacePath: local.workspacePath,
          fs: local.fs,
          exec: (request, signal) => local.exec(request, signal),
        } as SandboxPort;
      },
    });
    const unavailable = await runSandboxConformance({
      name: 'optional-sandbox',
      create: (root) => new LocalProcessSandbox({ root }),
      availability: async () => ({ available: false, reason: 'optional daemon missing' }),
    });

    expect(dishonest.status).toBe('failed');
    expect(unavailable).toMatchObject({ status: 'skipped', detail: 'optional daemon missing' });
  });

  it('passes SQLite store conformance and marks a lying atomic-CAS store red', async () => {
    const filename = join(tmpdir(), `oac-cli-store-test-${randomUUID()}.sqlite`);
    const sqlite = await runStoreConformance({
      name: 'sqlite-test',
      create: async () => new SqliteStore({ filename }),
      dispose: async () => {
        await Promise.all(
          ['', '-shm', '-wal'].map((suffix) => rm(`${filename}${suffix}`, { force: true })),
        );
      },
    });
    const dishonest = await runStoreConformance({
      name: 'dishonest-store',
      create: async () => dishonestStore(),
    });

    expect(sqlite.status).toBe('passed');
    expect(dishonest.status).toBe('failed');
    expect(dishonest.cases).toContainEqual(
      expect.objectContaining({
        name: 'atomic CAS admits exactly one stale multi-writer append',
        status: 'failed',
      }),
    );
  });

  it('passes Noop trace conformance and marks dishonest content capture red', async () => {
    const noop = await runTraceConformance({
      name: 'noop-trace',
      create: () => new NoopTracer(),
    });
    const dishonest = await runTraceConformance({
      name: 'dishonest-trace',
      create: () => dishonestTrace(),
    });

    expect(noop.status).toBe('passed');
    expect(dishonest.status).toBe('failed');
    expect(dishonest.cases).toContainEqual(
      expect.objectContaining({
        name: 'capability declaration is structurally valid and honest',
        status: 'failed',
      }),
    );
  });

  it('passes an opaque scoped vault and keeps generated material out of results', async () => {
    const material = randomBytes(32).toString('base64url');
    let now = Date.now();
    const primaryScope = defineCredentialScope('test/a', {
      targets: [{ urlPrefix: 'https://vault-test.invalid/a' }],
    });
    const otherScope = defineCredentialScope('test/b', {
      targets: [{ urlPrefix: 'https://vault-test.invalid/b' }],
    });
    let authenticated = false;
    const result = await runVaultConformance(
      {
        name: 'honest-vault',
        create: async (generated) => ({
          vault: new EnvironmentVault({
            environment: { [environmentVariableForScope(primaryScope.id)]: generated },
            ttlMs: 100,
            now: () => now,
            fetch: async (_input, init) => {
              authenticated =
                new Headers(init?.headers).get('authorization') === `Bearer ${generated}`;
              return new Response(null, { status: 204 });
            },
          }),
          primaryScope,
          otherScope,
          primaryRequest: { url: 'https://vault-test.invalid/a/use' },
          otherRequest: { url: 'https://vault-test.invalid/b/use' },
          advanceClock: (ms) => {
            now += ms;
          },
          authenticated: () => authenticated,
        }),
      },
      material,
    );

    expect(result.status).toBe('passed');
    expect(JSON.stringify(result)).not.toContain(material);
  });

  it('formats human, JSON-backed matrix, and overall failure consistently', () => {
    const report = createConformanceReport([
      {
        port: 'sandbox',
        adapter: 'optional',
        status: 'skipped',
        capabilities: { snapshot: false },
        detail: 'not installed',
        cases: [],
      },
      {
        port: 'model',
        adapter: 'broken',
        status: 'failed',
        capabilities: { streaming: true },
        detail: '1 of 1 cases failed.',
        cases: [{ name: 'stream', status: 'failed', detail: 'broken' }],
      },
    ]);

    expect(report.status).toBe('failed');
    expect(formatHumanReport(report)).toContain('sandbox/optional: SKIPPED - not installed');
    expect(formatCapabilityMatrix(report)).toContain('| sandbox | optional | skipped |');
  });
});

function dishonestStore(): StorePort {
  const values = new Map<string, Uint8Array>();
  return {
    capabilities: {
      atomicCas: true,
      sequence: 'contiguous',
      readConsistency: 'strong-primary',
      durability: 'committed',
    },
    kv: {
      get: async (key) => {
        const value = values.get(key);
        return value === undefined ? undefined : new Uint8Array(value);
      },
      set: async (key, value) => {
        values.set(key, new Uint8Array(value));
      },
      delete: async (key) => values.delete(key),
    },
    eventLog: {
      open: (identity) => {
        const delegate = new InMemoryEventLog(identity);
        return {
          ...identity,
          append: async (event) => delegate.append(event),
          read: (fromSeq) => delegate.read(fromSeq),
          subscribe: (subscriber, onError) => delegate.subscribe(subscriber, onError),
        };
      },
    },
  };
}

function dishonestTrace(): TracePort {
  const noop = new NoopTracer();
  return {
    capabilities: { exporter: 'dishonest', contentCapture: true },
    startSpan: () => noop.startSpan(),
    recordMetric: () => noop.recordMetric(),
  };
}
