import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalProcessSandbox, NoopTracer, defineCredentialScope } from '@openagentcore/kernel';
import {
  DockerSandbox,
  MYSQL_STORE_CAPABILITIES,
  MySqlStore,
  OtlpTracePort,
  REDIS_STORE_CAPABILITIES,
  RedisStore,
  SQLITE_STORE_CAPABILITIES,
  EncryptedFileVault,
  EnvironmentVault,
  environmentVariableForScope,
  SqliteStore,
  writeEncryptedVaultFile,
} from '@openagentcore/standard';
import { OpenAICompatibleModel } from '@openagentcore/standard/model';
import {
  TENCENT_HY3_CAPABILITIES,
  TencentAgentRuntimeSandbox,
  TencentHunyuanModel,
  createTencentApmTrace,
} from '@openagentcore/tencent';

import type {
  ModelConformanceAdapter,
  SandboxConformanceAdapter,
  StoreConformanceAdapter,
  TraceConformanceAdapter,
  VaultConformanceAdapter,
} from './types.js';

export function defaultModelAdapters(): readonly ModelConformanceAdapter[] {
  return [
    {
      name: '@openagentcore/standard/openai-compatible',
      create: () =>
        new OpenAICompatibleModel({
          baseUrl: 'http://conformance.invalid/v1',
          model: 'conformance',
          capabilities: { maxContext: 4_096, toolUse: 'prompted' },
          includeUsage: false,
          fetch: async () => conformanceStream(),
        }),
    },
    {
      name: '@openagentcore/tencent/tokenhub-hy3',
      capabilities: { ...TENCENT_HY3_CAPABILITIES },
      availability: async () =>
        environmentAvailability(['TENCENT_TOKENHUB_API_KEY'], 'Tencent TokenHub'),
      create: () =>
        new TencentHunyuanModel({
          apiKey: requiredEnvironmentValue('TENCENT_TOKENHUB_API_KEY'),
        }),
    },
  ];
}

export function defaultSandboxAdapters(): readonly SandboxConformanceAdapter[] {
  const apiKey = process.env['E2B_API_KEY'];
  const domain = process.env['E2B_DOMAIN'];
  const template = process.env['AGS_TEMPLATE'];
  return [
    {
      name: '@openagentcore/kernel/local-process',
      create: (root) => new LocalProcessSandbox({ root }),
    },
    {
      name: '@openagentcore/standard/docker',
      create: (root) => new DockerSandbox({ root }),
      availability: async (sandbox, signal) => {
        if (!(sandbox instanceof DockerSandbox)) {
          return { available: false, reason: 'Default Docker factory returned the wrong adapter.' };
        }
        return sandbox.availability(signal);
      },
    },
    {
      name: '@openagentcore/tencent/agent-runtime',
      create: () =>
        new TencentAgentRuntimeSandbox({
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(domain === undefined ? {} : { domain }),
          ...(template === undefined ? {} : { template }),
        }),
      availability: async () =>
        environmentAvailability(
          ['E2B_API_KEY', 'E2B_DOMAIN', 'AGS_TEMPLATE'],
          'Tencent Agent Runtime',
        ),
    },
  ];
}

export function defaultStoreAdapters(): readonly StoreConformanceAdapter[] {
  const sqlitePath = join(tmpdir(), `oac-store-conformance-${randomUUID()}.sqlite`);
  const mysqlUri = process.env['OAC_MYSQL_URL'];
  const redisUrl = process.env['OAC_REDIS_URL'];
  const redisPrefix = `oac-conformance-${randomUUID()}`;
  return [
    {
      name: '@openagentcore/standard/sqlite',
      capabilities: SQLITE_STORE_CAPABILITIES,
      create: async () => new SqliteStore({ filename: sqlitePath }),
      dispose: async () => {
        await Promise.all(
          ['', '-shm', '-wal'].map((suffix) => rm(`${sqlitePath}${suffix}`, { force: true })),
        );
      },
    },
    {
      name: '@openagentcore/standard/mysql',
      capabilities: MYSQL_STORE_CAPABILITIES,
      availability: async () =>
        availabilityProbe(mysqlUri, 'OAC_MYSQL_URL', (uri) => MySqlStore.create({ uri })),
      create: async () => {
        if (mysqlUri === undefined) throw new Error('OAC_MYSQL_URL is unavailable.');
        return MySqlStore.create({ uri: mysqlUri });
      },
    },
    {
      name: '@openagentcore/standard/redis',
      capabilities: REDIS_STORE_CAPABILITIES,
      availability: async () =>
        availabilityProbe(redisUrl, 'OAC_REDIS_URL', (url) =>
          RedisStore.create({ url, keyPrefix: redisPrefix }),
        ),
      create: async () => {
        if (redisUrl === undefined) throw new Error('OAC_REDIS_URL is unavailable.');
        return RedisStore.create({ url: redisUrl, keyPrefix: redisPrefix });
      },
    },
  ];
}

export function defaultTraceAdapters(): readonly TraceConformanceAdapter[] {
  return [
    {
      name: '@openagentcore/kernel/noop',
      create: () => new NoopTracer(),
    },
    {
      name: '@openagentcore/standard/otlp-http',
      create: () =>
        new OtlpTracePort({
          endpoint: 'http://conformance.invalid',
          fetch: async () => new Response(null, { status: 200 }),
        }),
    },
    {
      name: '@openagentcore/tencent/apm-otlp-http',
      capabilities: { exporter: 'otlp-http', contentCapture: false },
      availability: async () => environmentAvailability(['TENCENT_APM_ENDPOINT'], 'Tencent APM'),
      create: () =>
        createTencentApmTrace({
          endpoint: process.env['TENCENT_APM_ENDPOINT'] ?? 'http://unavailable.invalid',
          ...optionalAuthorization(process.env['TENCENT_APM_TOKEN']),
        }),
    },
  ];
}

export function defaultVaultAdapters(): readonly VaultConformanceAdapter[] {
  return [environmentVaultAdapter(), encryptedFileVaultAdapter()];
}

function environmentVaultAdapter(): VaultConformanceAdapter {
  return {
    name: '@openagentcore/standard/environment-vault',
    create: async (material) => vaultFixture(material, (options) => new EnvironmentVault(options)),
  };
}

function encryptedFileVaultAdapter(): VaultConformanceAdapter {
  const filename = join(tmpdir(), `oac-vault-conformance-${randomUUID()}.json`);
  const passphrase = randomBytes(32).toString('base64url');
  return {
    name: '@openagentcore/standard/encrypted-file-vault',
    create: async (material) => {
      const scopes = conformanceScopes();
      await writeEncryptedVaultFile({
        filename,
        passphrase,
        credentials: {
          [scopes.primary.id]: material,
          [scopes.other.id]: material,
        },
      });
      return vaultFixture(
        material,
        (options) => new EncryptedFileVault({ ...options, filename, passphrase }),
        scopes,
      );
    },
    dispose: async () => rm(filename, { force: true }),
  };
}

function vaultFixture(
  material: string,
  create: (
    options: ConstructorParameters<typeof EnvironmentVault>[0],
  ) => EnvironmentVault | EncryptedFileVault,
  scopes = conformanceScopes(),
): Awaited<ReturnType<VaultConformanceAdapter['create']>> {
  let now = Date.now();
  let authenticated = false;
  const environment = {
    [environmentVariableForScope(scopes.primary.id)]: material,
    [environmentVariableForScope(scopes.other.id)]: material,
  };
  const vault = create({
    environment,
    ttlMs: 100,
    now: () => now,
    fetch: async (_input, init) => {
      authenticated = new Headers(init?.headers).get('authorization') === `Bearer ${material}`;
      return new Response(null, { status: 204 });
    },
  });
  return {
    vault,
    primaryScope: scopes.primary,
    otherScope: scopes.other,
    primaryRequest: { url: 'https://vault-conformance.invalid/a/use', method: 'POST' },
    otherRequest: { url: 'https://vault-conformance.invalid/b/use', method: 'POST' },
    advanceClock: (ms) => {
      now += ms;
    },
    authenticated: () => authenticated,
  };
}

function conformanceScopes(): {
  readonly primary: ReturnType<typeof defineCredentialScope>;
  readonly other: ReturnType<typeof defineCredentialScope>;
} {
  return {
    primary: defineCredentialScope('conformance/a', {
      targets: [{ urlPrefix: 'https://vault-conformance.invalid/a', methods: ['POST'] }],
    }),
    other: defineCredentialScope('conformance/b', {
      targets: [{ urlPrefix: 'https://vault-conformance.invalid/b', methods: ['POST'] }],
    }),
  };
}

async function availabilityProbe(
  endpoint: string | undefined,
  environmentName: string,
  create: (endpoint: string) => Promise<{ close?(): Promise<void> }>,
): Promise<{ readonly available: boolean; readonly reason: string }> {
  if (endpoint === undefined) {
    return { available: false, reason: `${environmentName} is not configured.` };
  }
  try {
    const store = await create(endpoint);
    await store.close?.();
    return { available: true, reason: 'available' };
  } catch (error) {
    return {
      available: false,
      reason: `${environmentName} prerequisite is unavailable: ${stableError(error)}`,
    };
  }
}

function stableError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function environmentAvailability(
  variables: readonly string[],
  service: string,
): { readonly available: boolean; readonly reason: string } {
  const missing = variables.filter((variable) => {
    const value = process.env[variable];
    return value === undefined || value.length === 0;
  });
  return missing.length === 0
    ? { available: true, reason: 'available' }
    : {
        available: false,
        reason: `${service} live verification is unverified; missing ${missing.join(', ')}.`,
      };
}

function optionalAuthorization(value: string | undefined): {
  readonly headers?: Readonly<Record<string, string>>;
} {
  return value === undefined || value.length === 0
    ? {}
    : { headers: Object.freeze({ Authorization: value }) };
}

function requiredEnvironmentValue(variable: string): string {
  const value = process.env[variable];
  if (value === undefined || value.length === 0) {
    throw new Error(`Required environment variable ${variable} is unavailable.`);
  }
  return value;
}

function conformanceStream(): Response {
  return new Response(
    [
      'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n'),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
