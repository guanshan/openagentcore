import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalProcessSandbox, NoopTracer } from '@openagentcore/kernel';
import {
  DockerSandbox,
  MYSQL_STORE_CAPABILITIES,
  MySqlStore,
  OtlpTracePort,
  REDIS_STORE_CAPABILITIES,
  RedisStore,
  SQLITE_STORE_CAPABILITIES,
  SqliteStore,
} from '@openagentcore/standard';
import { OpenAICompatibleModel } from '@openagentcore/standard/model';

import type {
  ModelConformanceAdapter,
  SandboxConformanceAdapter,
  StoreConformanceAdapter,
  TraceConformanceAdapter,
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
  ];
}

export function defaultSandboxAdapters(): readonly SandboxConformanceAdapter[] {
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
  ];
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
