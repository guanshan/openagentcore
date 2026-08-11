import type { AgentEvent, EventRange, JsonValue } from './types.js';

interface UserMessageProjectionEntry {
  readonly kind: 'message';
  readonly role: 'user';
  readonly content: string;
  readonly sourceSeq: number;
}

interface AssistantMessageProjectionEntry {
  readonly kind: 'message';
  readonly role: 'assistant';
  readonly stepId: string;
  readonly content: string;
  readonly sourceSeq: number;
}

interface ToolCallProjectionEntry {
  readonly kind: 'tool-call';
  readonly callId: string;
  readonly tool: string;
  readonly args: JsonValue;
  readonly sourceSeq: number;
}

interface ToolResultProjectionEntry {
  readonly kind: 'tool-result';
  readonly callId: string;
  readonly result: JsonValue;
  readonly sourceSeq: number;
}

interface SummaryProjectionEntry {
  readonly kind: 'summary';
  readonly content: string;
  readonly dropped: EventRange;
  readonly representedRanges: readonly EventRange[];
  readonly positionSeq: number;
  readonly sourceSeq: number;
}

export type MessageProjectionEntry =
  | UserMessageProjectionEntry
  | AssistantMessageProjectionEntry
  | ToolCallProjectionEntry
  | ToolResultProjectionEntry
  | SummaryProjectionEntry;

export interface MessageProjectionState {
  readonly entries: readonly MessageProjectionEntry[];
}

interface UserMessageHistoryItem {
  readonly kind: 'message';
  readonly role: 'user';
  readonly content: string;
  readonly sourceSeqs: readonly number[];
}

interface AssistantMessageHistoryItem {
  readonly kind: 'message';
  readonly role: 'assistant';
  readonly stepId: string;
  readonly content: string;
  readonly sourceSeqs: readonly number[];
}

interface ToolCallHistoryItem {
  readonly kind: 'tool-call';
  readonly callId: string;
  readonly tool: string;
  readonly args: JsonValue;
  readonly sourceSeqs: readonly number[];
}

interface ToolResultHistoryItem {
  readonly kind: 'tool-result';
  readonly callId: string;
  readonly result: JsonValue;
  readonly sourceSeqs: readonly number[];
}

interface SummaryHistoryItem {
  readonly kind: 'summary';
  readonly content: string;
  readonly dropped: EventRange;
  readonly sourceSeqs: readonly number[];
}

export type MessageHistoryItem =
  | UserMessageHistoryItem
  | AssistantMessageHistoryItem
  | ToolCallHistoryItem
  | ToolResultHistoryItem
  | SummaryHistoryItem;

export class ProjectionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectionInvariantError';
  }
}

export function createMessageProjection(): MessageProjectionState {
  return { entries: [] };
}

export function applyEventToMessageProjection(
  state: MessageProjectionState,
  event: AgentEvent,
): MessageProjectionState {
  switch (event.type) {
    case 'turn.started':
      return appendEntry(state, {
        kind: 'message',
        role: 'user',
        content: event.input.content,
        sourceSeq: event.seq,
      });

    case 'model.delta':
      if (event.delta.kind === 'text') {
        return appendEntry(state, {
          kind: 'message',
          role: 'assistant',
          stepId: event.stepId,
          content: event.delta.text,
          sourceSeq: event.seq,
        });
      }
      return state;

    case 'tool.call':
      return appendEntry(state, {
        kind: 'tool-call',
        callId: event.callId,
        tool: event.tool,
        args: event.args,
        sourceSeq: event.seq,
      });

    case 'tool.result':
      return appendEntry(state, {
        kind: 'tool-result',
        callId: event.callId,
        result: event.result,
        sourceSeq: event.seq,
      });

    case 'compaction.applied':
      return applyCompaction(state, event.seq, event.summary, event.dropped);

    case 'model.request':
    case 'permission.requested':
    case 'permission.resolved':
    case 'checkpoint.created':
    case 'turn.finished':
      return state;
  }
}

export async function projectMessageHistory(
  events: Iterable<AgentEvent> | AsyncIterable<AgentEvent>,
  initialState: MessageProjectionState = createMessageProjection(),
): Promise<MessageProjectionState> {
  let state = initialState;
  for await (const event of events) {
    state = applyEventToMessageProjection(state, event);
  }
  return state;
}

export function materializeMessageHistory(
  state: MessageProjectionState,
): readonly MessageHistoryItem[] {
  const history: MessageHistoryItem[] = [];

  for (const entry of state.entries) {
    const previous = history.at(-1);
    if (
      entry.kind === 'message' &&
      entry.role === 'assistant' &&
      previous?.kind === 'message' &&
      previous.role === 'assistant' &&
      previous.stepId === entry.stepId
    ) {
      history[history.length - 1] = {
        ...previous,
        content: previous.content + entry.content,
        sourceSeqs: [...previous.sourceSeqs, entry.sourceSeq],
      };
      continue;
    }

    history.push(materializeEntry(entry));
  }

  return history;
}

function appendEntry(
  state: MessageProjectionState,
  entry: MessageProjectionEntry,
): MessageProjectionState {
  return { entries: [...state.entries, entry] };
}

function applyCompaction(
  state: MessageProjectionState,
  compactionSeq: number,
  summary: string,
  dropped: EventRange,
): MessageProjectionState {
  if (
    !Number.isInteger(dropped.fromSeq) ||
    !Number.isInteger(dropped.toSeq) ||
    dropped.fromSeq < 0 ||
    dropped.fromSeq > dropped.toSeq ||
    dropped.toSeq >= compactionSeq
  ) {
    throw new ProjectionInvariantError(
      `Compaction range must satisfy 0 <= fromSeq <= toSeq < event seq; received ${dropped.fromSeq}..${dropped.toSeq} at ${compactionSeq}.`,
    );
  }

  const removedSummaries: SummaryProjectionEntry[] = [];
  const droppedIndexes = new Set<number>();

  state.entries.forEach((entry, index) => {
    if (entry.kind !== 'summary') {
      if (containsSeq(dropped, entry.sourceSeq)) {
        droppedIndexes.add(index);
      }
      return;
    }

    const sourceIsDropped = containsSeq(dropped, entry.sourceSeq);
    const overlapsRepresentedRange = entry.representedRanges.some((range) =>
      rangesOverlap(dropped, range),
    );
    const containsAllRepresentedRanges = entry.representedRanges.every((range) =>
      containsRange(dropped, range),
    );

    if (overlapsRepresentedRange && !containsAllRepresentedRanges && !sourceIsDropped) {
      throw new ProjectionInvariantError(
        `Compaction range ${dropped.fromSeq}..${dropped.toSeq} partially overlaps an existing summary.`,
      );
    }

    if (sourceIsDropped || containsAllRepresentedRanges) {
      droppedIndexes.add(index);
      removedSummaries.push(entry);
    }
  });

  const firstDroppedIndex = state.entries.findIndex((_, index) => droppedIndexes.has(index));
  const retained = state.entries.filter((_, index) => !droppedIndexes.has(index));

  let insertionIndex: number;
  if (firstDroppedIndex >= 0) {
    insertionIndex = state.entries
      .slice(0, firstDroppedIndex)
      .filter((_, index) => !droppedIndexes.has(index)).length;
  } else {
    const nextIndex = retained.findIndex((entry) => projectionPosition(entry) > dropped.toSeq);
    insertionIndex = nextIndex < 0 ? retained.length : nextIndex;
  }

  const compacted: SummaryProjectionEntry = {
    kind: 'summary',
    content: summary,
    dropped,
    representedRanges: normalizeRanges([
      dropped,
      ...removedSummaries.flatMap((entry) => entry.representedRanges),
    ]),
    positionSeq: Math.min(dropped.fromSeq, ...removedSummaries.map((entry) => entry.positionSeq)),
    sourceSeq: compactionSeq,
  };

  return {
    entries: [...retained.slice(0, insertionIndex), compacted, ...retained.slice(insertionIndex)],
  };
}

function projectionPosition(entry: MessageProjectionEntry): number {
  return entry.kind === 'summary' ? entry.positionSeq : entry.sourceSeq;
}

function containsSeq(range: EventRange, seq: number): boolean {
  return seq >= range.fromSeq && seq <= range.toSeq;
}

function containsRange(container: EventRange, candidate: EventRange): boolean {
  return container.fromSeq <= candidate.fromSeq && container.toSeq >= candidate.toSeq;
}

function rangesOverlap(left: EventRange, right: EventRange): boolean {
  return left.fromSeq <= right.toSeq && right.fromSeq <= left.toSeq;
}

function normalizeRanges(ranges: readonly EventRange[]): readonly EventRange[] {
  const sorted = [...ranges].sort((left, right) => left.fromSeq - right.fromSeq);
  const normalized: EventRange[] = [];

  for (const range of sorted) {
    const previous = normalized.at(-1);
    if (previous !== undefined && range.fromSeq <= previous.toSeq + 1) {
      normalized[normalized.length - 1] = {
        fromSeq: previous.fromSeq,
        toSeq: Math.max(previous.toSeq, range.toSeq),
      };
    } else {
      normalized.push(range);
    }
  }

  return normalized;
}

function materializeEntry(entry: MessageProjectionEntry): MessageHistoryItem {
  switch (entry.kind) {
    case 'message':
      return entry.role === 'user'
        ? {
            kind: 'message',
            role: 'user',
            content: entry.content,
            sourceSeqs: [entry.sourceSeq],
          }
        : {
            kind: 'message',
            role: 'assistant',
            stepId: entry.stepId,
            content: entry.content,
            sourceSeqs: [entry.sourceSeq],
          };
    case 'tool-call':
      return {
        kind: 'tool-call',
        callId: entry.callId,
        tool: entry.tool,
        args: entry.args,
        sourceSeqs: [entry.sourceSeq],
      };
    case 'tool-result':
      return {
        kind: 'tool-result',
        callId: entry.callId,
        result: entry.result,
        sourceSeqs: [entry.sourceSeq],
      };
    case 'summary':
      return {
        kind: 'summary',
        content: entry.content,
        dropped: entry.dropped,
        sourceSeqs: [entry.sourceSeq],
      };
  }
}
