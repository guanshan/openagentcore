import {
  EventLogConflictError,
  EventLogInvariantError,
  type AgentEvent,
  type EventStreamIdentity,
  type StoreCapabilities,
  type StorePort,
  type TurnStartedEvent,
} from '@openagentcore/kernel';

import type {
  ConformanceCaseResult,
  ConformanceSuiteResult,
  StoreConformanceAdapter,
} from './types.js';

export async function runStoreConformance(
  adapter: StoreConformanceAdapter,
): Promise<ConformanceSuiteResult> {
  let first: StorePort | undefined;
  let second: StorePort | undefined;
  try {
    const availability = await adapter.availability?.();
    if (availability !== undefined && !availability.available) {
      return skipped(adapter.name, availability.reason);
    }
    first = await adapter.create();
    second = await adapter.create();
    const capabilities = first.capabilities;
    const identity = conformanceIdentity(adapter.name);
    const firstLog = first.eventLog.open(identity);
    const secondLog = second.eventLog.open(identity);
    const cases: ConformanceCaseResult[] = [];

    await runCase(cases, 'capability declaration is structurally valid', async () => {
      validateCapabilities(capabilities);
      if (JSON.stringify(capabilities) !== JSON.stringify(second?.capabilities)) {
        throw new Error('two instances declared different capabilities');
      }
    });
    await runCase(cases, 'byte KV round-trips without aliasing', async () => {
      const input = new Uint8Array([0, 1, 2, 255]);
      await first?.kv.set('conformance-cursor', input);
      input[0] = 99;
      const output = await second?.kv.get('conformance-cursor');
      if (output === undefined || !bytesEqual(output, new Uint8Array([0, 1, 2, 255]))) {
        throw new Error('KV bytes changed or were not shared');
      }
      output[1] = 99;
      const repeated = await first?.kv.get('conformance-cursor');
      if (repeated === undefined || !bytesEqual(repeated, new Uint8Array([0, 1, 2, 255]))) {
        throw new Error('KV returned an aliased value');
      }
      await first?.kv.delete('conformance-cursor');
    });
    await runCase(cases, 'atomic CAS admits exactly one stale multi-writer append', async () => {
      const event = turnStarted(identity, 0);
      const outcomes = await Promise.allSettled([
        firstLog.append(event, -1),
        secondLog.append(event, -1),
      ]);
      if (outcomes.filter((outcome) => outcome.status === 'fulfilled').length !== 1) {
        throw new Error(`expected one successful writer, received ${JSON.stringify(outcomes)}`);
      }
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
      if (rejected.length !== 1 || !(rejected[0]?.reason instanceof EventLogConflictError)) {
        throw new Error('losing writer did not receive EventLogConflictError');
      }
      const persisted = await collect(firstLog.read(0));
      if (persisted.length !== 1 || persisted[0]?.seq !== 0) {
        throw new Error(`winning stream has holes or duplicates: ${JSON.stringify(persisted)}`);
      }
    });
    await runCase(cases, 'inclusive reads are finite repeatable snapshots', async () => {
      await firstLog.append(turnStarted(identity, 1), 0);
      const snapshot = secondLog.read(1);
      await firstLog.append(turnStarted(identity, 2), 1);
      const expected = [turnStarted(identity, 1)];
      const firstRead = await collect(snapshot);
      const secondRead = await collect(snapshot);
      if (JSON.stringify(firstRead) !== JSON.stringify(expected)) {
        throw new Error(`snapshot was not bounded at call time: ${JSON.stringify(firstRead)}`);
      }
      if (JSON.stringify(secondRead) !== JSON.stringify(expected)) {
        throw new Error(`snapshot changed across iteration: ${JSON.stringify(secondRead)}`);
      }
    });
    await runCase(
      cases,
      'conflicts neither append nor notify process-local subscribers',
      async () => {
        let notifications = 0;
        firstLog.subscribe(() => {
          notifications += 1;
        });
        await expectConflict(firstLog.append(turnStarted(identity, 3), 1));
        if (notifications !== 0) throw new Error('conflicting append notified a subscriber');
        const events = await collect(firstLog.read(0));
        if (events.map((event) => event.seq).join(',') !== '0,1,2') {
          throw new Error(`conflict mutated the stream: ${JSON.stringify(events)}`);
        }
      },
    );
    await runCase(cases, 'declared sequence and read consistency are honest', async () => {
      if (capabilities.sequence === 'contiguous') {
        try {
          await firstLog.append(turnStarted(identity, 4), 2);
        } catch (error) {
          if (error instanceof EventLogInvariantError) return;
          throw error;
        }
        throw new Error('adapter accepted a gap while declaring contiguous sequence semantics');
      }
      const snapshot = firstLog.read(0);
      const before = await collect(snapshot);
      if (capabilities.readConsistency === 'strong-primary' && before.at(-1)?.seq !== 2) {
        throw new Error('strong-primary read did not observe the acknowledged append');
      }
    });

    return Object.freeze({
      port: 'store',
      adapter: adapter.name,
      status: cases.some((entry) => entry.status === 'failed') ? 'failed' : 'passed',
      capabilities: Object.freeze({ ...capabilities }),
      detail: summarizeCases(cases),
      cases: Object.freeze(cases),
    });
  } catch (error) {
    return Object.freeze({
      port: 'store',
      adapter: adapter.name,
      status: 'failed',
      capabilities: Object.freeze({ ...(first?.capabilities ?? {}) }),
      detail: `suite setup failed: ${stableError(error)}`,
      cases: Object.freeze([]),
    });
  } finally {
    await Promise.allSettled([first?.close?.(), second?.close?.()]);
    await adapter.dispose?.();
  }
}

function validateCapabilities(capabilities: StoreCapabilities): void {
  if (capabilities.atomicCas !== true) throw new Error('atomicCas must be true');
  if (!['contiguous', 'strictly-increasing'].includes(capabilities.sequence)) {
    throw new Error(`invalid sequence capability ${String(capabilities.sequence)}`);
  }
  if (!['strong-primary', 'eventual'].includes(capabilities.readConsistency)) {
    throw new Error(`invalid readConsistency ${String(capabilities.readConsistency)}`);
  }
  if (!['committed', 'deployment-configured', 'volatile'].includes(capabilities.durability)) {
    throw new Error(`invalid durability ${String(capabilities.durability)}`);
  }
}

function skipped(adapter: string, reason: string): ConformanceSuiteResult {
  return Object.freeze({
    port: 'store',
    adapter,
    status: 'skipped',
    capabilities: Object.freeze({}),
    detail: reason,
    cases: Object.freeze([]),
  });
}

async function runCase(
  cases: ConformanceCaseResult[],
  name: string,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
    cases.push({ name, status: 'passed', detail: 'ok' });
  } catch (error) {
    cases.push({ name, status: 'failed', detail: stableError(error) });
  }
}

async function expectConflict(operation: Promise<void>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof EventLogConflictError) return;
    throw error;
  }
  throw new Error('stale append unexpectedly succeeded');
}

function conformanceIdentity(adapter: string): EventStreamIdentity {
  return {
    tenantId: 'conformance',
    sessionId: `store-${adapter.replace(/[^A-Za-z0-9]/g, '-')}-${Date.now()}`,
  };
}

function turnStarted(identity: EventStreamIdentity, seq: number): TurnStartedEvent {
  return {
    type: 'turn.started',
    ...identity,
    seq,
    ts: '2026-08-12T00:00:00Z',
    turnId: 'turn-store-conformance',
    input: { content: 'store conformance' },
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<readonly AgentEvent[]> {
  const values: AgentEvent[] = [];
  for await (const event of events) values.push(event);
  return values;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function summarizeCases(cases: readonly ConformanceCaseResult[]): string {
  const failed = cases.filter((entry) => entry.status === 'failed').length;
  return failed === 0
    ? `${cases.length} cases passed.`
    : `${failed} of ${cases.length} cases failed.`;
}

function stableError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
