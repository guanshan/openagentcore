import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EventLogConflictError,
  EventLogInvariantError,
  type TurnStartedEvent,
} from '@openagentcore/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SqliteStore } from './sqlite.js';

const identity = { tenantId: 'tenant-sqlite', sessionId: 'session-sqlite' } as const;

describe('SqliteStore', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('persists byte KV values and EventLog snapshots across store reopen', async () => {
    const filename = await databaseFile(roots);
    const store = new SqliteStore({ filename });
    await store.kv.set('cursor', new Uint8Array([0, 1, 255]));
    const log = store.eventLog.open(identity);
    await log.append(turnStarted(0), -1);
    const snapshot = log.read(0);
    await log.append(turnStarted(1), 0);

    await expect(collect(snapshot)).resolves.toEqual([turnStarted(0)]);
    await expect(collect(snapshot)).resolves.toEqual([turnStarted(0)]);
    await store.close();

    const reopened = new SqliteStore({ filename });
    await expect(reopened.kv.get('cursor')).resolves.toEqual(new Uint8Array([0, 1, 255]));
    await expect(collect(reopened.eventLog.open(identity).read(0))).resolves.toEqual([
      turnStarted(0),
      turnStarted(1),
    ]);
    await expect(reopened.kv.delete('cursor')).resolves.toBe(true);
    await expect(reopened.kv.delete('cursor')).resolves.toBe(false);
    await reopened.close();
  });

  it('atomically arbitrates stale writers on separate connections without holes', async () => {
    const filename = await databaseFile(roots);
    const first = new SqliteStore({ filename });
    const second = new SqliteStore({ filename });
    const firstLog = first.eventLog.open(identity);
    const secondLog = second.eventLog.open(identity);

    const outcomes = await Promise.allSettled([
      firstLog.append(turnStarted(0), -1),
      secondLog.append(turnStarted(0), -1),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: expect.any(EventLogConflictError) });
    await expect(collect(firstLog.read(0))).resolves.toEqual([turnStarted(0)]);

    await first.close();
    await second.close();
  });

  it('rejects gaps and isolates failed appends from process-local subscribers', async () => {
    const store = new SqliteStore({ filename: await databaseFile(roots) });
    const log = store.eventLog.open(identity);
    const subscriber = vi.fn();
    log.subscribe(subscriber);

    await expect(log.append(turnStarted(1), -1)).rejects.toBeInstanceOf(EventLogInvariantError);
    await expect(log.append(turnStarted(0), -1)).resolves.toBeUndefined();
    await expect(log.append(turnStarted(1), -1)).rejects.toBeInstanceOf(EventLogConflictError);

    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber).toHaveBeenCalledWith(turnStarted(0));
    await store.close();
  });
});

function turnStarted(seq: number): TurnStartedEvent {
  return {
    type: 'turn.started',
    seq,
    ...identity,
    ts: '2026-08-12T00:00:00Z',
    turnId: 'turn-store',
    input: { content: 'store conformance' },
  };
}

async function databaseFile(roots: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oac-sqlite-store-'));
  roots.push(root);
  return join(root, 'event-log.sqlite');
}

async function collect<T>(events: AsyncIterable<T>): Promise<readonly T[]> {
  const values: T[] = [];
  for await (const event of events) values.push(event);
  return values;
}
