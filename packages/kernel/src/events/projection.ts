import type { AgentEvent, EventRange, JsonValue } from './types.js';

type NonEmptyEventRanges = readonly [EventRange, ...EventRange[]];

interface UserMessageProjectionEntry {
  readonly kind: 'message';
  readonly role: 'user';
  readonly content: string;
  readonly sourceSeq: number;
  readonly inputIndex?: number;
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
  readonly outcome?: 'succeeded' | 'failed' | 'denied';
  readonly sourceSeq: number;
}

interface SummaryProjectionEntry {
  readonly kind: 'summary';
  readonly content: string;
  readonly dropped: EventRange;
  readonly contentRanges: NonEmptyEventRanges;
  readonly compactionSeqs: readonly number[];
  readonly sourceSeq: number;
  readonly strategy?: string;
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
  readonly contentRanges: NonEmptyEventRanges;
  readonly sourceSeqs: readonly number[];
  readonly strategy?: string;
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
  return finalizeMessageProjection([]);
}

export function applyEventToMessageProjection(
  state: MessageProjectionState,
  event: AgentEvent,
): MessageProjectionState {
  validateMessageProjectionState(state);
  const entries = structuredClone(state.entries) as MessageProjectionEntry[];
  if (!applyEventToEntries(entries, event)) {
    return finalizeMessageProjection(entries);
  }
  return finalizeMessageProjection(entries);
}

export async function projectMessageHistory(
  events: Iterable<AgentEvent> | AsyncIterable<AgentEvent>,
  initialState: MessageProjectionState = createMessageProjection(),
): Promise<MessageProjectionState> {
  validateMessageProjectionState(initialState);
  const entries = structuredClone(initialState.entries) as MessageProjectionEntry[];
  for await (const event of events) {
    applyEventToEntries(entries, event);
  }
  return finalizeMessageProjection(entries);
}

function applyEventToEntries(entries: MessageProjectionEntry[], event: AgentEvent): boolean {
  switch (event.type) {
    case 'turn.started':
      entries.push({
        kind: 'message',
        role: 'user',
        content: event.input.content,
        sourceSeq: event.seq,
      });
      return true;

    case 'step.started':
      event.injectedInputs.forEach((input, inputIndex) => {
        entries.push({
          kind: 'message',
          role: 'user',
          content: input.content,
          sourceSeq: event.seq,
          inputIndex,
        });
      });
      return event.injectedInputs.length > 0;

    case 'model.delta':
      if (event.delta.kind === 'text') {
        entries.push({
          kind: 'message',
          role: 'assistant',
          stepId: event.stepId,
          content: event.delta.text,
          sourceSeq: event.seq,
        });
        return true;
      }
      return false;

    case 'tool.call':
      entries.push({
        kind: 'tool-call',
        callId: event.callId,
        tool: event.tool,
        args: structuredClone(event.args),
        sourceSeq: event.seq,
      });
      return true;

    case 'tool.result':
      entries.push({
        kind: 'tool-result',
        callId: event.callId,
        result: structuredClone(event.result),
        ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
        sourceSeq: event.seq,
      });
      return true;

    case 'compaction.applied':
      applyCompaction(entries, event.seq, event.summary, event.dropped, event.strategy);
      return true;

    case 'model.request':
    case 'step.finished':
    case 'permission.requested':
    case 'permission.resolved':
    case 'checkpoint.created':
    case 'turn.finished':
      return false;

    default:
      return rejectUnknownEvent(event);
  }
}

export function materializeMessageHistory(
  state: MessageProjectionState,
): readonly MessageHistoryItem[] {
  validateMessageProjectionState(state);
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

  return cloneAndDeepFreeze(history);
}

function applyCompaction(
  entries: MessageProjectionEntry[],
  compactionSeq: number,
  summary: string,
  dropped: EventRange,
  strategy: string | undefined,
): void {
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

  entries.forEach((entry, index) => {
    if (entry.kind !== 'summary') {
      if (containsSeq(dropped, entry.sourceSeq)) {
        droppedIndexes.add(index);
      }
      return;
    }

    const sourceIsDropped = containsSeq(dropped, entry.sourceSeq);
    const overlapsContentRange = entry.contentRanges.some((range) => rangesOverlap(dropped, range));
    const containsAllContentRanges = entry.contentRanges.every((range) =>
      containsRange(dropped, range),
    );
    if (!sourceIsDropped && !containsAllContentRanges && overlapsContentRange) {
      throw new ProjectionInvariantError(
        `Compaction range ${dropped.fromSeq}..${dropped.toSeq} partially overlaps an existing summary.`,
      );
    }

    if (sourceIsDropped || containsAllContentRanges) {
      droppedIndexes.add(index);
      removedSummaries.push(entry);
    }
  });

  assertContiguousContentCoverage(entries, droppedIndexes, dropped);

  const retained = entries.filter((_, index) => !droppedIndexes.has(index));
  const contentRanges = requireNonEmptyRanges(
    normalizeRanges([
      ...entries.flatMap((entry, index) =>
        droppedIndexes.has(index) && entry.kind !== 'summary'
          ? [{ fromSeq: entry.sourceSeq, toSeq: entry.sourceSeq }]
          : [],
      ),
      ...removedSummaries.flatMap((entry) => entry.contentRanges),
    ]),
    dropped,
  );
  const compactionSeqs = normalizeSeqs(
    removedSummaries.flatMap((entry) => [entry.sourceSeq, ...entry.compactionSeqs]),
  );

  const compacted: SummaryProjectionEntry = {
    kind: 'summary',
    content: summary,
    dropped: { ...dropped },
    contentRanges,
    compactionSeqs,
    sourceSeq: compactionSeq,
    ...(strategy === undefined ? {} : { strategy }),
  };
  validateSummaryProjectionEntry(compacted, 'new summary');
  const compactedPosition = projectionPosition(compacted);
  const nextIndex = retained.findIndex((entry) => projectionPosition(entry) > compactedPosition);
  const insertionIndex = nextIndex < 0 ? retained.length : nextIndex;

  retained.splice(insertionIndex, 0, compacted);
  entries.splice(0, entries.length, ...retained);
}

function finalizeMessageProjection(entries: MessageProjectionEntry[]): MessageProjectionState {
  validateMessageProjectionEntries(entries);
  return deepFreeze({ entries });
}

function projectionPosition(entry: MessageProjectionEntry): number {
  return entry.kind === 'summary'
    ? Math.max(...entry.contentRanges.map((range) => range.toSeq))
    : entry.sourceSeq;
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

function assertContiguousContentCoverage(
  entries: readonly MessageProjectionEntry[],
  droppedIndexes: ReadonlySet<number>,
  dropped: EventRange,
): void {
  const indexes = [...droppedIndexes].sort((left, right) => left - right);
  if (indexes.length === 0) {
    throw new ProjectionInvariantError(
      `Compaction range ${dropped.fromSeq}..${dropped.toSeq} does not cover any message content.`,
    );
  }

  const firstIndex = indexes[0];
  const lastIndex = indexes.at(-1);
  if (
    firstIndex === undefined ||
    lastIndex === undefined ||
    lastIndex - firstIndex + 1 !== indexes.length
  ) {
    throw new ProjectionInvariantError(
      `Compaction range ${dropped.fromSeq}..${dropped.toSeq} produces non-contiguous content coverage.`,
    );
  }

  for (let index = firstIndex; index <= lastIndex; index += 1) {
    if (!droppedIndexes.has(index) || entries[index] === undefined) {
      throw new ProjectionInvariantError(
        `Compaction range ${dropped.fromSeq}..${dropped.toSeq} produces non-contiguous content coverage.`,
      );
    }
  }
}

function requireNonEmptyRanges(
  ranges: readonly EventRange[],
  dropped: EventRange,
): NonEmptyEventRanges {
  if (ranges.length === 0) {
    throw new ProjectionInvariantError(
      `Compaction range ${dropped.fromSeq}..${dropped.toSeq} does not cover any message content.`,
    );
  }
  return ranges as NonEmptyEventRanges;
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
      normalized.push({ ...range });
    }
  }

  return normalized;
}

function normalizeSeqs(seqs: readonly number[]): readonly number[] {
  return [...new Set(seqs)].sort((left, right) => left - right);
}

function validateMessageProjectionState(state: MessageProjectionState): void {
  const candidate = state as unknown as { readonly entries?: unknown };
  if (typeof state !== 'object' || state === null || !Array.isArray(candidate.entries)) {
    throw new ProjectionInvariantError('Message projection state must contain an entries array.');
  }
  validateMessageProjectionEntries(candidate.entries as MessageProjectionEntry[]);
}

function validateMessageProjectionEntries(entries: readonly MessageProjectionEntry[]): void {
  let previousPosition = -1;
  const sourceKinds = new Map<number, 'event' | 'injected-input'>();
  const sourceKeys = new Set<string>();

  for (let index = 0; index < entries.length; index += 1) {
    if (!Object.hasOwn(entries, index)) {
      throw new ProjectionInvariantError(
        `Projection entries must not contain an empty slot at index ${index}.`,
      );
    }
  }

  entries.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ProjectionInvariantError(`Projection entry at index ${index} must be an object.`);
    }
    if (!Number.isInteger(entry.sourceSeq) || entry.sourceSeq < 0) {
      throw new ProjectionInvariantError(
        `Projection entry at index ${index} must have a non-negative integer sourceSeq.`,
      );
    }
    const isInjectedInput =
      entry.kind === 'message' && entry.role === 'user' && entry.inputIndex !== undefined;
    if (isInjectedInput && (!Number.isInteger(entry.inputIndex) || entry.inputIndex < 0)) {
      throw new ProjectionInvariantError(
        `Injected input projection entry at index ${index} must have a non-negative integer inputIndex.`,
      );
    }
    const sourceKind = isInjectedInput ? 'injected-input' : 'event';
    const previousSourceKind = sourceKinds.get(entry.sourceSeq);
    if (
      previousSourceKind !== undefined &&
      (sourceKind === 'event' || previousSourceKind === 'event')
    ) {
      throw new ProjectionInvariantError(
        `Projection entries must have unique event sourceSeq values; received ${entry.sourceSeq} twice.`,
      );
    }
    sourceKinds.set(entry.sourceSeq, sourceKind);
    const sourceKey = isInjectedInput
      ? `${entry.sourceSeq}:input:${entry.inputIndex}`
      : `${entry.sourceSeq}:event`;
    if (sourceKeys.has(sourceKey)) {
      throw new ProjectionInvariantError(
        `Projection entries contain duplicate source ${sourceKey}.`,
      );
    }
    sourceKeys.add(sourceKey);

    switch (entry.kind) {
      case 'message':
        if (
          typeof entry.content !== 'string' ||
          (entry.role !== 'user' && entry.role !== 'assistant') ||
          (entry.role === 'assistant' &&
            (typeof entry.stepId !== 'string' || entry.stepId.length === 0))
        ) {
          throw new ProjectionInvariantError(
            `Message projection entry at index ${index} is malformed.`,
          );
        }
        break;
      case 'tool-call':
        if (
          typeof entry.callId !== 'string' ||
          entry.callId.length === 0 ||
          typeof entry.tool !== 'string' ||
          entry.tool.length === 0 ||
          !isJsonValue(entry.args)
        ) {
          throw new ProjectionInvariantError(
            `Tool-call projection entry at index ${index} is malformed.`,
          );
        }
        break;
      case 'tool-result':
        if (
          typeof entry.callId !== 'string' ||
          entry.callId.length === 0 ||
          !isJsonValue(entry.result) ||
          (entry.outcome !== undefined &&
            entry.outcome !== 'succeeded' &&
            entry.outcome !== 'failed' &&
            entry.outcome !== 'denied')
        ) {
          throw new ProjectionInvariantError(
            `Tool-result projection entry at index ${index} is malformed.`,
          );
        }
        break;
      case 'summary':
        validateSummaryProjectionEntry(entry, `projection entry at index ${index}`);
        break;
      default:
        throw new ProjectionInvariantError(
          `Unknown projection entry kind ${JSON.stringify((entry as { kind?: unknown }).kind)} at index ${index}.`,
        );
    }

    const position = projectionPosition(entry);
    if (position < previousPosition) {
      throw new ProjectionInvariantError('Projection entries must be ordered by content position.');
    }
    previousPosition = position;
  });

  entries.forEach((entry, index) => {
    if (entry.kind !== 'summary') {
      return;
    }
    const firstRange = entry.contentRanges[0];
    const lastRange = entry.contentRanges.at(-1);
    if (lastRange === undefined) {
      throw new ProjectionInvariantError(
        `Summary projection entry at index ${index} must have non-empty contentRanges.`,
      );
    }
    const contentSpan = { fromSeq: firstRange.fromSeq, toSeq: lastRange.toSeq };

    entries.forEach((candidate, candidateIndex) => {
      if (candidateIndex === index) {
        return;
      }
      const candidateRanges =
        candidate.kind === 'summary'
          ? candidate.contentRanges
          : [{ fromSeq: candidate.sourceSeq, toSeq: candidate.sourceSeq }];
      if (candidateRanges.some((range) => rangesOverlap(contentSpan, range))) {
        throw new ProjectionInvariantError(
          `Summary projection entry at index ${index} has non-contiguous content coverage.`,
        );
      }
    });
  });
}

function validateSummaryProjectionEntry(entry: SummaryProjectionEntry, label: string): void {
  if (typeof entry.content !== 'string') {
    throw new ProjectionInvariantError(`${label} must have string content.`);
  }
  if (entry.strategy !== undefined && entry.strategy.length === 0) {
    throw new ProjectionInvariantError(`${label} must have a non-empty strategy when provided.`);
  }
  if (!isValidEventRange(entry.dropped) || entry.dropped.toSeq >= entry.sourceSeq) {
    throw new ProjectionInvariantError(`${label} has an invalid dropped range.`);
  }

  const candidate = entry as SummaryProjectionEntry & {
    readonly contentRanges?: unknown;
    readonly compactionSeqs?: unknown;
  };
  if (!Array.isArray(candidate.contentRanges) || candidate.contentRanges.length === 0) {
    throw new ProjectionInvariantError(`${label} must have non-empty contentRanges.`);
  }

  let previousRange: EventRange | undefined;
  for (const range of candidate.contentRanges) {
    if (!isValidEventRange(range) || range.toSeq >= entry.sourceSeq) {
      throw new ProjectionInvariantError(`${label} has an invalid content range.`);
    }
    if (previousRange !== undefined && range.fromSeq <= previousRange.toSeq + 1) {
      throw new ProjectionInvariantError(`${label} contentRanges must be sorted and normalized.`);
    }
    previousRange = range;
  }

  if (!Array.isArray(candidate.compactionSeqs)) {
    throw new ProjectionInvariantError(`${label} must have a compactionSeqs array.`);
  }
  let previousCompactionSeq = -1;
  for (const seq of candidate.compactionSeqs) {
    if (
      !Number.isInteger(seq) ||
      seq < 0 ||
      seq >= entry.sourceSeq ||
      seq <= previousCompactionSeq ||
      candidate.contentRanges.some((range) => containsSeq(range, seq))
    ) {
      throw new ProjectionInvariantError(
        `${label} compactionSeqs must be ordered, unique, and separate from contentRanges.`,
      );
    }
    previousCompactionSeq = seq;
  }
}

function isValidEventRange(value: unknown): value is EventRange {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const range = value as { readonly fromSeq?: unknown; readonly toSeq?: unknown };
  return (
    Number.isInteger(range.fromSeq) &&
    Number.isInteger(range.toSeq) &&
    (range.fromSeq as number) >= 0 &&
    (range.fromSeq as number) <= (range.toSeq as number)
  );
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  ancestors.add(value);
  const valid = Object.values(value).every((nested) => isJsonValue(nested, ancestors));
  ancestors.delete(value);
  return valid;
}

function cloneAndDeepFreeze<TValue>(value: TValue): TValue {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
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
        contentRanges: entry.contentRanges,
        sourceSeqs: [entry.sourceSeq],
        ...(entry.strategy === undefined ? {} : { strategy: entry.strategy }),
      };
  }
}

function rejectUnknownEvent(event: never): never {
  const unknownEvent = event as { readonly type?: unknown; readonly seq?: unknown };
  throw new ProjectionInvariantError(
    `Unknown event type ${JSON.stringify(unknownEvent.type)} at seq ${String(unknownEvent.seq)}.`,
  );
}
