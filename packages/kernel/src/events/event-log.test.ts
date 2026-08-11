import { describe, expect, it, vi } from 'vitest';

import { EventLogInvariantError, InMemoryEventLog } from './event-log.js';
import { assertSchemaValidEvent } from './schema.test-support.js';
import type { AgentEvent, TurnStartedEvent } from './types.js';

const identity = {
  tenantId: 'tenant-test',
  sessionId: 'session-test',
} as const;

function turnStarted(seq: number): TurnStartedEvent {
  return assertSchemaValidEvent({
    type: 'turn.started',
    seq,
    ...identity,
    ts: '2026-08-11T00:00:00Z',
    turnId: 'turn-1',
    input: { content: 'Hello.' },
  });
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe('InMemoryEventLog', () => {
  it('reads a finite snapshot and includes fromSeq', async () => {
    const log = new InMemoryEventLog(identity);
    await log.append(turnStarted(0));
    await log.append(turnStarted(2));

    const snapshot = log.read(0);
    await log.append(turnStarted(5));

    await expect(collect(snapshot)).resolves.toEqual([turnStarted(0), turnStarted(2)]);
    await expect(collect(log.read(2))).resolves.toEqual([turnStarted(2), turnStarted(5)]);
  });

  it('allows the same finite read snapshot to be iterated more than once', async () => {
    const log = new InMemoryEventLog(identity);
    await log.append(turnStarted(0));
    await log.append(turnStarted(2));
    const snapshot = log.read(0);

    await expect(collect(snapshot)).resolves.toEqual([turnStarted(0), turnStarted(2)]);
    await expect(collect(snapshot)).resolves.toEqual([turnStarted(0), turnStarted(2)]);
  });

  it('rejects a stale expectedLastSeq without appending or notifying subscribers', async () => {
    const log = new InMemoryEventLog(identity);
    await log.append(turnStarted(0), -1);
    const subscriber = vi.fn();
    log.subscribe(subscriber);

    await expect(log.append(turnStarted(1), -1)).rejects.toMatchObject({
      name: 'EventLogConflictError',
      expectedLastSeq: -1,
      actualLastSeq: 0,
    });
    await expect(collect(log.read(0))).resolves.toEqual([turnStarted(0)]);
    expect(subscriber).not.toHaveBeenCalled();

    await expect(log.append(turnStarted(1), 0)).resolves.toBeUndefined();
    expect(subscriber).toHaveBeenCalledWith(turnStarted(1));
  });

  it('rejects repeated and decreasing sequence numbers without appending them', async () => {
    const log = new InMemoryEventLog(identity);
    await log.append(turnStarted(3));

    await expect(log.append(turnStarted(3))).rejects.toBeInstanceOf(EventLogInvariantError);
    await expect(log.append(turnStarted(2))).rejects.toBeInstanceOf(EventLogInvariantError);
    await expect(collect(log.read(0))).resolves.toEqual([turnStarted(3)]);
  });

  it('rejects an event from another tenant or session', async () => {
    const log = new InMemoryEventLog(identity);
    const wrongSession = assertSchemaValidEvent({
      ...turnStarted(0),
      sessionId: 'session-other',
    });
    const wrongTenant = assertSchemaValidEvent({
      ...turnStarted(1),
      tenantId: 'tenant-other',
    });

    await expect(log.append(wrongSession)).rejects.toBeInstanceOf(EventLogInvariantError);
    await expect(log.append(wrongTenant)).rejects.toBeInstanceOf(EventLogInvariantError);
    await expect(collect(log.read(0))).resolves.toEqual([]);
  });

  it('notifies subscribers only for future successful appends', async () => {
    const log = new InMemoryEventLog(identity);
    const subscriber = vi.fn();
    await log.append(turnStarted(0));

    const unsubscribe = log.subscribe(subscriber);
    await log.append(turnStarted(1));
    await expect(log.append(turnStarted(1))).rejects.toBeInstanceOf(EventLogInvariantError);
    unsubscribe();
    unsubscribe();
    await log.append(turnStarted(2));

    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber).toHaveBeenCalledWith(turnStarted(1));
  });

  it('isolates appended and returned events from external mutation', async () => {
    const log = new InMemoryEventLog(identity);
    const original = turnStarted(0);
    await log.append(original);

    (original.input as { content: string }).content = 'Mutated after append.';
    const firstRead = await collect(log.read(0));
    const firstEvent = firstRead[0];
    if (firstEvent?.type !== 'turn.started') {
      throw new Error('Expected a turn.started event.');
    }
    expect(firstEvent.input.content).toBe('Hello.');

    (firstEvent.input as { content: string }).content = 'Mutated after read.';
    await expect(collect(log.read(0))).resolves.toEqual([turnStarted(0)]);
  });

  it('keeps append committed and notifies remaining subscribers when one throws', async () => {
    const log = new InMemoryEventLog(identity);
    const secondSubscriber = vi.fn();
    log.subscribe(() => {
      throw new Error('subscriber failed');
    });
    log.subscribe(secondSubscriber);

    await expect(log.append(turnStarted(0))).resolves.toBeUndefined();

    await expect(collect(log.read(0))).resolves.toEqual([turnStarted(0)]);
    expect(secondSubscriber).toHaveBeenCalledWith(turnStarted(0));
  });

  it('reports subscriber failures without interrupting append delivery', async () => {
    const log = new InMemoryEventLog(identity);
    const subscriberError = new Error('subscriber failed');
    const onSubscriberError = vi.fn();
    const secondSubscriber = vi.fn();
    log.subscribe(() => {
      throw subscriberError;
    }, onSubscriberError);
    log.subscribe(secondSubscriber);

    await expect(log.append(turnStarted(0))).resolves.toBeUndefined();

    expect(onSubscriberError).toHaveBeenCalledWith(subscriberError, turnStarted(0));
    expect(secondSubscriber).toHaveBeenCalledWith(turnStarted(0));
    await expect(collect(log.read(0))).resolves.toEqual([turnStarted(0)]);
  });

  it('rejects invalid sequence inputs at the log boundary', async () => {
    const log = new InMemoryEventLog(identity);
    const invalidEvent = { ...turnStarted(0), seq: -1 };

    await expect(log.append(invalidEvent)).rejects.toBeInstanceOf(EventLogInvariantError);
    expect(() => log.read(-1)).toThrow(EventLogInvariantError);
    expect(() => log.read(0.5)).toThrow(EventLogInvariantError);
  });
});
