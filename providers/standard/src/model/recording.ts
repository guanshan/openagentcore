import {
  MODEL_PORT_ERROR_KINDS,
  ModelPortError,
  type JsonObject,
  type JsonValue,
  type ModelCapabilities,
  type ModelChunk,
  type ModelPort,
  type ModelPortErrorKind,
  type ModelRequest,
} from '@openagentcore/kernel';

import { MAX_TIMER_DELAY_MS } from './limits.js';
import {
  authorizationCredential,
  MODEL_SENSITIVE_KEYS,
  MODEL_SENSITIVE_REDACTION,
  redactSensitiveText,
} from './sensitive.js';

export const MODEL_RECORDING_SPEC_VERSION = '0.4.0' as const;
export const MODEL_RECORDING_KIND = 'model-port-recording' as const;
export const MODEL_RECORDING_REDACTION = MODEL_SENSITIVE_REDACTION;

export const MODEL_RECORDING_SENSITIVE_KEYS = MODEL_SENSITIVE_KEYS;

export interface ModelRecordingRedaction {
  readonly replacement: typeof MODEL_RECORDING_REDACTION;
  readonly sensitiveKeys: readonly string[];
  readonly pointers: readonly string[];
}

export interface RecordedGenericError {
  readonly type: 'generic';
  readonly name: string;
  readonly message: string;
}

export interface RecordedModelPortError {
  readonly type: 'model-port';
  readonly name: 'ModelPortError';
  readonly message: string;
  readonly kind: ModelPortErrorKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly providerCode?: string;
  readonly details?: JsonObject;
}

export type RecordedModelError = RecordedGenericError | RecordedModelPortError;

export interface ModelRecordingChunkFrame {
  readonly kind: 'chunk';
  readonly atMs: number;
  readonly chunk: ModelChunk;
}

export interface ModelRecordingCompletedFrame {
  readonly kind: 'completed';
  readonly atMs: number;
}

export interface ModelRecordingErrorFrame {
  readonly kind: 'error';
  readonly atMs: number;
  readonly error: RecordedModelError;
}

export interface ModelRecordingCancelledFrame {
  readonly kind: 'cancelled';
  readonly atMs: number;
}

export type ModelRecordingStreamFrame =
  | ModelRecordingChunkFrame
  | ModelRecordingCompletedFrame
  | ModelRecordingErrorFrame
  | ModelRecordingCancelledFrame;

export interface ModelRecordingTokenResult {
  readonly kind: 'returned';
  readonly atMs: number;
  readonly tokens: number;
}

export interface ModelRecordingTokenError {
  readonly kind: 'error';
  readonly atMs: number;
  readonly error: RecordedModelError;
}

export interface ModelRecordingTokenCancellation {
  readonly kind: 'cancelled';
  readonly atMs: number;
}

export type ModelRecordingTokenOutcome =
  ModelRecordingTokenResult | ModelRecordingTokenError | ModelRecordingTokenCancellation;

interface ModelRecordingOperationBase {
  readonly seq: number;
  readonly request: ModelRequest;
}

export interface ModelRecordingCountTokensOperation extends ModelRecordingOperationBase {
  readonly operation: 'countTokens';
  readonly outcome: ModelRecordingTokenOutcome;
}

export interface ModelRecordingStreamOperation extends ModelRecordingOperationBase {
  readonly operation: 'stream';
  readonly frames: readonly ModelRecordingStreamFrame[];
}

export type ModelRecordingOperation =
  ModelRecordingCountTokensOperation | ModelRecordingStreamOperation;

export interface ModelRecording {
  readonly specVersion: typeof MODEL_RECORDING_SPEC_VERSION;
  readonly kind: typeof MODEL_RECORDING_KIND;
  readonly capabilities: ModelCapabilities;
  readonly redaction: ModelRecordingRedaction;
  readonly operations: readonly ModelRecordingOperation[];
}

export interface RecordingModelPortOptions {
  /** Additional case-insensitive object keys that are always replaced. */
  readonly additionalSensitiveKeys?: readonly string[];
  /** RFC 6901 pointers, evaluated relative to every recorded request and error details object. */
  readonly redactPointers?: readonly string[];
  /** Monotonic clock used to record relative delays. */
  readonly now?: () => number;
}

export type ModelReplayTiming = 'instant' | 'recorded';

export interface ReplayModelPortOptions {
  /** Replays without delay unless explicitly set to `recorded`. */
  readonly timing?: ModelReplayTiming;
  /** Injectable delay primitive for deterministic tests. */
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export class ModelRecordingInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelRecordingInvariantError';
  }
}

export class ModelReplayMismatchError extends Error {
  readonly operationIndex: number;
  readonly path: string;

  constructor(operationIndex: number, path: string, message: string) {
    super(`Recording operation ${operationIndex} mismatch at ${path}: ${message}`);
    this.name = 'ModelReplayMismatchError';
    this.operationIndex = operationIndex;
    this.path = path;
  }
}

export class ModelReplayExhaustedError extends Error {
  constructor(operation: 'stream' | 'countTokens') {
    super(`Model recording has no remaining operation for ${operation}.`);
    this.name = 'ModelReplayExhaustedError';
  }
}

export class ModelReplayCancellationMismatchError extends Error {
  readonly operationIndex: number;

  constructor(operationIndex: number) {
    super(
      `Recording operation ${operationIndex} was cancelled, but the replay AbortSignal is not aborted.`,
    );
    this.name = 'ModelReplayCancellationMismatchError';
    this.operationIndex = operationIndex;
  }
}

interface RedactionContext {
  readonly sensitiveKeys: ReadonlySet<string>;
  readonly pointers: readonly string[];
  readonly secrets: Set<string>;
}

/**
 * Decorates a ModelPort and captures its provider-neutral calls. The recording contains no
 * provider transport data and can therefore be replayed without network access.
 */
export class RecordingModelPort implements ModelPort {
  readonly capabilities: ModelCapabilities;

  readonly #delegate: ModelPort;
  readonly #now: () => number;
  readonly #redaction: ModelRecordingRedaction;
  readonly #sensitiveKeys: ReadonlySet<string>;
  readonly #operations: ModelRecordingOperation[] = [];
  #nextSeq = 0;
  #activeOperations = 0;

  constructor(delegate: ModelPort, options: RecordingModelPortOptions = {}) {
    this.#delegate = delegate;
    this.#now = options.now ?? defaultNow;
    const pointers = [...new Set(options.redactPointers ?? [])];
    for (const pointer of pointers) {
      parseJsonPointer(pointer);
    }
    const additionalSensitiveKeys = options.additionalSensitiveKeys ?? [];
    if (additionalSensitiveKeys.some((key) => key.length === 0)) {
      throw new ModelRecordingInvariantError('Sensitive keys must not be empty.');
    }
    const sensitiveKeys = new Set(
      [...MODEL_RECORDING_SENSITIVE_KEYS, ...additionalSensitiveKeys].map((key) =>
        key.toLowerCase(),
      ),
    );
    this.#sensitiveKeys = sensitiveKeys;
    this.#redaction = deepFreeze({
      replacement: MODEL_RECORDING_REDACTION,
      sensitiveKeys: [...sensitiveKeys].sort(),
      pointers,
    });
    const capabilitiesSnapshot = structuredClone(delegate.capabilities);
    validateCapabilities(capabilitiesSnapshot, '/capabilities');
    this.capabilities = deepFreeze(capabilitiesSnapshot);
  }

  async countTokens(request: ModelRequest, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted();
    const seq = this.#nextSeq;
    this.#nextSeq += 1;
    this.#activeOperations += 1;
    const clock = createRelativeClock(this.#now);
    const context = this.#createRedactionContext();
    const recordedRequest = redactRequest(request, context);
    let outcome: ModelRecordingTokenOutcome | undefined;

    try {
      const tokens = await this.#delegate.countTokens(request, signal);
      signal.throwIfAborted();
      if (!Number.isSafeInteger(tokens) || tokens < 0) {
        throw new ModelRecordingInvariantError(
          `countTokens returned an invalid token count: ${String(tokens)}.`,
        );
      }
      outcome = { kind: 'returned', atMs: clock.read(), tokens };
      return tokens;
    } catch (error) {
      outcome = signal.aborted
        ? { kind: 'cancelled', atMs: clock.read() }
        : {
            kind: 'error',
            atMs: clock.read(),
            error: serializeError(error, context),
          };
      throw error;
    } finally {
      if (outcome !== undefined) {
        this.#operations.push({ seq, operation: 'countTokens', request: recordedRequest, outcome });
      }
      this.#activeOperations -= 1;
    }
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk> {
    signal.throwIfAborted();
    const seq = this.#nextSeq;
    this.#nextSeq += 1;
    this.#activeOperations += 1;
    const clock = createRelativeClock(this.#now);
    const context = this.#createRedactionContext();
    const recordedRequest = redactRequest(request, context);
    const frames: ModelRecordingStreamFrame[] = [];
    let terminalRecorded = false;
    let iterator: AsyncIterator<ModelChunk> | undefined;

    try {
      iterator = this.#delegate.stream(request, signal)[Symbol.asyncIterator]();
      while (true) {
        signal.throwIfAborted();
        const next = await iterator.next();
        signal.throwIfAborted();
        if (next.done) {
          frames.push({ kind: 'completed', atMs: clock.read() });
          terminalRecorded = true;
          return;
        }
        const chunk = structuredClone(next.value);
        frames.push({ kind: 'chunk', atMs: clock.read(), chunk });
        yield structuredClone(chunk);
        signal.throwIfAborted();
      }
    } catch (error) {
      if (!terminalRecorded) {
        frames.push(
          signal.aborted
            ? { kind: 'cancelled', atMs: clock.read() }
            : { kind: 'error', atMs: clock.read(), error: serializeError(error, context) },
        );
        terminalRecorded = true;
      }
      throw error;
    } finally {
      if (!terminalRecorded) {
        // Async iterator return is consumer cancellation, not a provider failure.
        frames.push({ kind: 'cancelled', atMs: clock.read() });
      }
      if (iterator?.return !== undefined) {
        await iterator.return().catch(() => undefined);
      }
      this.#operations.push({ seq, operation: 'stream', request: recordedRequest, frames });
      this.#activeOperations -= 1;
    }
  }

  snapshot(): ModelRecording {
    if (this.#activeOperations !== 0) {
      throw new ModelRecordingInvariantError(
        `Cannot snapshot while ${this.#activeOperations} model operation(s) are active.`,
      );
    }
    const operations = [...this.#operations].sort((left, right) => left.seq - right.seq);
    if (operations.length !== this.#nextSeq) {
      throw new ModelRecordingInvariantError(
        'One or more model operations did not reach a terminal state.',
      );
    }
    const snapshot = {
      specVersion: MODEL_RECORDING_SPEC_VERSION,
      kind: MODEL_RECORDING_KIND,
      capabilities: structuredClone(this.capabilities),
      redaction: structuredClone(this.#redaction),
      operations: structuredClone(operations),
    } satisfies ModelRecording;
    assertModelRecording(snapshot);
    return deepFreeze(snapshot);
  }

  #createRedactionContext(): RedactionContext {
    return {
      sensitiveKeys: this.#sensitiveKeys,
      pointers: this.#redaction.pointers,
      secrets: new Set<string>(),
    };
  }
}

/** A strict, single-consumer ModelPort backed by a validated recording. */
export class ReplayModelPort implements ModelPort {
  readonly capabilities: ModelCapabilities;

  readonly #recording: ModelRecording;
  readonly #timing: ModelReplayTiming;
  readonly #sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly #sensitiveKeys: ReadonlySet<string>;
  #nextOperation = 0;
  #active = false;

  constructor(recording: unknown, options: ReplayModelPortOptions = {}) {
    assertModelRecording(recording);
    this.#recording = deepFreeze(structuredClone(recording));
    this.capabilities = deepFreeze(structuredClone(recording.capabilities));
    this.#timing = options.timing ?? 'instant';
    this.#sleep = options.sleep ?? defaultSleep;
    this.#sensitiveKeys = new Set(
      recording.redaction.sensitiveKeys.map((key) => key.toLowerCase()),
    );
  }

  async countTokens(request: ModelRequest, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted();
    const claimed = this.#claim('countTokens', request);
    try {
      await this.#wait(claimed.operation.outcome.atMs, signal);
      switch (claimed.operation.outcome.kind) {
        case 'returned':
          return claimed.operation.outcome.tokens;
        case 'error':
          throw hydrateError(claimed.operation.outcome.error);
        case 'cancelled':
          throw replayCancellation(claimed.index, signal);
      }
    } finally {
      this.#active = false;
    }
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk> {
    signal.throwIfAborted();
    const claimed = this.#claim('stream', request);
    let previousAtMs = 0;
    let nextFrameIndex = 0;
    let terminalReached = false;
    try {
      while (nextFrameIndex < claimed.operation.frames.length) {
        const frame = claimed.operation.frames[nextFrameIndex];
        if (frame === undefined) {
          throw new ModelRecordingInvariantError(
            `Recording operation ${claimed.index} has a missing frame.`,
          );
        }
        await this.#wait(frame.atMs - previousAtMs, signal);
        previousAtMs = frame.atMs;
        nextFrameIndex += 1;
        switch (frame.kind) {
          case 'chunk':
            yield structuredClone(frame.chunk);
            signal.throwIfAborted();
            break;
          case 'completed':
            terminalReached = true;
            return;
          case 'error':
            terminalReached = true;
            throw hydrateError(frame.error);
          case 'cancelled':
            terminalReached = true;
            throw replayCancellation(claimed.index, signal);
        }
      }
      terminalReached = true;
      throw new ModelRecordingInvariantError(
        `Recording operation ${claimed.index} has no terminal frame.`,
      );
    } finally {
      this.#active = false;
      if (!terminalReached) {
        assertRecordedConsumerCancellation(
          claimed.operation.frames,
          nextFrameIndex,
          claimed.index,
          signal,
        );
      }
    }
  }

  assertExhausted(): void {
    if (this.#active) {
      throw new ModelRecordingInvariantError('Cannot assert exhaustion while replay is active.');
    }
    if (this.#nextOperation !== this.#recording.operations.length) {
      throw new ModelReplayMismatchError(
        this.#nextOperation,
        '/operations',
        `${this.#recording.operations.length - this.#nextOperation} operation(s) remain`,
      );
    }
  }

  #claim<TOperation extends ModelRecordingOperation['operation']>(
    operation: TOperation,
    request: ModelRequest,
  ): {
    readonly index: number;
    readonly operation: Extract<ModelRecordingOperation, { operation: TOperation }>;
  } {
    if (this.#active) {
      throw new ModelReplayMismatchError(
        this.#nextOperation,
        '/operations',
        'concurrent replay is not supported',
      );
    }
    const index = this.#nextOperation;
    const expected = this.#recording.operations[index];
    if (expected === undefined) {
      throw new ModelReplayExhaustedError(operation);
    }
    if (expected.operation !== operation) {
      throw new ModelReplayMismatchError(
        index,
        '/operation',
        `expected ${expected.operation}, received ${operation}`,
      );
    }
    const context: RedactionContext = {
      sensitiveKeys: this.#sensitiveKeys,
      pointers: this.#recording.redaction.pointers,
      secrets: new Set<string>(),
    };
    const expectedRequest = redactRequest(expected.request, context);
    const actualRequest = redactRequest(request, context);
    const difference = findDifference(expectedRequest, actualRequest, '/request');
    if (difference !== undefined) {
      throw new ModelReplayMismatchError(index, difference.path, difference.message);
    }
    this.#nextOperation += 1;
    this.#active = true;
    return {
      index,
      operation: expected as Extract<ModelRecordingOperation, { operation: TOperation }>,
    };
  }

  async #wait(delayMs: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#timing === 'recorded' && delayMs > 0) {
      await this.#sleep(delayMs, signal);
    }
    signal.throwIfAborted();
  }
}

export function assertModelRecording(recording: unknown): asserts recording is ModelRecording {
  const root = expectObject(recording, '/');
  expectExactKeys(root, ['specVersion', 'kind', 'capabilities', 'redaction', 'operations'], '/');
  if (root['specVersion'] !== MODEL_RECORDING_SPEC_VERSION) {
    fail('/specVersion', `expected ${MODEL_RECORDING_SPEC_VERSION}`);
  }
  if (root['kind'] !== MODEL_RECORDING_KIND) {
    fail('/kind', `expected ${MODEL_RECORDING_KIND}`);
  }
  validateCapabilities(root['capabilities'], '/capabilities');
  const redaction = expectObject(root['redaction'], '/redaction');
  expectExactKeys(redaction, ['replacement', 'sensitiveKeys', 'pointers'], '/redaction');
  if (redaction['replacement'] !== MODEL_RECORDING_REDACTION) {
    fail('/redaction/replacement', `expected ${MODEL_RECORDING_REDACTION}`);
  }
  const sensitiveKeys = expectStringArray(redaction['sensitiveKeys'], '/redaction/sensitiveKeys');
  expectUniqueStrings(sensitiveKeys, '/redaction/sensitiveKeys');
  for (const [index, key] of sensitiveKeys.entries()) {
    if (key.length === 0) {
      fail(`/redaction/sensitiveKeys/${index}`, 'must not be empty');
    }
  }
  const pointers = expectStringArray(redaction['pointers'], '/redaction/pointers');
  expectUniqueStrings(pointers, '/redaction/pointers');
  for (const [index, pointer] of pointers.entries()) {
    try {
      parseJsonPointer(pointer);
    } catch (error) {
      fail(`/redaction/pointers/${index}`, errorMessage(error));
    }
  }

  if (!Array.isArray(root['operations'])) {
    fail('/operations', 'must be an array');
  }
  for (const [index, candidate] of root['operations'].entries()) {
    const path = `/operations/${index}`;
    const operation = expectObject(candidate, path);
    if (operation['seq'] !== index) {
      fail(`${path}/seq`, `must equal its zero-based operation index ${index}`);
    }
    validateRequest(operation['request'], `${path}/request`);
    switch (operation['operation']) {
      case 'countTokens':
        expectExactKeys(operation, ['seq', 'operation', 'request', 'outcome'], path);
        validateTokenOutcome(operation['outcome'], `${path}/outcome`);
        break;
      case 'stream':
        expectExactKeys(operation, ['seq', 'operation', 'request', 'frames'], path);
        validateFrames(operation['frames'], `${path}/frames`);
        break;
      default:
        fail(`${path}/operation`, 'must be countTokens or stream');
    }
  }
}

function validateCapabilities(candidate: unknown, path: string): void {
  const capabilities = expectObject(candidate, path);
  expectExactKeys(
    capabilities,
    ['streaming', 'toolUse', 'promptCaching', 'structuredOutput', 'maxContext', 'vision'],
    path,
  );
  for (const key of ['streaming', 'promptCaching', 'structuredOutput', 'vision']) {
    if (typeof capabilities[key] !== 'boolean') {
      fail(`${path}/${key}`, 'must be boolean');
    }
  }
  if (!['native', 'prompted', 'none'].includes(String(capabilities['toolUse']))) {
    fail(`${path}/toolUse`, 'must be native, prompted, or none');
  }
  expectPositiveInteger(capabilities['maxContext'], `${path}/maxContext`);
}

function validateRequest(candidate: unknown, path: string): void {
  const request = expectObject(candidate, path);
  expectAllowedKeys(request, ['messages', 'tools', 'toolUse', 'metadata'], path);
  for (const required of ['messages', 'tools', 'toolUse']) {
    if (!(required in request)) {
      fail(`${path}/${required}`, 'is required');
    }
  }
  const messages = request['messages'];
  if (!Array.isArray(messages)) {
    fail(`${path}/messages`, 'must be an array');
  }
  for (const [index, message] of messages.entries()) {
    validateMessage(message, `${path}/messages/${index}`);
  }
  const tools = request['tools'];
  if (!Array.isArray(tools)) {
    fail(`${path}/tools`, 'must be an array');
  }
  for (const [index, tool] of tools.entries()) {
    validateToolDefinition(tool, `${path}/tools/${index}`);
  }
  if (
    request['toolUse'] !== 'native' &&
    request['toolUse'] !== 'prompted' &&
    request['toolUse'] !== 'none'
  ) {
    fail(`${path}/toolUse`, 'must be native, prompted, or none');
  }
  if (request['metadata'] !== undefined) {
    expectObject(request['metadata'], `${path}/metadata`);
    assertJsonValue(request['metadata'], `${path}/metadata`);
  }
}

function validateMessage(candidate: unknown, path: string): void {
  const message = expectObject(candidate, path);
  expectAllowedKeys(message, ['role', 'content', 'name', 'toolCallId', 'toolCalls'], path);
  for (const required of ['role', 'content']) {
    if (!(required in message)) fail(`${path}/${required}`, 'is required');
  }
  if (
    message['role'] !== 'system' &&
    message['role'] !== 'user' &&
    message['role'] !== 'assistant' &&
    message['role'] !== 'tool'
  ) {
    fail(`${path}/role`, 'must be system, user, assistant, or tool');
  }
  if (typeof message['content'] !== 'string') {
    fail(`${path}/content`, 'must be a string');
  }
  for (const optional of ['name', 'toolCallId']) {
    if (message[optional] !== undefined && typeof message[optional] !== 'string') {
      fail(`${path}/${optional}`, 'must be a string');
    }
  }
  if (message['toolCalls'] !== undefined) {
    if (!Array.isArray(message['toolCalls'])) {
      fail(`${path}/toolCalls`, 'must be an array');
    }
    for (const [index, call] of message['toolCalls'].entries()) {
      const callPath = `${path}/toolCalls/${index}`;
      const toolCall = expectObject(call, callPath);
      expectExactKeys(toolCall, ['callId', 'tool', 'args'], callPath);
      if (typeof toolCall['callId'] !== 'string') {
        fail(`${callPath}/callId`, 'must be a string');
      }
      if (typeof toolCall['tool'] !== 'string') {
        fail(`${callPath}/tool`, 'must be a string');
      }
      assertJsonValue(toolCall['args'], `${callPath}/args`);
    }
  }
}

function validateToolDefinition(candidate: unknown, path: string): void {
  const tool = expectObject(candidate, path);
  expectAllowedKeys(tool, ['name', 'description', 'inputSchema'], path);
  for (const required of ['name', 'inputSchema']) {
    if (!(required in tool)) fail(`${path}/${required}`, 'is required');
  }
  if (typeof tool['name'] !== 'string') {
    fail(`${path}/name`, 'must be a string');
  }
  if (tool['description'] !== undefined && typeof tool['description'] !== 'string') {
    fail(`${path}/description`, 'must be a string');
  }
  expectObject(tool['inputSchema'], `${path}/inputSchema`);
  assertJsonValue(tool['inputSchema'], `${path}/inputSchema`);
}

function validateTokenOutcome(candidate: unknown, path: string): void {
  const outcome = expectObject(candidate, path);
  expectNonnegativeNumber(outcome['atMs'], `${path}/atMs`);
  switch (outcome['kind']) {
    case 'returned':
      expectExactKeys(outcome, ['kind', 'atMs', 'tokens'], path);
      expectNonnegativeInteger(outcome['tokens'], `${path}/tokens`);
      break;
    case 'error':
      expectExactKeys(outcome, ['kind', 'atMs', 'error'], path);
      validateError(outcome['error'], `${path}/error`);
      break;
    case 'cancelled':
      expectExactKeys(outcome, ['kind', 'atMs'], path);
      break;
    default:
      fail(`${path}/kind`, 'must be returned, error, or cancelled');
  }
}

function validateFrames(candidate: unknown, path: string): void {
  if (!Array.isArray(candidate) || candidate.length === 0) {
    fail(path, 'must be a non-empty array');
  }
  let previousAtMs = 0;
  let terminals = 0;
  for (const [index, candidateFrame] of candidate.entries()) {
    const framePath = `${path}/${index}`;
    const frame = expectObject(candidateFrame, framePath);
    expectNonnegativeNumber(frame['atMs'], `${framePath}/atMs`);
    const atMs = frame['atMs'] as number;
    if (atMs < previousAtMs) {
      fail(`${framePath}/atMs`, 'must not precede the previous frame');
    }
    previousAtMs = atMs;
    switch (frame['kind']) {
      case 'chunk':
        expectExactKeys(frame, ['kind', 'atMs', 'chunk'], framePath);
        validateChunk(frame['chunk'], `${framePath}/chunk`);
        break;
      case 'completed':
      case 'cancelled':
        expectExactKeys(frame, ['kind', 'atMs'], framePath);
        terminals += 1;
        break;
      case 'error':
        expectExactKeys(frame, ['kind', 'atMs', 'error'], framePath);
        validateError(frame['error'], `${framePath}/error`);
        terminals += 1;
        break;
      default:
        fail(`${framePath}/kind`, 'must be chunk, completed, error, or cancelled');
    }
  }
  if (terminals !== 1) {
    fail(path, 'must contain exactly one terminal frame');
  }
  const last = expectObject(candidate[candidate.length - 1], `${path}/${candidate.length - 1}`);
  if (!['completed', 'error', 'cancelled'].includes(String(last['kind']))) {
    fail(`${path}/${candidate.length - 1}/kind`, 'the terminal frame must be last');
  }
}

function validateChunk(candidate: unknown, path: string): void {
  const chunk = expectObject(candidate, path);
  switch (chunk['kind']) {
    case 'text':
      expectExactKeys(chunk, ['kind', 'text'], path);
      if (typeof chunk['text'] !== 'string') fail(`${path}/text`, 'must be a string');
      break;
    case 'tool-call':
      expectExactKeys(chunk, ['kind', 'callId', 'tool', 'args'], path);
      if (typeof chunk['callId'] !== 'string') fail(`${path}/callId`, 'must be a string');
      if (typeof chunk['tool'] !== 'string') fail(`${path}/tool`, 'must be a string');
      assertJsonValue(chunk['args'], `${path}/args`);
      break;
    case 'usage':
      expectExactKeys(chunk, ['kind', 'usage'], path);
      validateUsage(chunk['usage'], `${path}/usage`);
      break;
    case 'finish':
      expectExactKeys(chunk, ['kind', 'reason'], path);
      if (
        !['stop', 'tool-calls', 'length', 'content-filter', 'error'].includes(
          String(chunk['reason']),
        )
      ) {
        fail(`${path}/reason`, 'has an unsupported finish reason');
      }
      break;
    default:
      fail(`${path}/kind`, 'has an unsupported model chunk kind');
  }
}

function validateUsage(candidate: unknown, path: string): void {
  const usage = expectObject(candidate, path);
  expectAllowedKeys(usage, ['inputTokens', 'outputTokens', 'totalTokens', 'cost'], path);
  for (const required of ['inputTokens', 'outputTokens', 'totalTokens']) {
    if (!(required in usage)) fail(`${path}/${required}`, 'is required');
    expectNonnegativeInteger(usage[required], `${path}/${required}`);
  }
  if (usage['cost'] !== undefined) {
    const costPath = `${path}/cost`;
    const cost = expectObject(usage['cost'], costPath);
    expectExactKeys(cost, ['amount', 'currency'], costPath);
    expectNonnegativeNumber(cost['amount'], `${costPath}/amount`);
    if (typeof cost['currency'] !== 'string' || cost['currency'].length === 0) {
      fail(`${costPath}/currency`, 'must be a non-empty string');
    }
  }
}

function validateError(candidate: unknown, path: string): void {
  const error = expectObject(candidate, path);
  if (error['type'] === 'generic') {
    expectExactKeys(error, ['type', 'name', 'message'], path);
  } else if (error['type'] === 'model-port') {
    expectAllowedKeys(
      error,
      [
        'type',
        'name',
        'message',
        'kind',
        'retryable',
        'status',
        'retryAfterMs',
        'providerCode',
        'details',
      ],
      path,
    );
    for (const required of ['type', 'name', 'message', 'kind', 'retryable']) {
      if (!(required in error)) fail(`${path}/${required}`, 'is required');
    }
    if (error['name'] !== 'ModelPortError') fail(`${path}/name`, 'must be ModelPortError');
    if (!MODEL_PORT_ERROR_KINDS.includes(error['kind'] as ModelPortErrorKind)) {
      fail(`${path}/kind`, 'has an unsupported ModelPortError kind');
    }
    if (typeof error['retryable'] !== 'boolean') fail(`${path}/retryable`, 'must be boolean');
    if (error['status'] !== undefined) expectNonnegativeInteger(error['status'], `${path}/status`);
    if (error['retryAfterMs'] !== undefined) {
      expectNonnegativeNumber(error['retryAfterMs'], `${path}/retryAfterMs`);
    }
    if (error['providerCode'] !== undefined && typeof error['providerCode'] !== 'string') {
      fail(`${path}/providerCode`, 'must be a string');
    }
    if (error['details'] !== undefined) {
      expectObject(error['details'], `${path}/details`);
      assertJsonValue(error['details'], `${path}/details`);
    }
  } else {
    fail(`${path}/type`, 'must be generic or model-port');
  }
  if (typeof error['name'] !== 'string' || error['name'].length === 0) {
    fail(`${path}/name`, 'must be a non-empty string');
  }
  if (typeof error['message'] !== 'string') fail(`${path}/message`, 'must be a string');
}

function serializeError(error: unknown, context: RedactionContext): RecordedModelError {
  if (error instanceof ModelPortError) {
    const details =
      error.details === undefined
        ? undefined
        : (redactJsonValue(structuredClone(error.details), context) as JsonObject);
    return {
      type: 'model-port',
      name: 'ModelPortError',
      message: redactSensitiveText(error.message, context.secrets),
      kind: error.kind,
      retryable: error.retryable,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      ...(error.providerCode === undefined
        ? {}
        : { providerCode: redactSensitiveText(error.providerCode, context.secrets) }),
      ...(details === undefined ? {} : { details }),
    };
  }
  const name = error instanceof Error && error.name.length > 0 ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  return {
    type: 'generic',
    name: redactSensitiveText(name, context.secrets),
    message: redactSensitiveText(message, context.secrets),
  };
}

function hydrateError(error: RecordedModelError): Error {
  if (error.type === 'model-port') {
    return new ModelPortError(error.kind, error.message, {
      retryable: error.retryable,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
      ...(error.details === undefined ? {} : { details: structuredClone(error.details) }),
    });
  }
  const hydrated = new Error(error.message);
  hydrated.name = error.name;
  return hydrated;
}

function replayCancellation(operationIndex: number, signal: AbortSignal): never {
  if (signal.aborted) {
    throw signal.reason;
  }
  throw new ModelReplayCancellationMismatchError(operationIndex);
}

function assertRecordedConsumerCancellation(
  frames: readonly ModelRecordingStreamFrame[],
  nextFrameIndex: number,
  operationIndex: number,
  signal: AbortSignal,
): void {
  const nextFrame = frames[nextFrameIndex];
  if (nextFrame?.kind === 'cancelled' && nextFrameIndex === frames.length - 1) {
    return;
  }
  signal.throwIfAborted();
  throw new ModelReplayMismatchError(
    operationIndex,
    `/frames/${nextFrameIndex}`,
    'stream consumer stopped before the recorded terminal',
  );
}

function redactRequest(request: ModelRequest, context: RedactionContext): ModelRequest {
  return redactJsonValue(
    structuredClone(request) as unknown as JsonValue,
    context,
  ) as unknown as ModelRequest;
}

function redactJsonValue(value: JsonValue, context: RedactionContext): JsonValue {
  const redacted = redactSensitiveKeys(value, context);
  for (const pointer of context.pointers) {
    redactPointer(redacted, pointer, context);
  }
  return redacted;
}

function redactSensitiveKeys(value: JsonValue, context: RedactionContext): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveKeys(item, context));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (context.sensitiveKeys.has(key.toLowerCase())) {
        collectSecretStrings(nested, context.secrets);
        if (typeof nested === 'string' && key.toLowerCase().includes('authorization')) {
          const credential = authorizationCredential(nested);
          if (credential !== undefined) {
            context.secrets.add(credential);
          }
        }
        Object.defineProperty(result, key, {
          value: MODEL_RECORDING_REDACTION,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      } else {
        Object.defineProperty(result, key, {
          value: redactSensitiveKeys(nested, context),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    return result;
  }
  return value;
}

function redactPointer(root: JsonValue, pointer: string, context: RedactionContext): void {
  const segments = parseJsonPointer(pointer);
  let parent: JsonValue = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (segment === undefined) return;
    const next = getJsonChild(parent, segment);
    if (next === undefined) return;
    parent = next;
  }
  const finalSegment = segments[segments.length - 1];
  if (finalSegment === undefined) return;
  const existing = getJsonChild(parent, finalSegment);
  if (existing === undefined) return;
  collectSecretStrings(existing, context.secrets);
  if (Array.isArray(parent)) {
    const arrayIndex = parseArrayIndex(finalSegment);
    if (arrayIndex !== undefined && arrayIndex < parent.length) {
      (parent as JsonValue[])[arrayIndex] = MODEL_RECORDING_REDACTION;
    }
  } else if (parent !== null && typeof parent === 'object') {
    Object.defineProperty(parent, finalSegment, {
      value: MODEL_RECORDING_REDACTION,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
}

function getJsonChild(parent: JsonValue, segment: string): JsonValue | undefined {
  if (Array.isArray(parent)) {
    const index = parseArrayIndex(segment);
    return index === undefined ? undefined : parent[index];
  }
  if (parent !== null && typeof parent === 'object') {
    const object = parent as JsonObject;
    return Object.prototype.hasOwnProperty.call(object, segment) ? object[segment] : undefined;
  }
  return undefined;
}

function parseArrayIndex(segment: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) return undefined;
  const index = Number(segment);
  return Number.isSafeInteger(index) ? index : undefined;
}

function parseJsonPointer(pointer: string): string[] {
  if (pointer.length === 0 || !pointer.startsWith('/')) {
    throw new ModelRecordingInvariantError(
      `Redaction pointer ${JSON.stringify(pointer)} must be a non-empty RFC 6901 pointer.`,
    );
  }
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => {
      if (/~(?:[^01]|$)/.test(segment)) {
        throw new ModelRecordingInvariantError(
          `Redaction pointer ${JSON.stringify(pointer)} contains an invalid escape.`,
        );
      }
      return segment.replaceAll('~1', '/').replaceAll('~0', '~');
    });
}

function collectSecretStrings(value: JsonValue, secrets: Set<string>): void {
  if (typeof value === 'string' && value.length > 0) {
    secrets.add(value);
  } else if (Array.isArray(value)) {
    for (const nested of value) collectSecretStrings(nested, secrets);
  } else if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) collectSecretStrings(nested, secrets);
  }
}

function createRelativeClock(now: () => number): { read(): number } {
  const start = readClock(now);
  let previous = 0;
  return {
    read(): number {
      const elapsed = Math.max(0, readClock(now) - start);
      previous = Math.max(previous, elapsed);
      return previous;
    },
  };
}

function readClock(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value)) {
    throw new ModelRecordingInvariantError('Recording clock must return a finite number.');
  }
  return value;
}

function defaultNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

async function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new ModelRecordingInvariantError(
      `Replay delay must be a finite non-negative number, received ${String(delayMs)}.`,
    );
  }
  let remaining = delayMs;
  while (remaining > 0) {
    signal.throwIfAborted();
    const slice = Math.min(remaining, MAX_TIMER_DELAY_MS);
    await sleepSlice(slice, signal);
    remaining -= slice;
  }
}

async function sleepSlice(delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface Difference {
  readonly path: string;
  readonly message: string;
}

function findDifference(expected: unknown, actual: unknown, path: string): Difference | undefined {
  if (Object.is(expected, actual)) return undefined;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return { path, message: 'array shape differs' };
    }
    if (expected.length !== actual.length) {
      return { path, message: `expected ${expected.length} item(s), received ${actual.length}` };
    }
    for (let index = 0; index < expected.length; index += 1) {
      const difference = findDifference(expected[index], actual[index], `${path}/${index}`);
      if (difference !== undefined) return difference;
    }
    return undefined;
  }
  if (isObject(expected) || isObject(actual)) {
    if (!isObject(expected) || !isObject(actual)) {
      return { path, message: 'object shape differs' };
    }
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    const keyDifference = findDifference(expectedKeys, actualKeys, path);
    if (keyDifference !== undefined) {
      return { path, message: 'object keys differ' };
    }
    for (const key of expectedKeys) {
      const difference = findDifference(
        expected[key],
        actual[key],
        `${path}/${escapePointerSegment(key)}`,
      );
      if (difference !== undefined) return difference;
    }
    return undefined;
  }
  return {
    path,
    message: `expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
  };
}

function escapePointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function expectObject(candidate: unknown, path: string): Record<string, unknown> {
  if (!isObject(candidate)) fail(path, 'must be an object');
  return candidate;
}

function isObject(candidate: unknown): candidate is Record<string, unknown> {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(candidate) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function expectStringArray(candidate: unknown, path: string): string[] {
  if (!Array.isArray(candidate) || !candidate.every((item) => typeof item === 'string')) {
    fail(path, 'must be an array of strings');
  }
  return candidate;
}

function expectUniqueStrings(values: readonly string[], path: string): void {
  const firstIndex = new Map<string, number>();
  for (const [index, value] of values.entries()) {
    const previous = firstIndex.get(value);
    if (previous !== undefined) {
      fail(`${path}/${index}`, `duplicates item ${previous}`);
    }
    firstIndex.set(value, index);
  }
}

function expectExactKeys(
  candidate: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  expectAllowedKeys(candidate, keys, path);
  for (const key of keys) {
    if (!(key in candidate)) fail(`${path === '/' ? '' : path}/${key}`, 'is required');
  }
}

function expectAllowedKeys(
  candidate: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(candidate)) {
    if (!allowed.has(key)) fail(`${path === '/' ? '' : path}/${key}`, 'is not allowed');
  }
}

function expectNonnegativeInteger(candidate: unknown, path: string): void {
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    fail(path, 'must be a non-negative safe integer');
  }
}

function expectPositiveInteger(candidate: unknown, path: string): void {
  if (!Number.isSafeInteger(candidate) || (candidate as number) <= 0) {
    fail(path, 'must be a positive safe integer');
  }
}

function expectNonnegativeNumber(candidate: unknown, path: string): void {
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0) {
    fail(path, 'must be a finite non-negative number');
  }
}

function assertJsonValue(
  candidate: unknown,
  path: string,
  ancestors = new Set<object>(),
): asserts candidate is JsonValue {
  if (
    candidate === null ||
    typeof candidate === 'string' ||
    typeof candidate === 'boolean' ||
    (typeof candidate === 'number' && Number.isFinite(candidate))
  ) {
    return;
  }
  if (Array.isArray(candidate)) {
    if (ancestors.has(candidate)) fail(path, 'must not contain a cycle');
    ancestors.add(candidate);
    for (const [index, value] of candidate.entries()) {
      assertJsonValue(value, `${path}/${index}`, ancestors);
    }
    ancestors.delete(candidate);
    return;
  }
  if (isObject(candidate)) {
    if (ancestors.has(candidate)) fail(path, 'must not contain a cycle');
    ancestors.add(candidate);
    for (const [key, value] of Object.entries(candidate)) {
      assertJsonValue(value, `${path}/${escapePointerSegment(key)}`, ancestors);
    }
    ancestors.delete(candidate);
    return;
  }
  fail(path, 'must be a JSON value');
}

function fail(path: string, message: string): never {
  throw new ModelRecordingInvariantError(`${path}: ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
