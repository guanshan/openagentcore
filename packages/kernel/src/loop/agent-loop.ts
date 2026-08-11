import type { EventLog } from '../events/event-log.js';
import {
  applyEventToMessageProjection,
  materializeMessageHistory,
  projectMessageHistory,
  type MessageHistoryItem,
  type MessageProjectionEntry,
} from '../events/projection.js';
import type { AgentEvent, JsonObject, JsonValue, ModelUsage, UserInput } from '../events/types.js';
import type {
  ModelChunk,
  ModelMessage,
  ModelPort,
  ModelRequest,
  ModelToolDefinition,
  ModelToolUse,
  ToolCallModelChunk,
} from '../ports/model.js';
import {
  createDefaultStrategyRegistry,
  type CheckpointDecision,
  type CheckpointStrategyInput,
  type CompactionDecision,
  type CompactionEntry,
  type CompactionStrategyInput,
  type ExponentialBackoffConfig,
  type MaxStepsConfig,
  type PermissionStrategyInput,
  type PermissionStrategyOutput,
  type RetryDecision,
  type RetryStrategyInput,
  type StopDecision,
  type StopStepOutcome,
  type StopStrategyInput,
} from '../strategy/builtins.js';
import type { Strategy, StrategyMetricsSnapshot, StrategyRegistry } from '../strategy/registry.js';
import type { Tool, ToolExecutionRequest } from '../tools/tool.js';
import { ToolRegistry } from '../tools/tool.js';
import {
  createCostAccountingMiddleware,
  MiddlewareRegistry,
  type ContextMiddlewareContext,
  type EventMiddlewareContext,
  type Middleware,
  type MiddlewareContextMap,
  type MiddlewareKind,
  type ModelMiddlewareContext,
  type ToolMiddlewareContext,
} from './middleware.js';
import {
  applyEventToSessionState,
  createSessionReplayState,
  projectSessionState,
  type PendingToolCallState,
  type SessionReplayState,
} from './session-state.js';

export const PROMPTED_TOOL_CALL_PREFIX = 'OAC_TOOL_CALL ';

export interface StrategySelection {
  readonly use: string;
  readonly config?: unknown;
}

export interface AgentLoopStrategySelections {
  readonly stop?: StrategySelection;
  readonly compaction?: StrategySelection;
  readonly permission?: StrategySelection;
  readonly retry?: StrategySelection;
  readonly checkpoint?: StrategySelection;
}

export type AgentLoopSleeper = (delayMs: number, signal: AbortSignal) => Promise<void>;

export interface AgentLoopOptions {
  readonly eventLog: EventLog;
  readonly model: ModelPort;
  readonly tools?: ToolRegistry;
  readonly strategyRegistry?: StrategyRegistry;
  readonly strategies?: AgentLoopStrategySelections;
  readonly now?: () => string;
  readonly sleep?: AgentLoopSleeper;
}

export interface RunTurnOptions {
  readonly signal?: AbortSignal;
}

export interface TurnResult {
  readonly turnId: string;
  readonly stopReason: string;
  readonly usage: ModelUsage;
  readonly events: readonly AgentEvent[];
  readonly history: readonly MessageHistoryItem[];
}

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

export class UnknownToolResultError extends Error {
  constructor(callId: string) {
    super(`Tool call ${callId} has no persisted result; its external outcome is unknown.`);
    this.name = 'UnknownToolResultError';
  }
}

type AgentEventBaseKeys = 'seq' | 'tenantId' | 'sessionId' | 'ts';
type AgentEventPayloadOf<TEvent extends AgentEvent> = TEvent extends AgentEvent
  ? Omit<TEvent, AgentEventBaseKeys>
  : never;
type AgentEventPayload = AgentEventPayloadOf<AgentEvent>;

interface SelectedStrategies {
  readonly stop: Strategy<StopStrategyInput, StopDecision, unknown>;
  readonly compaction: Strategy<CompactionStrategyInput, CompactionDecision, unknown>;
  readonly permission: Strategy<PermissionStrategyInput, PermissionStrategyOutput, unknown>;
  readonly retry: Strategy<RetryStrategyInput, RetryDecision, unknown>;
  readonly checkpoint: Strategy<CheckpointStrategyInput, CheckpointDecision, unknown>;
}

interface TurnProgress {
  readonly completedSteps: number;
  readonly lastStepOutcome: StopStepOutcome | undefined;
  readonly lastStepHadToolCalls: boolean;
}

interface ModelStepResult {
  readonly calls: readonly ToolCallModelChunk[];
  readonly usage: ModelUsage;
}

const emptyUsage: ModelUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});

const defaultSelections = {
  stop: { use: 'max-steps', config: { maxSteps: 8 } satisfies MaxStepsConfig },
  compaction: { use: 'none', config: undefined },
  permission: { use: 'allow-all', config: undefined },
  retry: {
    use: 'exponential-backoff',
    config: { maxAttempts: 1, initialDelayMs: 0 } satisfies ExponentialBackoffConfig,
  },
  checkpoint: { use: 'none', config: undefined },
} as const;

export class AgentLoop {
  readonly eventLog: EventLog;
  readonly model: ModelPort;
  readonly tools: ToolRegistry;
  readonly strategies: StrategyRegistry;
  readonly middleware: MiddlewareRegistry;

  readonly #selections: AgentLoopStrategySelections;
  readonly #now: () => string;
  readonly #sleep: AgentLoopSleeper;
  readonly #steering: UserInput[] = [];
  readonly #costAccounting = createCostAccountingMiddleware();

  #selected: SelectedStrategies | undefined;
  #state: SessionReplayState = createSessionReplayState();
  #initialized: Promise<void> | undefined;
  #running = false;
  #activeUsage: ModelUsage = emptyUsage;
  #seededCostTurnId: string | undefined;

  constructor(options: AgentLoopOptions) {
    this.eventLog = options.eventLog;
    this.model = options.model;
    this.tools = options.tools ?? new ToolRegistry();
    this.strategies = options.strategyRegistry ?? createDefaultStrategyRegistry();
    this.middleware = new MiddlewareRegistry().use('event', this.#costAccounting);
    this.#selections = options.strategies ?? {};
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#sleep = options.sleep ?? abortableDelay;
  }

  use<TKind extends MiddlewareKind>(
    kind: TKind,
    middleware: Middleware<MiddlewareContextMap[TKind]>,
  ): this {
    this.middleware.use(kind, middleware);
    return this;
  }

  steer(input: UserInput): void {
    this.#steering.push(structuredClone(input));
  }

  strategyMetrics(): readonly StrategyMetricsSnapshot[] {
    return this.strategies.metrics();
  }

  async runTurn(input: UserInput, options: RunTurnOptions = {}): Promise<TurnResult> {
    return this.#exclusive(async () => {
      const signal = options.signal ?? new AbortController().signal;
      await this.#prepare(signal);
      if (this.#state.activeTurn !== undefined) {
        throw new AgentLoopInvariantError(
          `Turn ${this.#state.activeTurn.turnId} is unfinished; call resumeTurn() first.`,
        );
      }

      const turnId = `turn-${this.#state.lastSeq + 1}`;
      try {
        await this.#emit({ type: 'turn.started', turnId, input: structuredClone(input) }, signal);
        this.#seededCostTurnId = turnId;
        return await this.#driveTurn(turnId, signal);
      } catch (error) {
        if (error instanceof AgentLoopCrashError) {
          throw error;
        }
        await this.#closeAfterFailure(error, signal.aborted);
        throw error;
      }
    });
  }

  async resumeTurn(options: RunTurnOptions = {}): Promise<TurnResult> {
    return this.#exclusive(async () => {
      const signal = options.signal ?? new AbortController().signal;
      await this.#prepare(signal);
      const turn = this.#state.activeTurn;
      if (turn === undefined) {
        throw new AgentLoopInvariantError('No unfinished turn is available to resume.');
      }

      try {
        await this.#recoverActiveStep(signal);
        return await this.#driveTurn(turn.turnId, signal);
      } catch (error) {
        if (error instanceof AgentLoopCrashError) {
          throw error;
        }
        await this.#closeAfterFailure(error, signal.aborted);
        throw error;
      }
    });
  }

  async #driveTurn(turnId: string, signal: AbortSignal): Promise<TurnResult> {
    while (true) {
      signal.throwIfAborted();
      const progress = await this.#readTurnProgress(turnId);
      const stop = await this.#requireStrategies().stop.apply(
        progress,
        this.#strategyContext(signal, turnId, this.#state.activeStep?.stepId),
      );
      if (stop.stop) {
        const persistedReason = failureStopReasons.has(stop.reason) ? 'failed' : stop.reason;
        const finished = await this.#emit(
          { type: 'turn.finished', turnId, stopReason: persistedReason },
          signal,
        );
        if (finished.type !== 'turn.finished') {
          throw new AgentLoopInvariantError('Expected turn.finished after the stop decision.');
        }
        return this.#buildTurnResult(turnId, finished.stopReason, finished.usage ?? emptyUsage);
      }

      await this.#runStep(turnId, this.#state.activeTurn?.lastStepIndex ?? 0, signal);
    }
  }

  async #runStep(turnId: string, lastStepIndex: number, signal: AbortSignal): Promise<void> {
    const stepIndex = lastStepIndex + 1;
    const stepId = `${turnId}:step:${stepIndex}`;
    const injectedInputs = structuredClone(this.#steering);
    this.#activeUsage = emptyUsage;
    try {
      await this.#emit({ type: 'step.started', turnId, stepId, stepIndex, injectedInputs }, signal);
    } finally {
      if (this.#state.activeStep?.stepId === stepId) {
        this.#steering.splice(0, injectedInputs.length);
      }
    }

    const modelResult = await this.#callModel(turnId, stepId, signal);
    this.#activeUsage = modelResult.usage;
    let failed = false;

    // Persist the complete batch of model-selected intents before any tool can cause a side effect.
    for (const call of modelResult.calls) {
      await this.#emit(
        {
          type: 'tool.call',
          stepId,
          callId: call.callId,
          tool: call.tool,
          args: structuredClone(call.args),
          modelUsage: this.#activeUsage,
        },
        signal,
      );
    }

    for (const call of modelResult.calls) {
      const outcome = await this.#executeRecordedToolCall(turnId, stepId, call, signal);
      failed ||= !outcome;
    }

    await this.#runMemoryPipeline('write', turnId, stepId, signal);
    await this.#emit(
      {
        type: 'step.finished',
        turnId,
        stepId,
        outcome: failed ? 'failed' : 'succeeded',
        usage: this.#activeUsage,
      },
      signal,
    );
    await this.#maybeCompact(turnId, stepId, signal);
    await this.#maybeCheckpoint(turnId, stepId, signal);
  }

  async #callModel(turnId: string, stepId: string, signal: AbortSignal): Promise<ModelStepResult> {
    const { messages, definitions, toolUse, capabilityDowngrades } = await this.#assembleContext(
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
      ...this.#middlewareContext(signal, turnId, stepId),
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
        this.#activeUsage = recorded.usage;
      }
    };

    const flushPromptedText = async (): Promise<void> => {
      if (promptedTextBuffer === undefined) {
        return;
      }
      const text = promptedTextBuffer;
      promptedTextBuffer = undefined;
      acceptRecordedChunk(
        await this.#recordModelChunk(
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
        await this.#recordModelChunk(chunk, context.request.toolUse, stepId, requestId, signal),
      );
    };

    const recordRequest = async (): Promise<void> => {
      if (requestRecorded) {
        return;
      }
      await this.#emit(
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

    await this.middleware.run('model', context, async () => {
      await recordRequest();
      countedInputTokens = await this.model.countTokens(context.request, signal);
      this.#activeUsage = {
        inputTokens: countedInputTokens,
        outputTokens: 0,
        totalTokens: countedInputTokens,
      };
      for await (const chunk of this.model.stream(context.request, signal)) {
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

  async #recordModelChunk(
    chunk: ModelChunk,
    toolUse: ModelToolUse,
    stepId: string,
    requestId: string,
    signal: AbortSignal,
  ): Promise<{ readonly call?: ToolCallModelChunk; readonly usage?: ModelUsage }> {
    switch (chunk.kind) {
      case 'text': {
        const promptedCall =
          toolUse === 'prompted' ? decodePromptedToolCall(chunk.text) : undefined;
        if (promptedCall !== undefined) {
          await this.#emit(
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
        await this.#emit(
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
        await this.#emit(
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

  async #assembleContext(
    turnId: string,
    stepId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly messages: readonly ModelMessage[];
    readonly definitions: readonly ModelToolDefinition[];
    readonly toolUse: ModelToolUse;
    readonly capabilityDowngrades: readonly string[];
  }> {
    const projection = await projectMessageHistory(this.eventLog.read(0));
    let messages = historyToModelMessages(materializeMessageHistory(projection));
    const memory = await this.#runMemoryPipeline(
      'read',
      turnId,
      stepId,
      signal,
      messagesToJson(messages),
    );
    const remembered = jsonToModelMessages(memory);
    if (remembered !== undefined) {
      messages = remembered;
    }

    const definitions = this.tools.list().map(toolDefinition);
    const toolUse = definitions.length === 0 ? 'none' : this.model.capabilities.toolUse;
    const capabilityDowngrades =
      definitions.length > 0 && toolUse !== 'native' ? [`tool-use:native->${toolUse}`] : [];
    if (toolUse === 'prompted') {
      messages = [
        {
          role: 'system',
          content:
            `${PROMPTED_TOOL_CALL_PREFIX}{"callId":"...","tool":"...","args":{}}` +
            ' emits one complete tool call.',
        },
        ...messages,
      ];
    }

    const context: ContextMiddlewareContext = {
      ...this.#middlewareContext(signal, turnId, stepId),
      messages: [...messages],
      tools: [...definitions],
      capabilityDowngrades: [...capabilityDowngrades],
    };
    await this.middleware.run('context', context);
    return {
      messages: context.messages,
      definitions: context.tools,
      toolUse,
      capabilityDowngrades: context.capabilityDowngrades,
    };
  }

  async #executeRecordedToolCall(
    turnId: string,
    stepId: string,
    call: ToolCallModelChunk,
    signal: AbortSignal,
  ): Promise<boolean> {
    const tool = this.tools.get(call.tool);
    if (tool === undefined) {
      await this.#emitToolFailure(call.callId, stepId, 1, new Error('Tool is not registered.'));
      return false;
    }

    const permission = await this.#requestPermission(tool, call, turnId, stepId, signal);
    if (permission.decision === 'deny') {
      await this.#emitDeniedToolResult(call.callId, stepId, permission.reason, signal);
      return false;
    }
    return this.#executePersistedToolCall(tool, call, turnId, stepId, 1, signal);
  }

  async #requestPermission(
    tool: Tool,
    call: Pick<ToolCallModelChunk, 'callId' | 'tool' | 'args'>,
    turnId: string,
    stepId: string,
    signal: AbortSignal,
  ): Promise<PermissionStrategyOutput> {
    const reqId = `${call.callId}:permission`;
    await this.#emit(
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
    const decision = await this.#requireStrategies().permission.apply(
      {
        tool: tool.name,
        groups: this.tools.groupsFor(tool.name),
        permission: tool.permission,
        args: call.args,
      },
      this.#strategyContext(signal, turnId, stepId),
    );
    const persisted = await this.#emit(
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

  async #executePersistedToolCall(
    tool: Tool,
    call: Pick<ToolCallModelChunk, 'callId' | 'args'>,
    turnId: string,
    stepId: string,
    firstAttempt: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    let attempt = firstAttempt;
    while (true) {
      let result: JsonValue;
      try {
        result = await this.#invokeTool(
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
          await this.#emitToolFailure(call.callId, stepId, attempt, error);
          throw error;
        }
        const retry = await this.#requireStrategies().retry.apply(
          { attempt, operation: 'tool', error },
          this.#strategyContext(signal, turnId, stepId),
        );
        if (!retry.retry) {
          await this.#emitToolFailure(call.callId, stepId, attempt, error, signal);
          throw error;
        }
        await this.#sleep(retry.delayMs, signal);
        attempt += 1;
        continue;
      }

      // Event middleware failures are not execution failures and must never retry the tool.
      await this.#emit(
        {
          type: 'tool.result',
          stepId,
          callId: call.callId,
          result,
          outcome: 'succeeded',
          attempts: attempt,
        },
        signal,
      );
      return true;
    }
  }

  async #invokeTool(
    tool: Tool,
    request: ToolExecutionRequest,
    turnId: string,
    stepId: string,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const context: ToolMiddlewareContext = {
      ...this.#middlewareContext(signal, turnId, stepId),
      tool,
      request,
      result: undefined,
      error: undefined,
    };
    await this.middleware.run('tool', context, async () => {
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

  async #recoverActiveStep(signal: AbortSignal): Promise<void> {
    let state = await this.#reloadState();
    const activeStep = state.activeStep;
    const activeTurn = state.activeTurn;
    if (activeTurn === undefined || activeStep === undefined) {
      return;
    }

    await this.#reconcilePersistedToolBatch(activeStep.stepId, signal);
    state = await this.#reloadState();

    for (const permission of [...state.pendingPermissions]) {
      const call = state.pendingToolCalls.find(
        (candidate) => candidate.callId === permission.callId,
      );
      if (call === undefined) {
        continue;
      }
      const tool = this.tools.get(call.tool);
      if (tool === undefined) {
        await this.#emit(
          {
            type: 'permission.resolved',
            reqId: permission.reqId,
            stepId: activeStep.stepId,
            callId: call.callId,
            decision: 'deny',
            reason: 'tool-not-registered',
          },
          signal,
        );
        await this.#emitDeniedToolResult(
          call.callId,
          activeStep.stepId,
          'tool-not-registered',
          signal,
        );
        continue;
      }
      const decision = await this.#requireStrategies().permission.apply(
        {
          tool: tool.name,
          groups: this.tools.groupsFor(tool.name),
          permission: tool.permission,
          args: call.args,
        },
        this.#strategyContext(signal, activeTurn.turnId, activeStep.stepId),
      );
      const persisted = await this.#emit(
        {
          type: 'permission.resolved',
          reqId: permission.reqId,
          stepId: activeStep.stepId,
          callId: call.callId,
          decision: decision.decision,
          reason: decision.reason,
        },
        signal,
      );
      if (persisted.type !== 'permission.resolved') {
        throw new AgentLoopInvariantError(
          'Expected permission.resolved while recovering approval.',
        );
      }
      const persistedReason = persisted.reason ?? decision.reason;
      if (persisted.decision === 'deny') {
        await this.#emitDeniedToolResult(call.callId, activeStep.stepId, persistedReason, signal);
      } else {
        await this.#executePersistedToolCall(
          tool,
          { callId: call.callId, args: call.args },
          activeTurn.turnId,
          activeStep.stepId,
          1,
          signal,
        );
      }
    }

    state = await this.#reloadState();
    for (const call of [...state.pendingToolCalls]) {
      await this.#recoverPendingToolCall(call, state, signal);
      state = await this.#reloadState();
    }

    const refreshed = await this.#reloadState();
    if (refreshed.activeStep === undefined) {
      return;
    }
    const stepResults = await this.#eventsForStep(refreshed.activeStep.stepId);
    const failed = stepResults.some(
      (event) =>
        event.type === 'tool.result' &&
        event.outcome !== undefined &&
        event.outcome !== 'succeeded',
    );
    const completedToolWork = stepResults.some((event) => event.type === 'tool.call');
    const recoveredUsage = [...stepResults]
      .reverse()
      .find(
        (event): event is Extract<AgentEvent, { readonly type: 'tool.call' }> =>
          event.type === 'tool.call' && event.modelUsage !== undefined,
      )?.modelUsage;
    this.#activeUsage = recoveredUsage ?? emptyUsage;
    if (completedToolWork) {
      await this.#runMemoryPipeline(
        'write',
        refreshed.activeStep.turnId,
        refreshed.activeStep.stepId,
        signal,
      );
    }
    await this.#emit(
      {
        type: 'step.finished',
        turnId: refreshed.activeStep.turnId,
        stepId: refreshed.activeStep.stepId,
        // A model-only step has no durable finish marker, so an unfinished one cannot be
        // proven successful during replay. Tool work is complete only after all calls close.
        outcome: failed || !completedToolWork ? 'failed' : 'succeeded',
        usage: this.#activeUsage,
      },
      signal,
    );
    if (completedToolWork) {
      await this.#maybeCompact(refreshed.activeStep.turnId, refreshed.activeStep.stepId, signal);
      await this.#maybeCheckpoint(refreshed.activeStep.turnId, refreshed.activeStep.stepId, signal);
    }
  }

  async #reconcilePersistedToolBatch(stepId: string, signal: AbortSignal): Promise<void> {
    const events = await this.#eventsForStep(stepId);
    const calls = events.filter(
      (event): event is Extract<AgentEvent, { readonly type: 'tool.call' }> =>
        event.type === 'tool.call',
    );
    if (calls.length === 0) {
      return;
    }

    const persistedCallIds = new Set(calls.map((call) => call.callId));
    const batchUsage = [...calls]
      .reverse()
      .find((call) => call.modelUsage !== undefined)?.modelUsage;
    const modelCallIds = new Set<string>();
    for (const event of events) {
      if (event.type !== 'model.delta' || event.delta.kind !== 'tool') {
        continue;
      }
      const call = recordedToolCall(event.delta.toolCallDelta);
      if (call === undefined) {
        continue;
      }
      if (modelCallIds.has(call.callId)) {
        throw new AgentLoopInvariantError(
          `Model response contains duplicate tool call ID ${call.callId}.`,
        );
      }
      modelCallIds.add(call.callId);
      if (persistedCallIds.has(call.callId)) {
        continue;
      }
      await this.#emit(
        {
          type: 'tool.call',
          stepId,
          callId: call.callId,
          tool: call.tool,
          args: call.args,
          ...(batchUsage === undefined ? {} : { modelUsage: batchUsage }),
        },
        signal,
      );
      persistedCallIds.add(call.callId);
    }
  }

  async #recoverPendingToolCall(
    call: PendingToolCallState,
    state: SessionReplayState,
    signal: AbortSignal,
  ): Promise<void> {
    const turn = state.activeTurn;
    const step = state.activeStep;
    if (turn === undefined || step === undefined) {
      throw new AgentLoopInvariantError('Pending tool work requires an active turn and step.');
    }
    const tool = this.tools.get(call.tool);
    if (tool === undefined) {
      await this.#emitToolFailure(
        call.callId,
        step.stepId,
        1,
        new Error('Tool is not registered.'),
        signal,
      );
      return;
    }

    const resolved = [...state.resolvedPermissions]
      .reverse()
      .find((candidate) => candidate.callId === call.callId);
    if (resolved === undefined) {
      const decision = await this.#requestPermission(
        tool,
        { callId: call.callId, tool: call.tool, args: call.args },
        turn.turnId,
        step.stepId,
        signal,
      );
      if (decision.decision === 'deny') {
        await this.#emitDeniedToolResult(call.callId, step.stepId, decision.reason, signal);
        return;
      }
      await this.#executePersistedToolCall(
        tool,
        { callId: call.callId, args: call.args },
        turn.turnId,
        step.stepId,
        1,
        signal,
      );
      return;
    }
    if (resolved.decision === 'deny') {
      await this.#emitDeniedToolResult(
        call.callId,
        step.stepId,
        resolved.reason ?? 'permission-denied',
        signal,
      );
      return;
    }

    const unknown = new UnknownToolResultError(call.callId);
    const retry = await this.#requireStrategies().retry.apply(
      { attempt: 1, operation: 'recovery', error: unknown },
      this.#strategyContext(signal, turn.turnId, step.stepId),
    );
    if (!retry.retry) {
      await this.#emitToolFailure(call.callId, step.stepId, 1, unknown, signal);
      return;
    }
    await this.#sleep(retry.delayMs, signal);
    await this.#executePersistedToolCall(
      tool,
      { callId: call.callId, args: call.args },
      turn.turnId,
      step.stepId,
      2,
      signal,
    );
  }

  async #emitDeniedToolResult(
    callId: string,
    stepId: string,
    reason: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#emit(
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

  async #emitToolFailure(
    callId: string,
    stepId: string,
    attempts: number,
    error: unknown,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    const serialized = serializeError(error);
    await this.#emit(
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

  async #maybeCompact(turnId: string, stepId: string, signal: AbortSignal): Promise<void> {
    const projection = await projectMessageHistory(this.eventLog.read(0));
    const entries = compactionEntries(projection.entries);
    const decision = await this.#requireStrategies().compaction.apply(
      { entries },
      this.#strategyContext(signal, turnId, stepId),
    );
    if (decision.apply) {
      await this.#emit(
        {
          type: 'compaction.applied',
          summary: decision.summary,
          dropped: decision.dropped,
        },
        signal,
      );
    }
  }

  async #maybeCheckpoint(turnId: string, stepId: string, signal: AbortSignal): Promise<void> {
    const events = await this.#collectEvents();
    const lastCheckpoint = [...events]
      .reverse()
      .find((event) => event.type === 'checkpoint.created');
    const decision = await this.#requireStrategies().checkpoint.apply(
      {
        completedSteps: events.filter(
          (event) => event.type === 'step.finished' && event.turnId === turnId,
        ).length,
        eventsSinceCheckpoint: this.#state.lastSeq - (lastCheckpoint?.seq ?? -1),
      },
      this.#strategyContext(signal, turnId, stepId),
    );
    if (decision.checkpoint) {
      await this.#emit({ type: 'checkpoint.created', snapshotRef: decision.snapshotRef }, signal);
    }
  }

  async #runMemoryPipeline(
    operation: 'read' | 'write',
    turnId: string,
    stepId: string,
    signal: AbortSignal,
    value?: JsonValue,
  ): Promise<JsonValue | undefined> {
    const context = {
      ...this.#middlewareContext(signal, turnId, stepId),
      operation,
      key: `${this.eventLog.sessionId}:message-history`,
      value,
    };
    await this.middleware.run('memory', context);
    return context.value;
  }

  async #closeAfterFailure(error: unknown, aborted: boolean): Promise<void> {
    const signal = new AbortController().signal;
    try {
      let state = await this.#reloadState();
      for (const permission of [...state.pendingPermissions]) {
        await this.#emit(
          {
            type: 'permission.resolved',
            reqId: permission.reqId,
            ...(permission.stepId === undefined ? {} : { stepId: permission.stepId }),
            ...(permission.callId === undefined ? {} : { callId: permission.callId }),
            decision: 'deny',
            reason: aborted ? 'aborted' : 'failed',
          },
          signal,
        );
      }
      state = await this.#reloadState();
      for (const call of [...state.pendingToolCalls]) {
        await this.#emitToolFailure(
          call.callId,
          call.stepId ?? state.activeStep?.stepId ?? 'unknown',
          1,
          error,
          signal,
        );
      }
      state = await this.#reloadState();
      if (state.activeStep !== undefined) {
        await this.#emit(
          {
            type: 'step.finished',
            turnId: state.activeStep.turnId,
            stepId: state.activeStep.stepId,
            outcome: aborted ? 'aborted' : 'failed',
            usage: this.#activeUsage,
          },
          signal,
        );
      }
      state = await this.#reloadState();
      if (state.activeTurn !== undefined) {
        await this.#emit(
          {
            type: 'turn.finished',
            turnId: state.activeTurn.turnId,
            stopReason: aborted ? 'aborted' : 'failed',
          },
          signal,
        );
      }
    } catch {
      // Preserve the original failure. The remaining prefix is replayable for a later recovery.
    }
  }

  async #prepare(signal: AbortSignal): Promise<void> {
    if (this.#initialized === undefined) {
      this.#initialized = this.#initializeStrategies();
    }
    await this.#initialized;
    signal.throwIfAborted();
    await this.#reloadState();
    await this.#seedRecoveredCost();
  }

  async #initializeStrategies(): Promise<void> {
    const ports = { eventLog: this.eventLog, model: this.model, tools: this.tools };
    const stop = selection(this.#selections.stop, defaultSelections.stop);
    const compaction = selection(this.#selections.compaction, defaultSelections.compaction);
    const permission = selection(this.#selections.permission, defaultSelections.permission);
    const retry = selection(this.#selections.retry, defaultSelections.retry);
    const checkpoint = selection(this.#selections.checkpoint, defaultSelections.checkpoint);
    this.#selected = {
      stop: await this.strategies.init('stop', stop.use, stop.config, ports),
      compaction: await this.strategies.init(
        'compaction',
        compaction.use,
        compaction.config,
        ports,
      ),
      permission: await this.strategies.init(
        'permission',
        permission.use,
        permission.config,
        ports,
      ),
      retry: await this.strategies.init('retry', retry.use, retry.config, ports),
      checkpoint: await this.strategies.init(
        'checkpoint',
        checkpoint.use,
        checkpoint.config,
        ports,
      ),
    };
  }

  async #seedRecoveredCost(): Promise<void> {
    const turnId = this.#state.activeTurn?.turnId;
    if (turnId === undefined || this.#seededCostTurnId === turnId) {
      return;
    }
    const signal = new AbortController().signal;
    for (const event of await this.#collectEvents()) {
      if (event.type !== 'step.finished' || event.turnId !== turnId) {
        continue;
      }
      const context: EventMiddlewareContext = {
        ...this.#middlewareContext(signal, turnId, event.stepId),
        event,
        persisted: true,
        persistedEvent: event,
      };
      await this.#costAccounting(context, async () => {});
    }
    this.#seededCostTurnId = turnId;
  }

  async #emit(payload: AgentEventPayload, signal: AbortSignal): Promise<AgentEvent> {
    const event = {
      ...payload,
      seq: this.#state.lastSeq + 1,
      tenantId: this.eventLog.tenantId,
      sessionId: this.eventLog.sessionId,
      ts: this.#now(),
    } as AgentEvent;
    const turnId = eventTurnId(event) ?? this.#state.activeTurn?.turnId ?? '';
    let persistedSnapshot: AgentEvent | undefined;
    const context: EventMiddlewareContext = {
      ...this.#middlewareContext(signal, turnId, eventStepId(event)),
      event,
      persisted: false,
      get persistedEvent() {
        return persistedSnapshot;
      },
    };
    let persistedEvent: AgentEvent | undefined;

    await this.middleware.run('event', context, async () => {
      const candidate = deepFreeze(reconcileEventForPersistence(event, context.event));
      const prospectiveState = applyEventToSessionState(this.#state, candidate);
      const projection = await projectMessageHistory(this.eventLog.read(0));
      applyEventToMessageProjection(projection, candidate);

      await this.eventLog.append(candidate, this.#state.lastSeq);
      persistedEvent = candidate;
      context.event = candidate;
      context.persisted = true;
      persistedSnapshot = candidate;
      this.#state = prospectiveState;
    });
    if (persistedEvent === undefined || context.persistedEvent === undefined) {
      throw new AgentLoopInvariantError(`Event middleware suppressed required ${event.type}.`);
    }
    return persistedEvent;
  }

  async #reloadState(): Promise<SessionReplayState> {
    this.#state = await projectSessionState(this.eventLog.read(0));
    return this.#state;
  }

  async #readTurnProgress(turnId: string): Promise<TurnProgress> {
    const events = await this.#collectEvents();
    const finished = events.filter(
      (event): event is Extract<AgentEvent, { readonly type: 'step.finished' }> =>
        event.type === 'step.finished' && event.turnId === turnId,
    );
    const last = finished.at(-1);
    if (last === undefined) {
      return {
        completedSteps: 0,
        lastStepOutcome: undefined,
        lastStepHadToolCalls: false,
      };
    }
    const stepEvents = events.filter((event) => eventStepId(event) === last.stepId);
    const denied = stepEvents.some(
      (event) => event.type === 'tool.result' && event.outcome === 'denied',
    );
    const toolFailed = stepEvents.some(
      (event) => event.type === 'tool.result' && event.outcome === 'failed',
    );
    return {
      completedSteps: finished.length,
      lastStepOutcome:
        last.outcome === 'succeeded'
          ? 'completed'
          : denied
            ? 'permission-denied'
            : toolFailed
              ? 'tool-error'
              : 'model-error',
      lastStepHadToolCalls: stepEvents.some((event) => event.type === 'tool.call'),
    };
  }

  async #buildTurnResult(
    turnId: string,
    stopReason: string,
    usage: ModelUsage,
  ): Promise<TurnResult> {
    const allEvents = await this.#collectEvents();
    const startIndex = allEvents.findIndex(
      (event) => event.type === 'turn.started' && event.turnId === turnId,
    );
    const events = startIndex < 0 ? [] : allEvents.slice(startIndex);
    const projection = await projectMessageHistory(allEvents);
    return deepFreeze({
      turnId,
      stopReason,
      usage: structuredClone(usage),
      events: structuredClone(events),
      history: materializeMessageHistory(projection),
    });
  }

  async #eventsForStep(stepId: string): Promise<readonly AgentEvent[]> {
    return (await this.#collectEvents()).filter((event) => eventStepId(event) === stepId);
  }

  async #collectEvents(): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const event of this.eventLog.read(0)) {
      events.push(event);
    }
    return events;
  }

  #requireStrategies(): SelectedStrategies {
    if (this.#selected === undefined) {
      throw new AgentLoopInvariantError('AgentLoop strategies have not been initialized.');
    }
    return this.#selected;
  }

  #strategyContext(signal: AbortSignal, turnId: string | undefined, stepId: string | undefined) {
    return {
      signal,
      tenantId: this.eventLog.tenantId,
      sessionId: this.eventLog.sessionId,
      turnId,
      stepId,
    };
  }

  #middlewareContext(signal: AbortSignal, turnId: string, stepId: string | undefined) {
    return {
      signal,
      tenantId: this.eventLog.tenantId,
      sessionId: this.eventLog.sessionId,
      turnId,
      stepId,
    };
  }

  async #exclusive<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    if (this.#running) {
      throw new AgentLoopInvariantError('AgentLoop does not allow concurrent runTurn/resumeTurn.');
    }
    this.#running = true;
    try {
      return await operation();
    } finally {
      this.#running = false;
    }
  }
}

const failureStopReasons = new Set(['model-error', 'tool-error', 'permission-denied']);

function selection(
  configured: StrategySelection | undefined,
  fallback: { readonly use: string; readonly config: unknown },
): { readonly use: string; readonly config: unknown } {
  return configured === undefined ? fallback : { use: configured.use, config: configured.config };
}

function eventTurnId(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'turn.started':
    case 'turn.finished':
    case 'step.started':
    case 'step.finished':
      return event.turnId;
    default:
      return undefined;
  }
}

function eventStepId(event: AgentEvent): string | undefined {
  switch (event.type) {
    case 'step.started':
    case 'step.finished':
    case 'model.request':
    case 'model.delta':
    case 'tool.call':
    case 'tool.result':
    case 'permission.requested':
    case 'permission.resolved':
      return event.stepId;
    default:
      return undefined;
  }
}

function reconcileEventForPersistence(authoritative: AgentEvent, proposed: AgentEvent): AgentEvent {
  const candidate = structuredClone(authoritative) as AgentEvent;
  if (proposed.type !== authoritative.type) {
    return candidate;
  }

  switch (authoritative.type) {
    case 'turn.started':
      return copyEventFields(candidate, proposed, ['input']);
    case 'step.started':
      // injectedInputs and correlation fields are the atomic Steering commit boundary.
      return candidate;
    case 'step.finished':
      return copyEventFields(candidate, proposed, ['outcome', 'usage']);
    case 'model.request':
      // The event must describe the request that ModelPort actually received.
      return candidate;
    case 'model.delta':
      // The event is the durable model output used to reconcile a recovered tool batch.
      return candidate;
    case 'tool.call':
      // Tool intent is fixed before side effects; argument rewriting belongs in tool middleware.
      return candidate;
    case 'tool.result':
      // Result redaction is allowed, but execution outcome and correlation remain authoritative.
      return copyEventFields(candidate, proposed, ['result']);
    case 'permission.requested':
      return copyEventFields(candidate, proposed, ['reason']);
    case 'permission.resolved': {
      const resolved = copyEventFields(candidate, proposed, ['decision', 'reason']);
      if (authoritative.decision === 'deny') {
        (resolved as unknown as { decision: 'allow' | 'deny' }).decision = 'deny';
      }
      return resolved;
    }
    case 'compaction.applied':
      return copyEventFields(candidate, proposed, ['summary', 'dropped']);
    case 'checkpoint.created':
      return copyEventFields(candidate, proposed, ['snapshotRef']);
    case 'turn.finished':
      return copyEventFields(candidate, proposed, ['stopReason', 'usage']);
  }
}

function copyEventFields(
  target: AgentEvent,
  source: AgentEvent,
  fields: readonly string[],
): AgentEvent {
  const mutable = target as unknown as Record<string, unknown>;
  const proposed = source as unknown as Record<string, unknown>;
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(proposed, field)) {
      continue;
    }
    const value = proposed[field];
    if (value !== undefined) {
      mutable[field] = structuredClone(value);
    }
  }
  return target;
}

function modelRequestToJson(request: ModelRequest): JsonObject {
  return {
    messages: messagesToJson(request.messages),
    tools: request.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: structuredClone(tool.inputSchema),
    })),
    toolUse: request.toolUse,
    ...(request.metadata === undefined ? {} : { metadata: structuredClone(request.metadata) }),
  };
}

function messagesToJson(messages: readonly ModelMessage[]): JsonValue {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
  }));
}

function jsonToModelMessages(value: JsonValue | undefined): ModelMessage[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const messages: ModelMessage[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return undefined;
    }
    const role = item['role'];
    const content = item['content'];
    if (
      (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') ||
      typeof content !== 'string'
    ) {
      return undefined;
    }
    const name = item['name'];
    const toolCallId = item['toolCallId'];
    if (
      (name !== undefined && typeof name !== 'string') ||
      (toolCallId !== undefined && typeof toolCallId !== 'string')
    ) {
      return undefined;
    }
    messages.push({
      role,
      content,
      ...(name === undefined ? {} : { name }),
      ...(toolCallId === undefined ? {} : { toolCallId }),
    });
  }
  return messages;
}

function historyToModelMessages(history: readonly MessageHistoryItem[]): ModelMessage[] {
  return history.map((item) => {
    switch (item.kind) {
      case 'message':
        return { role: item.role, content: item.content };
      case 'tool-call':
        return {
          role: 'assistant',
          content: `${PROMPTED_TOOL_CALL_PREFIX}${JSON.stringify({
            callId: item.callId,
            tool: item.tool,
            args: item.args,
          })}`,
        };
      case 'tool-result':
        return {
          role: 'tool',
          content: JSON.stringify(item.result),
          toolCallId: item.callId,
        };
      case 'summary':
        return { role: 'system', content: item.content };
    }
  });
}

function toolDefinition(tool: Tool): ModelToolDefinition {
  const description = tool.permission.description;
  return {
    name: tool.name,
    ...(description === undefined ? {} : { description }),
    inputSchema: structuredClone(tool.inputSchema),
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

function recordedToolCall(value: JsonValue): ToolCallModelChunk | undefined {
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

function compactionEntries(entries: readonly MessageProjectionEntry[]): readonly CompactionEntry[] {
  const bySeq = new Map<number, string[]>();
  for (const entry of entries) {
    if (entry.kind === 'summary') {
      continue;
    }
    const content =
      entry.kind === 'message'
        ? entry.content
        : entry.kind === 'tool-call'
          ? `${entry.tool}(${JSON.stringify(entry.args)})`
          : JSON.stringify(entry.result);
    const contents = bySeq.get(entry.sourceSeq) ?? [];
    contents.push(content);
    bySeq.set(entry.sourceSeq, contents);
  }
  return [...bySeq]
    .sort(([left], [right]) => left - right)
    .map(([sourceSeq, contents]) => ({ sourceSeq, content: contents.join('\n') }));
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

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (delayMs === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
