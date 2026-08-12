import { randomUUID } from 'node:crypto';

import {
  EventLogConflictError,
  type StorePort,
  type TurnStartedEvent,
} from '@openagentcore/kernel';
import { describe, expect, it } from 'vitest';

import { MySqlStore } from './mysql.js';
import { RedisStore } from './redis.js';

describe('external durable stores', () => {
  const mysqlUri = process.env['OAC_MYSQL_URL'];
  const redisUrl = process.env['OAC_REDIS_URL'];

  it.skipIf(mysqlUri === undefined)(
    'atomically arbitrates concurrent MySQL writers',
    async () => {
      if (mysqlUri === undefined) return;
      const first = await MySqlStore.create({ uri: mysqlUri });
      const second = await MySqlStore.create({ uri: mysqlUri });
      try {
        await expectConcurrentCas(first, second, 'mysql');
      } finally {
        await Promise.all([first.close(), second.close()]);
      }
    },
    15_000,
  );

  it.skipIf(redisUrl === undefined)(
    'atomically arbitrates concurrent Redis writers while declaring configured durability',
    async () => {
      if (redisUrl === undefined) return;
      const prefix = `oac-test-${randomUUID()}`;
      const first = await RedisStore.create({ url: redisUrl, keyPrefix: prefix });
      const second = await RedisStore.create({ url: redisUrl, keyPrefix: prefix });
      try {
        expect(first.capabilities.durability).toBe('deployment-configured');
        await expectConcurrentCas(first, second, 'redis');
      } finally {
        await Promise.all([first.close(), second.close()]);
      }
    },
    15_000,
  );
});

async function expectConcurrentCas(
  first: StorePort,
  second: StorePort,
  engine: string,
): Promise<void> {
  const identity = {
    tenantId: `tenant-${engine}`,
    sessionId: `session-${randomUUID()}`,
  };
  const firstLog = first.eventLog.open(identity);
  const secondLog = second.eventLog.open(identity);
  const event = turnStarted(identity, 0);
  const outcomes = await Promise.allSettled([
    firstLog.append(event, -1),
    secondLog.append(event, -1),
  ]);

  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  expect(rejected).toHaveLength(1);
  expect(rejected[0]).toMatchObject({ reason: expect.any(EventLogConflictError) });
  await expect(collect(firstLog.read(0))).resolves.toEqual([event]);
}

function turnStarted(
  identity: { readonly tenantId: string; readonly sessionId: string },
  seq: number,
): TurnStartedEvent {
  return {
    type: 'turn.started',
    ...identity,
    seq,
    ts: '2026-08-12T00:00:00Z',
    turnId: 'turn-external-store',
    input: { content: 'external store conformance' },
  };
}

async function collect<T>(events: AsyncIterable<T>): Promise<readonly T[]> {
  const values: T[] = [];
  for await (const event of events) values.push(event);
  return values;
}
