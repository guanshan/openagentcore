import type { AgentEvent, JsonObject, JsonValue, ModelUsage, UserInput } from '../events/types.js';
import type { ModelChunk, ModelRequest, ModelToolUse, ToolCallModelChunk } from '../ports/model.js';
import type {
  PermissionStrategyInput,
  PermissionStrategyOutput,
  RetryDecision,
  RetryStrategyInput,
} from '../strategy/builtins.js';
import type { Strategy, StrategyContext } from '../strategy/registry.js';
import type { Tool, ToolExecutionRequest, ToolExecutionResult } from '../tools/tool.js';
import {
  assembleContext,
  type ContextRuntime,
  middlewareContext,
  modelRequestToJson,
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

  const modelResult = await callModel(runtime, turnId, stepId, signal);
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
  await runtime.emit(
    {
      type: 'permission.requested',
      reqId,
      stepId,
      callId: call.callId,
      action: {
        tool: call.tool,
        args: structuredClone(call.args),
        permission: structuredClone(tool.permission),
      },
    },
    signal,
  );
  const decision = await runtime.permission.apply(
    {
      tool: tool.name,
      groups: runtime.tools.groupsFor(tool.name),
      permission: tool.permission,
      args: call.args,
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
  signal: AbortSignal,
): Promise<ModelStepResult> {
  const { messages, definitions, toolUse, capabilityDowngrades } = await assembleContext(
    runtime,
    turnId,
    stepId,
    signal,
  );
  const requestId = `${stepId}:request`;
  const metadata: JsonObject =
    toolUse === 'prompted'
      ? { turnId, stepId, toolProtocol: 'oac-prompted-tool-call-v0' }
      : { turnId, stepId };
  const request: ModelRequest = {
    messages,
    tools: toolUse === 'none' ? [] : definitions,
    toolUse,
    metadata,
  };
  const context: ModelMiddlewareContext = {
    ...middlewareContext(runtime.eventLog, signal, turnId, stepId),
    request,
    chunks: [] as ModelChunk[],
  };
  const calls: ToolCallModelChunk[] = [];
  let usage: ModelUsage | undefined;
  let recordedChunks = 0;
  let requestRecorded = false;
  let countedInputTokens = 0;
  let promptedTextBuffer: string | undefined;

  const acceptRecordedChunk = (recorded: {
    readonly call?: ToolCallModelChunk;
    readonly usage?: ModelUsage;
  }): void => {
    if (recorded.call !== undefined) {
      calls.push(recorded.call);
    }
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
      await recordModelChunk(runtime, chunk, context.request.toolUse, stepId, requestId, signal),
    );
  };

  const recordRequest = async (): Promise<void> => {
    if (requestRecorded) {
      return;
    }
    await runtime.emit(
      {
        type: 'model.request',
        stepId,
        requestId,
        assembled: modelRequestToJson(context.request),
        toolUse: context.request.toolUse,
        capabilityDowngrades,
      },
      signal,
    );
    requestRecorded = true;
  };

  await runtime.middleware.run('model', context, async () => {
    await recordRequest();
    countedInputTokens = await runtime.model.countTokens(context.request, signal);
    runtime.setActiveUsage({
      inputTokens: countedInputTokens,
      outputTokens: 0,
      totalTokens: countedInputTokens,
    });
    for await (const chunk of runtime.model.stream(context.request, signal)) {
      context.chunks.push(structuredClone(chunk));
      await recordChunk(chunk);
      recordedChunks += 1;
    }
  });

  await recordRequest();

  for (const chunk of context.chunks.slice(recordedChunks)) {
    await recordChunk(chunk);
  }
  await flushPromptedText();

  return {
    calls,
    usage: usage ?? {
      inputTokens: countedInputTokens,
      outputTokens: 0,
      totalTokens: countedInputTokens,
    },
  };
}

async function recordModelChunk(
  runtime: StepRuntime,
  chunk: ModelChunk,
  toolUse: ModelToolUse,
  stepId: string,
  requestId: string,
  signal: AbortSignal,
): Promise<{ readonly call?: ToolCallModelChunk; readonly usage?: ModelUsage }> {
  switch (chunk.kind) {
    case 'text': {
      const promptedCall = toolUse === 'prompted' ? decodePromptedToolCall(chunk.text) : undefined;
      if (promptedCall !== undefined) {
        await runtime.emit(
          {
            type: 'model.delta',
            stepId,
            requestId,
            delta: { kind: 'tool', toolCallDelta: toolCallToJson(promptedCall) },
          },
          signal,
        );
        return { call: promptedCall };
      }
      await runtime.emit(
        {
          type: 'model.delta',
          stepId,
          requestId,
          delta: { kind: 'text', text: chunk.text },
        },
        signal,
      );
      return {};
    }
    case 'tool-call':
      if (toolUse === 'none') {
        throw new AgentLoopInvariantError('Model emitted a tool call when toolUse is none.');
      }
      await runtime.emit(
        {
          type: 'model.delta',
          stepId,
          requestId,
          delta: { kind: 'tool', toolCallDelta: toolCallToJson(chunk) },
        },
        signal,
      );
      return { call: structuredClone(chunk) };
    case 'usage':
      // Providers may send several snapshots; the last usage chunk is the step total.
      return { usage: structuredClone(chunk.usage) };
    case 'finish':
      return {};
  }
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
    throw new AgentLoopInvariantError(
      `Tool middleware completed without a result for ${request.callId}.`,
    );
  }
  return structuredClone(context.result);
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
