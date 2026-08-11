import type { AgentEvent, JsonValue, ModelCost, ModelUsage } from '../events/types.js';
import type {
  ModelChunk,
  ModelMessage,
  ModelRequest,
  ModelToolDefinition,
} from '../ports/model.js';
import type { Tool, ToolExecutionRequest } from '../tools/tool.js';

export type MiddlewareNext = () => Promise<void>;

export type Middleware<TContext> = (context: TContext, next: MiddlewareNext) => Promise<void>;

export class MiddlewareNextError extends Error {
  constructor() {
    super('Middleware next() may only be called once.');
    this.name = 'MiddlewareNextError';
  }
}

export class MiddlewarePipeline<TContext> {
  readonly #middleware: Middleware<TContext>[] = [];

  use(middleware: Middleware<TContext>): this {
    this.#middleware.push(middleware);
    return this;
  }

  async run(context: TContext, terminal: MiddlewareNext = async () => {}): Promise<void> {
    const middleware = [...this.#middleware];
    let lastDispatchedIndex = -1;

    const dispatch = async (index: number): Promise<void> => {
      if (index <= lastDispatchedIndex) {
        throw new MiddlewareNextError();
      }
      lastDispatchedIndex = index;
      const current = middleware[index];
      if (current === undefined) {
        await terminal();
        return;
      }
      await current(context, async () => dispatch(index + 1));
    };

    await dispatch(0);
  }
}

export interface MiddlewareBaseContext {
  readonly signal: AbortSignal;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string | undefined;
}

export interface ModelMiddlewareContext extends MiddlewareBaseContext {
  request: ModelRequest;
  readonly chunks: ModelChunk[];
}

export interface ToolMiddlewareContext extends MiddlewareBaseContext {
  tool: Tool;
  request: ToolExecutionRequest;
  result: JsonValue | undefined;
  error: unknown;
}

export interface ContextMiddlewareContext extends MiddlewareBaseContext {
  readonly messages: ModelMessage[];
  readonly tools: ModelToolDefinition[];
  readonly capabilityDowngrades: string[];
}

export interface MemoryMiddlewareContext extends MiddlewareBaseContext {
  readonly operation: 'read' | 'write';
  readonly key: string;
  value: JsonValue | undefined;
}

export interface EventMiddlewareContext extends MiddlewareBaseContext {
  /**
   * Proposed event view. AgentLoop keeps causal IDs and recorded Port inputs/outputs authoritative;
   * behavioral rewrites belong in model, tool, or context middleware and permission Strategy.
   */
  event: AgentEvent;
  /** Set by the append terminal only after the event is durably accepted. */
  persisted: boolean;
  /** Immutable snapshot accepted by EventLog; post-append middleware edits cannot change it. */
  readonly persistedEvent: AgentEvent | undefined;
}

export interface MiddlewareContextMap {
  readonly model: ModelMiddlewareContext;
  readonly tool: ToolMiddlewareContext;
  readonly context: ContextMiddlewareContext;
  readonly memory: MemoryMiddlewareContext;
  readonly event: EventMiddlewareContext;
}

export type MiddlewareKind = keyof MiddlewareContextMap;

type MiddlewarePipelines = {
  readonly [TKind in MiddlewareKind]: MiddlewarePipeline<MiddlewareContextMap[TKind]>;
};

/**
 * The five kernel middleware pipelines. Hooks are the configuration form of this mechanism:
 * Runtime turns configured commands or scripts into middleware; Kernel does not load hook config.
 */
export class MiddlewareRegistry {
  readonly #pipelines: MiddlewarePipelines = {
    model: new MiddlewarePipeline<ModelMiddlewareContext>(),
    tool: new MiddlewarePipeline<ToolMiddlewareContext>(),
    context: new MiddlewarePipeline<ContextMiddlewareContext>(),
    memory: new MiddlewarePipeline<MemoryMiddlewareContext>(),
    event: new MiddlewarePipeline<EventMiddlewareContext>(),
  };

  use<TKind extends MiddlewareKind>(
    kind: TKind,
    middleware: Middleware<MiddlewareContextMap[TKind]>,
  ): this {
    this.#pipelines[kind].use(middleware);
    return this;
  }

  async run<TKind extends MiddlewareKind>(
    kind: TKind,
    context: MiddlewareContextMap[TKind],
    terminal: MiddlewareNext = async () => {},
  ): Promise<void> {
    await this.#pipelines[kind].run(context, terminal);
  }
}

interface MutableUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: ModelCost | undefined;
}

export class CostAccountingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CostAccountingError';
  }
}

/**
 * Accumulates persisted step usage for each turn and enriches turn.finished before persistence.
 * Register one instance per AgentLoop. A recovered loop may seed prior usage by replaying only
 * step.finished events through this middleware before accepting new writes.
 */
export function createCostAccountingMiddleware(): Middleware<EventMiddlewareContext> {
  const usageByTurn = new Map<string, MutableUsage>();

  return async (context, next) => {
    const event = context.event;
    const key = turnKey(
      event.tenantId,
      event.sessionId,
      event.type === 'turn.finished'
        ? event.turnId
        : event.type === 'step.finished'
          ? event.turnId
          : undefined,
    );

    if (event.type === 'step.finished' && key !== undefined) {
      const existing = usageByTurn.get(key) ?? emptyUsage();
      try {
        await next();
      } finally {
        if (context.persistedEvent?.type === 'step.finished') {
          usageByTurn.set(key, addUsage(existing, context.persistedEvent.usage));
        }
      }
      return;
    }

    if (event.type === 'turn.finished' && key !== undefined) {
      const usage = usageByTurn.get(key) ?? emptyUsage();
      context.event = { ...event, usage: finalizeUsage(usage) };
      try {
        await next();
      } finally {
        if (context.persistedEvent !== undefined) {
          usageByTurn.delete(key);
        }
      }
      return;
    }

    await next();
  };
}

function emptyUsage(): MutableUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: undefined };
}

function addUsage(current: MutableUsage, addition: ModelUsage): MutableUsage {
  return {
    inputTokens: current.inputTokens + addition.inputTokens,
    outputTokens: current.outputTokens + addition.outputTokens,
    totalTokens: current.totalTokens + addition.totalTokens,
    cost: addCost(current.cost, addition.cost),
  };
}

function addCost(
  current: ModelCost | undefined,
  addition: ModelCost | undefined,
): ModelCost | undefined {
  if (addition === undefined) {
    return current;
  }
  if (current === undefined) {
    return { ...addition };
  }
  if (current.currency !== addition.currency) {
    throw new CostAccountingError(
      `Cannot aggregate ${current.currency} and ${addition.currency} in one turn.`,
    );
  }
  return { amount: current.amount + addition.amount, currency: current.currency };
}

function finalizeUsage(usage: MutableUsage): ModelUsage {
  return usage.cost === undefined
    ? {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
      }
    : {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        cost: { ...usage.cost },
      };
}

function turnKey(
  tenantId: string,
  sessionId: string,
  turnId: string | undefined,
): string | undefined {
  return turnId === undefined ? undefined : `${tenantId}\u0000${sessionId}\u0000${turnId}`;
}
