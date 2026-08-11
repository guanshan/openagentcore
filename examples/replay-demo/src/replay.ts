import {
  applyEventToMessageProjection,
  createMessageProjection,
  InMemoryEventLog,
  InMemorySnapshotStore,
  materializeMessageHistory,
  projectMessageHistory,
} from '@openagentcore/kernel';
import type { AgentEvent, MessageHistoryItem, MessageProjectionState } from '@openagentcore/kernel';

export interface ReplayDemoResult {
  readonly beforeInterruption: readonly MessageHistoryItem[];
  readonly afterRecovery: readonly MessageHistoryItem[];
  readonly matches: boolean;
}

export async function runReplayDemo(
  writeLine: (message: string) => void = (message) => console.log(message),
): Promise<ReplayDemoResult> {
  const identity = { tenantId: 'demo-tenant', sessionId: 'demo-session' } as const;
  const log = new InMemoryEventLog(identity);
  const snapshots = new InMemorySnapshotStore<MessageProjectionState>();
  const events = createDemoEvents();
  const head = events.slice(0, 3);

  for (const event of head) {
    await log.append(event);
  }
  let liveProjection = await projectMessageHistory(log.read(0));
  const headEvent = head.at(-1);
  if (headEvent === undefined) {
    throw new Error('Replay demo requires at least one event before the snapshot.');
  }
  await snapshots.save({ ...identity, lastSeq: headEvent.seq, state: liveProjection });

  for (const event of events.slice(3)) {
    await log.append(event);
    liveProjection = applyEventToMessageProjection(liveProjection, event);
  }
  const beforeInterruption = materializeMessageHistory(liveProjection);

  liveProjection = createMessageProjection();
  writeLine(`In-memory projection discarded: ${liveProjection.entries.length === 0}`);

  const snapshot = await snapshots.loadLatest(identity.tenantId, identity.sessionId);
  if (snapshot === undefined) {
    throw new Error('Replay demo could not load its snapshot.');
  }
  const recoveredProjection = await projectMessageHistory(
    log.read(snapshot.lastSeq + 1),
    snapshot.state,
  );
  const afterRecovery = materializeMessageHistory(recoveredProjection);
  const matches = JSON.stringify(afterRecovery) === JSON.stringify(beforeInterruption);

  writeLine(`Before interruption: ${JSON.stringify(beforeInterruption)}`);
  writeLine(`After recovery: ${JSON.stringify(afterRecovery)}`);
  writeLine(`Projection match: ${matches}`);

  if (!matches) {
    throw new Error('Recovered projection does not match the pre-interruption projection.');
  }

  return { beforeInterruption, afterRecovery, matches };
}

function createDemoEvents(): readonly AgentEvent[] {
  const common = {
    tenantId: 'demo-tenant',
    sessionId: 'demo-session',
    ts: '2026-08-11T00:00:00Z',
  } as const;

  return [
    {
      ...common,
      type: 'turn.started',
      seq: 0,
      turnId: 'turn-1',
      input: { content: 'Inspect the repository.' },
    },
    {
      ...common,
      type: 'model.delta',
      seq: 1,
      stepId: 'step-1',
      delta: { kind: 'text', text: 'Inspection started.' },
    },
    {
      ...common,
      type: 'compaction.applied',
      seq: 2,
      summary: 'The repository inspection was requested and started.',
      dropped: { fromSeq: 0, toSeq: 1 },
    },
    {
      ...common,
      type: 'model.delta',
      seq: 3,
      stepId: 'step-2',
      delta: { kind: 'text', text: 'Inspection complete.' },
    },
    {
      ...common,
      type: 'turn.finished',
      seq: 4,
      turnId: 'turn-1',
      stopReason: 'completed',
    },
  ];
}
