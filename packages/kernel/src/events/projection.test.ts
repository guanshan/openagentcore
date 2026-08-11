import { describe, expect, it } from 'vitest';

import { InMemoryEventLog } from './event-log.js';
import {
  applyEventToMessageProjection,
  createMessageProjection,
  materializeMessageHistory,
  projectMessageHistory,
  ProjectionInvariantError,
} from './projection.js';
import { assertSchemaValidEvent } from './schema.test-support.js';
import { InMemorySnapshotStore } from './snapshot-store.js';
import type {
  AgentEvent,
  CompactionAppliedEvent,
  ModelDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  TurnFinishedEvent,
  TurnStartedEvent,
} from './types.js';

const identity = {
  tenantId: 'tenant-test',
  sessionId: 'session-test',
} as const;

const timestamp = '2026-08-11T00:00:00Z';

function turnStarted(seq: number, content = 'Inspect the repository.'): TurnStartedEvent {
  return assertSchemaValidEvent({
    type: 'turn.started',
    seq,
    ...identity,
    ts: timestamp,
    turnId: 'turn-1',
    input: { content },
  });
}

function modelDelta(seq: number, text: string, stepId = 'step-1'): ModelDeltaEvent {
  return assertSchemaValidEvent({
    type: 'model.delta',
    seq,
    ...identity,
    ts: timestamp,
    stepId,
    delta: { kind: 'text', text },
  });
}

function toolCall(seq: number): ToolCallEvent {
  return assertSchemaValidEvent({
    type: 'tool.call',
    seq,
    ...identity,
    ts: timestamp,
    callId: 'call-1',
    tool: 'read_file',
    args: { path: 'README.md' },
  });
}

function toolResult(seq: number): ToolResultEvent {
  return assertSchemaValidEvent({
    type: 'tool.result',
    seq,
    ...identity,
    ts: timestamp,
    callId: 'call-1',
    result: { content: '# OpenAgentCore' },
  });
}

function compaction(
  seq: number,
  fromSeq: number,
  toSeq: number,
  summary: string,
): CompactionAppliedEvent {
  return assertSchemaValidEvent({
    type: 'compaction.applied',
    seq,
    ...identity,
    ts: timestamp,
    summary,
    dropped: { fromSeq, toSeq },
  });
}

function turnFinished(seq: number): TurnFinishedEvent {
  return assertSchemaValidEvent({
    type: 'turn.finished',
    seq,
    ...identity,
    ts: timestamp,
    turnId: 'turn-1',
    stopReason: 'completed',
  });
}

describe('message history projection', () => {
  it('rebuilds an empty event stream', async () => {
    const projection = await projectMessageHistory([]);

    expect(projection).toEqual(createMessageProjection());
    expect(materializeMessageHistory(projection)).toEqual([]);
  });

  it('projects user, assistant, tool call, and tool result history', async () => {
    const projection = await projectMessageHistory([
      turnStarted(0),
      modelDelta(1, 'Reading '),
      modelDelta(2, 'now.'),
      toolCall(3),
      toolResult(4),
    ]);

    expect(materializeMessageHistory(projection)).toEqual([
      {
        kind: 'message',
        role: 'user',
        content: 'Inspect the repository.',
        sourceSeqs: [0],
      },
      {
        kind: 'message',
        role: 'assistant',
        stepId: 'step-1',
        content: 'Reading now.',
        sourceSeqs: [1, 2],
      },
      {
        kind: 'tool-call',
        callId: 'call-1',
        tool: 'read_file',
        args: { path: 'README.md' },
        sourceSeqs: [3],
      },
      {
        kind: 'tool-result',
        callId: 'call-1',
        result: { content: '# OpenAgentCore' },
        sourceSeqs: [4],
      },
    ]);
  });

  it('folds an inclusive range without deleting unrelated delta fragments', async () => {
    const projection = await projectMessageHistory([
      turnStarted(0),
      modelDelta(1, 'A'),
      modelDelta(2, 'B'),
      modelDelta(3, 'C'),
      compaction(4, 2, 2, 'B was compacted.'),
    ]);

    expect(materializeMessageHistory(projection)).toEqual([
      {
        kind: 'message',
        role: 'user',
        content: 'Inspect the repository.',
        sourceSeqs: [0],
      },
      {
        kind: 'message',
        role: 'assistant',
        stepId: 'step-1',
        content: 'A',
        sourceSeqs: [1],
      },
      {
        kind: 'summary',
        content: 'B was compacted.',
        dropped: { fromSeq: 2, toSeq: 2 },
        representedRanges: [{ fromSeq: 2, toSeq: 2 }],
        sourceSeqs: [4],
      },
      {
        kind: 'message',
        role: 'assistant',
        stepId: 'step-1',
        content: 'C',
        sourceSeqs: [3],
      },
    ]);
  });

  it('allows a later compaction to replace an earlier summary by source seq', async () => {
    const projection = await projectMessageHistory([
      turnStarted(0),
      modelDelta(1, 'First response.'),
      compaction(2, 0, 1, 'First summary.'),
      compaction(3, 2, 2, 'Replacement summary.'),
    ]);

    expect(materializeMessageHistory(projection)).toEqual([
      {
        kind: 'summary',
        content: 'Replacement summary.',
        dropped: { fromSeq: 2, toSeq: 2 },
        representedRanges: [{ fromSeq: 0, toSeq: 2 }],
        sourceSeqs: [3],
      },
    ]);
  });

  it('positions a folded summary after the maximum sequence it represents', async () => {
    const projection = await projectMessageHistory([
      modelDelta(0, 'A'),
      modelDelta(1, 'B'),
      modelDelta(2, 'C'),
      modelDelta(3, 'D'),
      modelDelta(4, 'E'),
      compaction(5, 0, 1, 'AB was compacted.'),
      modelDelta(6, 'F'),
      compaction(7, 5, 6, 'Earlier summary and F were compacted.'),
    ]);

    expect(materializeMessageHistory(projection)).toEqual([
      {
        kind: 'message',
        role: 'assistant',
        stepId: 'step-1',
        content: 'CDE',
        sourceSeqs: [2, 3, 4],
      },
      {
        kind: 'summary',
        content: 'Earlier summary and F were compacted.',
        dropped: { fromSeq: 5, toSeq: 6 },
        representedRanges: [
          { fromSeq: 0, toSeq: 1 },
          { fromSeq: 5, toSeq: 6 },
        ],
        sourceSeqs: [7],
      },
    ]);
  });

  it('preserves every represented range when materializing a folded summary', async () => {
    const projection = await projectMessageHistory([
      turnStarted(0),
      modelDelta(1, 'A'),
      compaction(2, 0, 1, 'First summary.'),
      compaction(3, 2, 2, 'Second summary.'),
    ]);

    expect(materializeMessageHistory(projection)).toEqual([
      {
        kind: 'summary',
        content: 'Second summary.',
        dropped: { fromSeq: 2, toSeq: 2 },
        representedRanges: [{ fromSeq: 0, toSeq: 2 }],
        sourceSeqs: [3],
      },
    ]);
  });

  it('replaces an existing summary when the same raw range is compacted again', async () => {
    const projection = await projectMessageHistory([
      turnStarted(0),
      compaction(1, 0, 0, 'First summary.'),
      compaction(2, 0, 0, 'Replacement summary.'),
    ]);

    expect(materializeMessageHistory(projection)).toEqual([
      {
        kind: 'summary',
        content: 'Replacement summary.',
        dropped: { fromSeq: 0, toSeq: 0 },
        representedRanges: [{ fromSeq: 0, toSeq: 0 }],
        sourceSeqs: [2],
      },
    ]);
  });

  it('rejects a compaction that partially overlaps an existing summary', async () => {
    const summarized = await projectMessageHistory([
      turnStarted(0),
      modelDelta(1, 'A'),
      modelDelta(2, 'B'),
      compaction(3, 0, 2, 'Full summary.'),
    ]);

    expect(() =>
      applyEventToMessageProjection(summarized, compaction(4, 0, 1, 'Partial summary.')),
    ).toThrow(ProjectionInvariantError);
  });

  it('rejects a compaction range that is reversed or references the future', () => {
    const initial = createMessageProjection();

    expect(() => applyEventToMessageProjection(initial, compaction(4, 3, 2, 'bad'))).toThrow(
      ProjectionInvariantError,
    );
    expect(() => applyEventToMessageProjection(initial, compaction(4, 1, 4, 'bad'))).toThrow(
      ProjectionInvariantError,
    );
  });

  it('rejects an unknown runtime event with its type and sequence', () => {
    const unknownEvent = {
      type: 'model.future-delta',
      seq: 42,
      ...identity,
      ts: timestamp,
    } as unknown as AgentEvent;

    expect(() => applyEventToMessageProjection(createMessageProjection(), unknownEvent)).toThrow(
      new ProjectionInvariantError('Unknown event type "model.future-delta" at seq 42.'),
    );
  });
});

describe('projection recovery', () => {
  it('produces the same state from full replay and snapshot plus tail replay', async () => {
    const log = new InMemoryEventLog(identity);
    const snapshots = new InMemorySnapshotStore<ReturnType<typeof createMessageProjection>>();
    const prefix: AgentEvent[] = [
      turnStarted(0),
      modelDelta(1, 'Reading.'),
      compaction(2, 0, 1, 'Inspection requested.'),
    ];
    const tail: AgentEvent[] = [modelDelta(3, 'Done.', 'step-2'), toolCall(4), turnFinished(5)];

    for (const event of prefix) {
      await log.append(event);
    }
    let liveState = await projectMessageHistory(log.read(0));
    await snapshots.save({ ...identity, lastSeq: 2, state: liveState });

    for (const event of tail) {
      await log.append(event);
      liveState = applyEventToMessageProjection(liveState, event);
    }

    liveState = createMessageProjection();
    expect(liveState).toEqual({ entries: [] });

    const fromFullReplay = await projectMessageHistory(log.read(0));
    const snapshot = await snapshots.loadLatest(identity.tenantId, identity.sessionId);
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) {
      throw new Error('Expected a stored snapshot.');
    }
    const fromSnapshotAndTail = await projectMessageHistory(
      log.read(snapshot.lastSeq + 1),
      snapshot.state,
    );

    expect(fromSnapshotAndTail).toEqual(fromFullReplay);
    expect(materializeMessageHistory(fromSnapshotAndTail)).toEqual(
      materializeMessageHistory(fromFullReplay),
    );
    await expect(collect(log.read(0))).resolves.toHaveLength(prefix.length + tail.length);
  });

  it('restores from a snapshot when there are no tail events', async () => {
    const log = new InMemoryEventLog(identity);
    const snapshots = new InMemorySnapshotStore<ReturnType<typeof createMessageProjection>>();
    const events: AgentEvent[] = [turnStarted(0), modelDelta(1, 'Complete.')];
    for (const event of events) {
      await log.append(event);
    }
    const projected = await projectMessageHistory(log.read(0));
    const stored = await snapshots.save({ ...identity, lastSeq: 1, state: projected });
    const loaded = await snapshots.load(stored.snapshotRef);
    expect(loaded).toBeDefined();
    if (loaded === undefined) {
      throw new Error('Expected a stored snapshot.');
    }

    const restored = await projectMessageHistory(log.read(loaded.lastSeq + 1), loaded.state);

    expect(restored).toEqual(projected);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}
