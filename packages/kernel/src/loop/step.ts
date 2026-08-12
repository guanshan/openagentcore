import type {
  AgentEvent,
  JsonObject,
  JsonValue,
  ModelStreamRetryMode,
  ModelUsage,
  UserInput,
} from '../events/types.js';
import {
  ModelPortError,
  type ModelChunk,
  type ModelRequest,
  type ModelToolUse,
  type ToolCallModelChunk,
} from '../ports/model.js';
import type {
  PermissionStrategyInput,
  PermissionStrategyOutput,
  RetryDecision,
  RetryStrategyInput,
} from '../strategy/builtins.js';
import type { Strategy, StrategyContext } from '../strategy/registry.js';
import {
  describeToolAction,
  ToolContractError,
  type Tool,
  type ToolExecutionRequest,
  type ToolExecutionResult,
} from '../tools/tool.js';
import {
  assembleContext,
  contextDraftToModelRequest,
  type ContextRuntime,
  type ContextAssemblyDraft,
  finalizeContextAssembly,
  middlewareContext,
  modelRequestFromJson,
  PROMPTED_TOOL_CALL_PREFIX,
  runMemoryPipeline,
} from './context.js';
import type { ModelMiddlewareContext, ToolMiddlewareContext } from './middleware.js';

export class AgentLoopInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentLoopInvariantError';
  }
}

/** A deterministic test seam that represents process loss rather than an ordinary failure. */
export class AgentLoopCrashError extends Error {
  constructor(message = 'AgentLoop process interrupted before the operation completed.') {
    super(message);
    this.name = 'AgentLoopCrashError';
  }
}

type AgentEventBaseKeys = 'seq' | 'tenantId' | 'sessionId' | 'ts';
type AgentEventPayloadOf<TEvent extends AgentEvent> = TEvent extends AgentEvent
  ? Omit<TEvent, AgentEventBaseKeys>
  : never;
export type AgentEventPayload = AgentEventPayloadOf<AgentEvent>;

export type EmitAgentEvent = (
  payload: AgentEventPayload,
  signal: AbortSignal,
) => Promise<AgentEvent>;

export interface StepRuntime extends ContextRuntime {
  readonly permission: Strategy<PermissionStrategyInput, PermissionStrategyOutput, unknown>;
  readonly retry: Strategy<RetryStrategyInput, RetryDecision, unknown>;
  readonly emit: EmitAgentEvent;
  readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly modelStreamRetryMode: ModelStreamRetryMode;
  readonly steering: () => readonly UserInput[];
  readonly consumeSteering: (stepId: string, count: number) => void;
  readonly getActiveUsage: () => ModelUsage;
  readonly setActiveUsage: (usage: ModelUsage) => void;
  readonly maybeCompact: (turnId: string, stepId: string, signal: AbortSignal) => Promise<void>;
  readonly maybeCheckpoint: (turnId: string, stepId: string, signal: AbortSignal) => Promise<void>;
}

interface ModelStepResult {
  readonly calls: readonly ToolCallModelChunk[];
  readonly usage: ModelUsage;
}

type ModelPortAttempt = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

export const EMPTY_MODEL_USAGE: ModelUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});

export async function runStep(
  runtime: StepRuntime,
  turnId: string,
  lastStepIndex: number,
  signal: AbortSignal,
): Promise<void> {
  const stepIndex = lastStepIndex + 1;
  const stepId = `${turnId}:step:${stepIndex}`;
  const injectedInputs = structuredClone(runtime.steering());
  runtime.setActiveUsage(EMPTY_MODEL_USAGE);
  try {
    await runtime.emit({ type: 'step.started', turnId, stepId, stepIndex, injectedInputs }, signal);
  } finally {
    runtime.consumeSteering(stepId, injectedInputs.length);
  }

  await runStepBody(runtime, turnId, stepId, [], signal);
}

export async function resumeInterruptedModelStep(
  runtime: StepRuntime,
  turnId: string,
  stepId: string,
  events: readonly AgentEvent[],
  signal: AbortSignal,
): Promise<void> {
  await runStepBody(runtime, turnId, stepId, events, signal);
}

async function runStepBody(
  runtime: StepRuntime,
  turnId: string,
  stepId: string,
  persistedEvents: readonly AgentEvent[],
  signal: AbortSignal,
): Promise<void> {
  const modelResult = await callModel(runtime, turnId, stepId, persistedEvents, signal);
  runtime.setActiveUsage(modelResult.usage);
  let failed = false;

  // Persist the complete batch of model-selected intents before any tool can cause a side effect.
  for (const call of modelResult.calls) {
    await runtime.emit(
      {
        type: 'tool.call',
        stepId,
        callId: call.callId,
        tool: call.tool,
        args: structuredClone(call.args),
        modelUsage: runtime.getActiveUsage(),
      },
      signal,
    );
  }

  for (const call of modelResult.calls) {
    const outcome = await executeRecordedToolCall(runtime, turnId, stepId, call, signal);
    failed ||= !outcome;
  }

  await runMemoryPipeline(runtime, 'write', turnId, stepId, signal);
  await runtime.emit(
    {
      type: 'step.finished',
      turnId,
      stepId,
      outcome: failed ? 'failed' : 'succeeded',
      usage: runtime.getActiveUsage(),
    },
    signal,
  );
  await runtime.maybeCompact(turnId, stepId, signal);
  await runtime.maybeCheckpoint(turnId, stepId, signal);
}

export async function executePersistedToolCall(
  runtime: StepRuntime,
  tool: Tool,
  call: Pick<ToolCallModelChunk, 'callId' | 'args'>,
  turnId: string,
  stepId: string,
  firstAttempt: number,
  signal: AbortSignal,
): Promise<boolean> {
  let attempt = firstAttempt;
  while (true) {
    let result: ToolExecutionResult;
    try {
      result = await invokeTool(
        runtime,
        tool,
        { callId: call.callId, args: call.args, attempt },
        turnId,
        stepId,
        signal,
      );
    } catch (error) {
      if (error instanceof AgentLoopCrashError) {
        throw error;
      }
      if (error instanceof ToolContractError) {
        throw error;
      }
      if (signal.aborted) {
        await emitToolFailure(runtime, call.callId, stepId, attempt, error);
        throw error;
      }
      const retry = await runtime.retry.apply(
        { attempt, operation: 'tool', error },
        strategyContext(runtime, signal, turnId, stepId),
      );
      if (retry.action !== 'retry') {
        await emitToolFailure(runtime, call.callId, stepId, attempt, error, signal);
        if (retry.action === 'feed-back') {
          return true;
        }
        throw error;
      }
      await runtime.sleep(retry.delayMs, signal);
      attempt += 1;
      continue;
    }

    // Event middleware failures are not execution failures and must never retry the tool.
    await runtime.emit(
      {
        type: 'tool.result',
        stepId,
        callId: call.callId,
        result: result.result,
        outcome: result.outcome,
        attempts: attempt,
      },
      signal,
    );
    return true;
  }
}

export async function requestPermission(
  runtime: StepRuntime,
  tool: Tool,
  call: Pick<ToolCallModelChunk, 'callId' | 'tool' | 'args'>,
  turnId: string,
  stepId: string,
  signal: AbortSignal,
): Promise<PermissionStrategyOutput> {
  const reqId = `${call.callId}:permission`;
  const action = await describeToolAction(tool, call.args, signal);
  await runtime.emit(
    {
      type: 'permission.requested',
      reqId,
      stepId,
      callId: call.callId,
      action,
    },
    signal,
  );
  const decision = await runtime.permission.apply(
    {
      tool: tool.name,
      groups: runtime.tools.groupsFor(tool.name),
      permission: tool.permission,
      args: call.args,
      action,
    },
    strategyContext(runtime, signal, turnId, stepId),
  );
  const persisted = await runtime.emit(
    {
      type: 'permission.resolved',
      reqId,
      stepId,
      callId: call.callId,
      decision: decision.decision,
      reason: decision.reason,
    },
    signal,
  );
  if (persisted.type !== 'permission.resolved') {
    throw new AgentLoopInvariantError('Expected permission.resolved after permission policy.');
  }
  return {
    decision: persisted.decision,
    reason: persisted.reason ?? decision.reason,
  };
}

export async function emitDeniedToolResult(
  runtime: StepRuntime,
  callId: string,
  stepId: string,
  reason: string,
  signal: AbortSignal,
): Promise<void> {
  await runtime.emit(
    {
      type: 'tool.result',
      stepId,
      callId,
      result: { denied: true, reason },
      outcome: 'denied',
    },
    signal,
  );
}

export async function emitToolFailure(
  runtime: StepRuntime,
  callId: string,
  stepId: string,
  attempts: number,
  error: unknown,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  const serialized = serializeError(error);
  await runtime.emit(
    {
      type: 'tool.result',
      stepId,
      callId,
      result: { error: serialized },
      outcome: 'failed',
      error: serialized,
      attempts,
    },
    signal,
  );
}

export function recordedToolCall(value: JsonValue): ToolCallModelChunk | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as JsonObject;
  const callId = candidate['callId'];
  const tool = candidate['tool'];
  const args = candidate['args'];
  if (
    typeof callId !== 'string' ||
    callId.length === 0 ||
    typeof tool !== 'string' ||
    tool.length === 0 ||
    !isJsonValue(args)
  ) {
    return undefined;
  }
  return { kind: 'tool-call', callId, tool, args: structuredClone(args) };
}

async function callModel(
  runtime: StepRuntime,
  turnId: string,
  stepId: string,
  persistedEvents: readonly AgentEvent[],
  signal: AbortSignal,
): Promise<ModelStepResult> {
  const persistedRequest = persistedEvents.find(
    (event): event is Extract<AgentEvent, { readonly type: 'model.request' }> =>
      event.type === 'model.request',
  );
  let request: ModelRequest;
  let assemblyDraft: ContextAssemblyDraft | undefined;
  let capabilityDowngrades: readonly string[];
  if (persistedRequest === undefined) {
    assemblyDraft = await assembleContext(runtime, turnId, stepId, signal);
    request = contextDraftToModelRequest(assemblyDraft, turnId, stepId);
    capabilityDowngrades = assemblyDraft.capabilityDowngrades;
  } else {
    const restored = modelRequestFromJson(persistedRequest.assembled);
    if (restored === undefined) {
      throw new AgentLoopInvariantError(
        `Persisted model request for ${stepId} cannot be restored.`,
      );
    }
    request = restored;
    capabilityDowngrades = persistedRequest.capabilityDowngrades ?? [];
  }

  const requestId = persistedRequest?.requestId ?? `${stepId}:request`;
  const retryMode = persistedRequest?.retryMode ?? runtime.modelStreamRetryMode;
  const context: ModelMiddlewareContext = {
    ...middlewareContext(runtime.eventLog, signal, turnId, stepId),
    request,
    chunks: [] as ModelChunk[],
  };
  const journal = new ModelDeltaJournal(
    runtime,
    stepId,
    requestId,
    activeModelDeltas(persistedEvents, requestId),
  );
  let usage: ModelUsage | undefined;
  let recordedChunks = 0;
  let requestRecorded = persistedRequest !== undefined;
  let countedInputTokens = 0;
  let promptedTextBuffer: string | undefined;

  const acceptRecordedChunk = (recorded: { readonly usage?: ModelUsage }): void => {
    usage = recorded.usage ?? usage;
    if (recorded.usage !== undefined) {
      runtime.setActiveUsage(recorded.usage);
    }
  };

  const flushPromptedText = async (): Promise<void> => {
    if (promptedTextBuffer === undefined) {
      return;
    }
    const text = promptedTextBuffer;
    promptedTextBuffer = undefined;
    acceptRecordedChunk(
      await recordModelChunk(
        runtime,
        journal,
        { kind: 'text', text },
        text.startsWith(PROMPTED_TOOL_CALL_PREFIX) ? 'prompted' : 'none',
        stepId,
        requestId,
        signal,
      ),
    );
  };

  const recordChunk = async (chunk: ModelChunk): Promise<void> => {
    if (context.request.toolUse === 'prompted' && chunk.kind === 'text') {
      const combined = (promptedTextBuffer ?? '') + chunk.text;
      if (
        promptedTextBuffer !== undefined ||
        PROMPTED_TOOL_CALL_PREFIX.startsWith(combined) ||
        combined.startsWith(PROMPTED_TOOL_CALL_PREFIX)
      ) {
        promptedTextBuffer = combined;
        if (
          !PROMPTED_TOOL_CALL_PREFIX.startsWith(combined) &&
          !combined.startsWith(PROMPTED_TOOL_CALL_PREFIX)
        ) {
          await flushPromptedText();
        }
        return;
      }
    }
    if (chunk.kind === 'finish') {
      await flushPromptedText();
    }
    acceptRecordedChunk(
      await recordModelChunk(
        runtime,
        journal,
        chunk,
        context.request.toolUse,
        stepId,
        requestId,
        signal,
      ),
    );
  };

  const recordRequest = async (): Promise<void> => {
    if (requestRecorded) {
      return;
    }
    if (assemblyDraft === undefined) {
      throw new AgentLoopInvariantError(`Context assembly for ${stepId} is unavailable.`);
    }
    await runtime.emit(
      {
        type: 'model.request',
        stepId,
        requestId,
        assembled: finalizeContextAssembly(assemblyDraft, context.request),
        toolUse: context.request.toolUse,
        capabilityDowngrades,
        retryMode,
      },
      signal,
    );
    requestRecorded = true;
  };

  const invokeModelPort = async (): Promise<ModelPortAttempt> => {
    promptedTextBuffer = undefined;
    usage = undefined;
    countedInputTokens = 0;
    runtime.setActiveUsage(EMPTY_MODEL_USAGE);
    try {
      countedInputTokens = await runtime.model.countTokens(context.request, signal);
    } catch (error) {
      return { ok: false, error };
    }
    runtime.setActiveUsage({
      inputTokens: countedInputTokens,
      outputTokens: 0,
      totalTokens: countedInputTokens,
    });
    let iterator: AsyncIterator<ModelChunk>;
    try {
      iterator = runtime.model.stream(context.request, signal)[Symbol.asyncIterator]();
    } catch (error) {
      return { ok: false, error };
    }
    let completed = false;
    try {
      while (true) {
        let next: IteratorResult<ModelChunk>;
        try {
          next = await iterator.next();
        } catch (error) {
          return { ok: false, error };
        }
        if (next.done) {
          await flushPromptedText();
          journal.assertComplete();
          completed = true;
          return { ok: true };
        }
        const chunk = next.value;
        context.chunks.push(structuredClone(chunk));
        recordedChunks += 1;
        try {
          await recordChunk(chunk);
        } catch (error) {
          if (error instanceof ModelPortError) {
            return { ok: false, error };
          }
          throw error;
        }
      }
    } finally {
      if (!completed) {
        try {
          await iterator.return?.();
        } catch {
          // Cleanup is best-effort and must not hide the model failure being handled.
        }
      }
    }
  };

  await runtime.middleware.run('model', context, async () => {
    if (persistedRequest !== undefined) {
      context.request = structuredClone(request);
    }
    await recordRequest();
    if (persistedRequest !== undefined && retryMode === 'discard') {
      await journal.discard('recovery', signal);
    }
    let attempt = 1;
    while (true) {
      const outcome = await invokeModelPort();
      if (outcome.ok) {
        break;
      }
      if (outcome.error instanceof AgentLoopCrashError || signal.aborted) {
        throw outcome.error;
      }
      const retry = await runtime.retry.apply(
        { attempt, operation: 'model', error: outcome.error },
        strategyContext(runtime, signal, turnId, stepId),
      );
      if (retry.action !== 'retry') {
        throw outcome.error;
      }
      await runtime.sleep(retry.delayMs, signal);
      attempt += 1;
      if (retryMode === 'discard') {
        await journal.discard('provider-failure', signal);
      } else {
        journal.rewind();
      }
    }
  });

  await recordRequest();

  for (const chunk of context.chunks.slice(recordedChunks)) {
    await recordChunk(chunk);
  }
  await flushPromptedText();
  journal.assertComplete();

  return {
    calls: journal.toolCalls(),
    usage: usage ?? {
      inputTokens: countedInputTokens,
      outputTokens: 0,
      totalTokens: countedInputTokens,
    },
  };
}

async function recordModelChunk(
  runtime: StepRuntime,
  journal: ModelDeltaJournal,
  chunk: ModelChunk,
  toolUse: ModelToolUse,
  stepId: string,
  requestId: string,
  signal: AbortSignal,
): Promise<{ readonly usage?: ModelUsage }> {
  switch (chunk.kind) {
    case 'text': {
      const promptedCall = toolUse === 'prompted' ? decodePromptedToolCall(chunk.text) : undefined;
      if (promptedCall !== undefined) {
        await journal.acceptTool(promptedCall, signal);
        return {};
      }
      await journal.acceptText(chunk.text, signal);
      return {};
    }
    case 'tool-call':
      if (toolUse === 'none') {
        throw new AgentLoopInvariantError('Model emitted a tool call when toolUse is none.');
      }
      await journal.acceptTool(chunk, signal);
      return {};
    case 'usage':
      // Providers may send several snapshots; the last usage chunk is the step total.
      return { usage: structuredClone(chunk.usage) };
    case 'finish':
      if (chunk.reason === 'content-filter') {
        throw new ModelPortError(
          'content-filter',
          'Model response was blocked by content policy.',
          {
            retryable: false,
          },
        );
      }
      if (chunk.reason === 'error') {
        throw new ModelPortError('service', 'Model stream finished with an error.', {
          retryable: true,
        });
      }
      return {};
  }
}

type ModelDeltaAtom =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'tool'; readonly call: ToolCallModelChunk };

class ModelDeltaJournal {
  readonly #runtime: StepRuntime;
  readonly #stepId: string;
  readonly #requestId: string;
  readonly #atoms: ModelDeltaAtom[] = [];
  readonly #activeDeltaSeqs: number[] = [];
  #cursor = 0;

  constructor(
    runtime: StepRuntime,
    stepId: string,
    requestId: string,
    persisted: readonly Extract<AgentEvent, { readonly type: 'model.delta' }>[],
  ) {
    this.#runtime = runtime;
    this.#stepId = stepId;
    this.#requestId = requestId;
    for (const event of persisted) {
      this.#activeDeltaSeqs.push(event.seq);
      if (event.delta.kind === 'text') {
        this.#atoms.push(
          ...[...event.delta.text].map((value): ModelDeltaAtom => ({ kind: 'text', value })),
        );
        continue;
      }
      const call = recordedToolCall(event.delta.toolCallDelta);
      if (call === undefined) {
        throw new AgentLoopInvariantError(
          `Persisted model tool delta for ${requestId} cannot be restored.`,
        );
      }
      this.#atoms.push({ kind: 'tool', call });
    }
  }

  async acceptText(text: string, signal: AbortSignal): Promise<void> {
    const suffix: string[] = [];
    for (const value of [...text]) {
      const expected = this.#atoms[this.#cursor];
      if (expected !== undefined) {
        if (expected.kind !== 'text' || expected.value !== value) {
          throw this.#diverged('text');
        }
      } else {
        this.#atoms.push({ kind: 'text', value });
        suffix.push(value);
      }
      this.#cursor += 1;
    }
    if (suffix.length === 0) {
      return;
    }
    const persisted = await this.#runtime.emit(
      {
        type: 'model.delta',
        stepId: this.#stepId,
        requestId: this.#requestId,
        delta: { kind: 'text', text: suffix.join('') },
      },
      signal,
    );
    if (persisted.type !== 'model.delta') {
      throw new AgentLoopInvariantError('Expected model.delta while recording model text.');
    }
    this.#activeDeltaSeqs.push(persisted.seq);
  }

  async acceptTool(call: ToolCallModelChunk, signal: AbortSignal): Promise<void> {
    const expected = this.#atoms[this.#cursor];
    let persist = false;
    if (expected !== undefined) {
      if (expected.kind !== 'tool' || !sameToolCall(expected.call, call)) {
        throw this.#diverged('tool call');
      }
    } else {
      this.#atoms.push({ kind: 'tool', call: structuredClone(call) });
      persist = true;
    }
    this.#cursor += 1;
    if (!persist) {
      return;
    }
    const persisted = await this.#runtime.emit(
      {
        type: 'model.delta',
        stepId: this.#stepId,
        requestId: this.#requestId,
        delta: { kind: 'tool', toolCallDelta: toolCallToJson(call) },
      },
      signal,
    );
    if (persisted.type !== 'model.delta') {
      throw new AgentLoopInvariantError('Expected model.delta while recording a model tool call.');
    }
    this.#activeDeltaSeqs.push(persisted.seq);
  }

  async discard(
    reason: Extract<AgentEvent, { readonly type: 'model.attempt.discarded' }>['reason'],
    signal: AbortSignal,
  ): Promise<void> {
    const firstSeq = this.#activeDeltaSeqs[0];
    const lastSeq = this.#activeDeltaSeqs.at(-1);
    if (firstSeq !== undefined && lastSeq !== undefined) {
      const persisted = await this.#runtime.emit(
        {
          type: 'model.attempt.discarded',
          stepId: this.#stepId,
          requestId: this.#requestId,
          discarded: { fromSeq: firstSeq, toSeq: lastSeq },
          reason,
        },
        signal,
      );
      if (persisted.type !== 'model.attempt.discarded') {
        throw new AgentLoopInvariantError(
          'Expected model.attempt.discarded while restarting a model attempt.',
        );
      }
    }
    this.#atoms.splice(0);
    this.#activeDeltaSeqs.splice(0);
    this.#cursor = 0;
  }

  rewind(): void {
    this.#cursor = 0;
  }

  assertComplete(): void {
    if (this.#cursor !== this.#atoms.length) {
      throw this.#diverged('end of stream');
    }
  }

  toolCalls(): readonly ToolCallModelChunk[] {
    return this.#atoms
      .filter(
        (atom): atom is Extract<ModelDeltaAtom, { readonly kind: 'tool' }> => atom.kind === 'tool',
      )
      .map((atom) => structuredClone(atom.call));
  }

  #diverged(received: string): AgentLoopInvariantError {
    return new AgentLoopInvariantError(
      `Retried model output diverged from the persisted prefix for ${this.#requestId} at atom ${this.#cursor}; received ${received}.`,
    );
  }
}

export function activeModelDeltas(
  events: readonly AgentEvent[],
  requestId: string,
): readonly Extract<AgentEvent, { readonly type: 'model.delta' }>[] {
  const active = new Map<number, Extract<AgentEvent, { readonly type: 'model.delta' }>>();
  for (const event of events) {
    if (
      event.type === 'model.delta' &&
      (event.requestId === undefined || event.requestId === requestId)
    ) {
      active.set(event.seq, event);
      continue;
    }
    if (event.type === 'model.attempt.discarded' && event.requestId === requestId) {
      for (const seq of active.keys()) {
        if (seq >= event.discarded.fromSeq && seq <= event.discarded.toSeq) {
          active.delete(seq);
        }
      }
    }
  }
  return [...active.values()];
}

async function executeRecordedToolCall(
  runtime: StepRuntime,
  turnId: string,
  stepId: string,
  call: ToolCallModelChunk,
  signal: AbortSignal,
): Promise<boolean> {
  const tool = runtime.tools.get(call.tool);
  if (tool === undefined) {
    await emitToolFailure(runtime, call.callId, stepId, 1, new Error('Tool is not registered.'));
    return false;
  }

  const permission = await requestPermission(runtime, tool, call, turnId, stepId, signal);
  if (permission.decision === 'deny') {
    await emitDeniedToolResult(runtime, call.callId, stepId, permission.reason, signal);
    return false;
  }
  return executePersistedToolCall(runtime, tool, call, turnId, stepId, 1, signal);
}

async function invokeTool(
  runtime: StepRuntime,
  tool: Tool,
  request: ToolExecutionRequest,
  turnId: string,
  stepId: string,
  signal: AbortSignal,
): Promise<ToolExecutionResult> {
  const context: ToolMiddlewareContext = {
    ...middlewareContext(runtime.eventLog, signal, turnId, stepId),
    tool,
    request,
    result: undefined,
    error: undefined,
  };
  await runtime.middleware.run('tool', context, async () => {
    context.result = await context.tool.execute(context.request, signal);
  });
  if (context.error !== undefined) {
    throw context.error;
  }
  if (context.result === undefined) {
    throw new ToolContractError(tool.name, 'undefined');
  }
  return structuredClone(validateToolExecutionResult(tool.name, context.result));
}

function validateToolExecutionResult(tool: string, value: unknown): ToolExecutionResult {
  if (value === null) {
    throw new ToolContractError(tool, 'null');
  }
  if (Array.isArray(value)) {
    throw new ToolContractError(tool, 'an array');
  }
  if (typeof value !== 'object') {
    throw new ToolContractError(tool, typeof value);
  }
  const candidate = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(candidate, 'outcome')) {
    throw new ToolContractError(tool, 'object without "outcome"');
  }
  if (candidate['outcome'] !== 'succeeded' && candidate['outcome'] !== 'failed') {
    throw new ToolContractError(
      tool,
      `object with invalid "outcome" ${formatValue(candidate['outcome'])}`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(candidate, 'result')) {
    throw new ToolContractError(tool, 'object without "result"');
  }
  if (!isJsonValue(candidate['result'])) {
    throw new ToolContractError(tool, 'object whose "result" is not JSON');
  }
  return {
    outcome: candidate['outcome'],
    result: structuredClone(candidate['result']),
  };
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  return String(value);
}

function strategyContext(
  runtime: StepRuntime,
  signal: AbortSignal,
  turnId: string | undefined,
  stepId: string | undefined,
): StrategyContext {
  return {
    signal,
    tenantId: runtime.eventLog.tenantId,
    sessionId: runtime.eventLog.sessionId,
    turnId,
    stepId,
  };
}

function decodePromptedToolCall(text: string): ToolCallModelChunk | undefined {
  if (!text.startsWith(PROMPTED_TOOL_CALL_PREFIX)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(PROMPTED_TOOL_CALL_PREFIX.length));
  } catch {
    throw new AgentLoopInvariantError('Prompted tool call is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AgentLoopInvariantError('Prompted tool call must be a JSON object.');
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate['callId'] !== 'string' ||
    candidate['callId'].length === 0 ||
    typeof candidate['tool'] !== 'string' ||
    candidate['tool'].length === 0 ||
    !isJsonValue(candidate['args'])
  ) {
    throw new AgentLoopInvariantError('Prompted tool call has invalid callId, tool, or args.');
  }
  return {
    kind: 'tool-call',
    callId: candidate['callId'],
    tool: candidate['tool'],
    args: structuredClone(candidate['args']),
  };
}

function toolCallToJson(call: Pick<ToolCallModelChunk, 'callId' | 'tool' | 'args'>): JsonObject {
  return { callId: call.callId, tool: call.tool, args: structuredClone(call.args) };
}

function sameToolCall(left: ToolCallModelChunk, right: ToolCallModelChunk): boolean {
  return (
    left.callId === right.callId && left.tool === right.tool && jsonEqual(left.args, right.args)
  );
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return Object.is(left, right);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => {
        const candidate = right[index];
        return candidate !== undefined && jsonEqual(value, candidate);
      })
    );
  }
  const leftObject = left as JsonObject;
  const rightObject = right as JsonObject;
  const leftKeys = Object.keys(leftObject).sort();
  const rightKeys = Object.keys(rightObject).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => {
      const rightKey = rightKeys[index];
      const leftValue = leftObject[key];
      const rightValue = rightObject[key];
      return rightKey === key && leftValue !== undefined && rightValue !== undefined
        ? jsonEqual(leftValue, rightValue)
        : false;
    })
  );
}

function serializeError(error: unknown): JsonObject {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) };
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
