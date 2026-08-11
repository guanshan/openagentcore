import type { EventLog } from '../events/event-log.js';
import {
  applyEventToMessageProjection,
  materializeMessageHistory,
  projectMessageHistory,
  type MessageHistoryItem,
} from '../events/projection.js';
import type { AgentEvent, ModelUsage, UserInput } from '../events/types.js';
import type { ModelPort } from '../ports/model.js';
import {
  createDefaultStrategyRegistry,
  type CheckpointDecision,
  type CheckpointStrategyInput,
  type CompactionDecision,
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
import { ToolRegistry } from '../tools/tool.js';
import { compactionEntries, middlewareContext } from './context.js';
import {
  createCostAccountingMiddleware,
  MiddlewareRegistry,
  type EventMiddlewareContext,
  type Middleware,
  type MiddlewareContextMap,
  type MiddlewareKind,
} from './middleware.js';
import { closeAfterFailure, recoverActiveStep, type RecoveryRuntime } from './recovery.js';
import {
  AgentLoopCrashError,
  AgentLoopInvariantError,
  type AgentEventPayload,
  EMPTY_MODEL_USAGE,
  runStep,
} from './step.js';
import {
  applyEventToSessionState,
  createSessionReplayState,
  projectSessionState,
  type SessionReplayState,
} from './session-state.js';

export { PROMPTED_TOOL_CALL_PREFIX } from './context.js';
export { UnknownToolResultError } from './recovery.js';
export { AgentLoopCrashError, AgentLoopInvariantError } from './step.js';

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

const defaultSelections = {
  stop: { use: 'max-steps', config: { maxSteps: 8 } satisfies MaxStepsConfig },
  compaction: { use: 'none', config: undefined },
  permission: { use: 'allow-all', config: undefined },
  retry: {
    use: 'exponential-backoff',
    config: {
      maxAttempts: 1,
      initialDelayMs: 0,
      operationOverrides: {
        tool: { maxAttempts: 2, exhaustedAction: 'feed-back' },
        model: { maxAttempts: 2, exhaustedAction: 'fail-turn' },
        recovery: { maxAttempts: 1, exhaustedAction: 'fail-turn' },
      },
    } satisfies ExponentialBackoffConfig,
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
  #activeUsage: ModelUsage = EMPTY_MODEL_USAGE;
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
        await closeAfterFailure(this.#executionRuntime(), error, signal.aborted);
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
        await recoverActiveStep(this.#executionRuntime(), signal);
        return await this.#driveTurn(turn.turnId, signal);
      } catch (error) {
        if (error instanceof AgentLoopCrashError) {
          throw error;
        }
        await closeAfterFailure(this.#executionRuntime(), error, signal.aborted);
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
        return this.#buildTurnResult(
          turnId,
          finished.stopReason,
          finished.usage ?? EMPTY_MODEL_USAGE,
        );
      }

      await runStep(
        this.#executionRuntime(),
        turnId,
        this.#state.activeTurn?.lastStepIndex ?? 0,
        signal,
      );
    }
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

  #executionRuntime(): RecoveryRuntime {
    const selected = this.#requireStrategies();
    return {
      eventLog: this.eventLog,
      model: this.model,
      tools: this.tools,
      middleware: this.middleware,
      permission: selected.permission,
      retry: selected.retry,
      emit: (payload, signal) => this.#emit(payload, signal),
      sleep: (delayMs, signal) => this.#sleep(delayMs, signal),
      steering: () => this.#steering,
      consumeSteering: (stepId, count) => {
        if (this.#state.activeStep?.stepId === stepId) {
          this.#steering.splice(0, count);
        }
      },
      getActiveUsage: () => this.#activeUsage,
      setActiveUsage: (usage) => {
        this.#activeUsage = usage;
      },
      maybeCompact: (turnId, stepId, signal) => this.#maybeCompact(turnId, stepId, signal),
      maybeCheckpoint: (turnId, stepId, signal) => this.#maybeCheckpoint(turnId, stepId, signal),
      reloadState: () => this.#reloadState(),
      eventsForStep: (stepId) => this.#eventsForStep(stepId),
    };
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
        ...middlewareContext(this.eventLog, signal, turnId, event.stepId),
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
      ...middlewareContext(this.eventLog, signal, turnId, eventStepId(event)),
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
