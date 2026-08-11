import type { EventRange, JsonValue } from '../events/types.js';
import type { ToolPermissionDescriptor } from '../tools/tool.js';
import {
  StrategyRegistry,
  type KernelPorts,
  type Strategy,
  type StrategyContext,
  type StrategyMetrics,
} from './registry.js';

export type StopStepOutcome = 'completed' | 'model-error' | 'tool-error' | 'permission-denied';

export interface StopStrategyInput {
  readonly completedSteps: number;
  readonly lastStepOutcome: StopStepOutcome | undefined;
  readonly lastStepHadToolCalls: boolean;
}

export type StopDecision =
  { readonly stop: false } | { readonly stop: true; readonly reason: string };

export interface MaxStepsConfig {
  readonly maxSteps: number;
}

export class MaxStepsStopStrategy implements Strategy<
  StopStrategyInput,
  StopDecision,
  MaxStepsConfig
> {
  readonly kind = 'stop';
  readonly name = 'max-steps';
  #maxSteps: number | undefined;
  #evaluations = 0;
  #stops = 0;

  async init(config: MaxStepsConfig, ports: KernelPorts): Promise<void> {
    void ports;
    if (!Number.isInteger(config.maxSteps) || config.maxSteps < 1) {
      throw new StrategyConfigError(
        `maxSteps must be a positive integer; received ${config.maxSteps}.`,
      );
    }
    this.#maxSteps = config.maxSteps;
  }

  async apply(input: StopStrategyInput, context: StrategyContext): Promise<StopDecision> {
    context.signal.throwIfAborted();
    const maxSteps = requireInitialized(this.#maxSteps, this);
    this.#evaluations += 1;

    let reason: string | undefined;
    if (input.lastStepOutcome !== undefined && input.lastStepOutcome !== 'completed') {
      reason = input.lastStepOutcome;
    } else if (input.completedSteps >= maxSteps) {
      reason = 'max-steps';
    } else if (input.completedSteps > 0 && !input.lastStepHadToolCalls) {
      reason = 'completed';
    }

    if (reason === undefined) {
      return { stop: false };
    }
    this.#stops += 1;
    return { stop: true, reason };
  }

  metrics(): StrategyMetrics {
    return { evaluations: this.#evaluations, stops: this.#stops };
  }
}

export interface CompactionEntry {
  readonly sourceSeq: number;
  readonly content: string;
}

export interface CompactionStrategyInput {
  readonly entries: readonly CompactionEntry[];
}

export type CompactionDecision =
  | { readonly apply: false }
  | {
      readonly apply: true;
      readonly summary: string;
      readonly dropped: EventRange;
    };

export class NoneCompactionStrategy implements Strategy<
  CompactionStrategyInput,
  CompactionDecision,
  undefined
> {
  readonly kind = 'compaction';
  readonly name = 'none';
  #applications = 0;

  async init(config: undefined, ports: KernelPorts): Promise<void> {
    void config;
    void ports;
  }

  async apply(
    _input: CompactionStrategyInput,
    context: StrategyContext,
  ): Promise<CompactionDecision> {
    context.signal.throwIfAborted();
    this.#applications += 1;
    return { apply: false };
  }

  metrics(): StrategyMetrics {
    return { applications: this.#applications };
  }
}

export interface SlidingWindowCompactionConfig {
  readonly maxEntries: number;
  readonly separator?: string;
}

export class SlidingWindowCompactionStrategy implements Strategy<
  CompactionStrategyInput,
  CompactionDecision,
  SlidingWindowCompactionConfig
> {
  readonly kind = 'compaction';
  readonly name = 'sliding-window';
  #config: SlidingWindowCompactionConfig | undefined;
  #applications = 0;
  #compactions = 0;
  #compactedEntries = 0;

  async init(config: SlidingWindowCompactionConfig, ports: KernelPorts): Promise<void> {
    void ports;
    if (!Number.isInteger(config.maxEntries) || config.maxEntries < 1) {
      throw new StrategyConfigError(
        `maxEntries must be a positive integer; received ${config.maxEntries}.`,
      );
    }
    this.#config = { ...config };
  }

  async apply(
    input: CompactionStrategyInput,
    context: StrategyContext,
  ): Promise<CompactionDecision> {
    context.signal.throwIfAborted();
    const config = requireInitialized(this.#config, this);
    this.#applications += 1;
    if (input.entries.length <= config.maxEntries) {
      return { apply: false };
    }

    const compacted = input.entries.slice(0, input.entries.length - config.maxEntries);
    const first = compacted[0];
    const last = compacted.at(-1);
    if (first === undefined || last === undefined) {
      return { apply: false };
    }
    validateOrderedEntries(input.entries);
    this.#compactions += 1;
    this.#compactedEntries += compacted.length;
    return {
      apply: true,
      summary: compacted.map((entry) => entry.content).join(config.separator ?? '\n'),
      dropped: { fromSeq: first.sourceSeq, toSeq: last.sourceSeq },
    };
  }

  metrics(): StrategyMetrics {
    return {
      applications: this.#applications,
      compactions: this.#compactions,
      compactedEntries: this.#compactedEntries,
    };
  }
}

export interface PermissionStrategyInput {
  readonly tool: string;
  readonly groups: readonly string[];
  readonly permission: ToolPermissionDescriptor;
  readonly args: JsonValue;
}

export type PermissionDecision = 'allow' | 'deny';

export interface PermissionStrategyOutput {
  readonly decision: PermissionDecision;
  readonly reason: string;
}

export class AllowAllPermissionStrategy implements Strategy<
  PermissionStrategyInput,
  PermissionStrategyOutput,
  undefined
> {
  readonly kind = 'permission';
  readonly name = 'allow-all';
  #allowed = 0;

  async init(config: undefined, ports: KernelPorts): Promise<void> {
    void config;
    void ports;
  }

  async apply(
    _input: PermissionStrategyInput,
    context: StrategyContext,
  ): Promise<PermissionStrategyOutput> {
    context.signal.throwIfAborted();
    this.#allowed += 1;
    return { decision: 'allow', reason: 'allow-all' };
  }

  metrics(): StrategyMetrics {
    return { allowed: this.#allowed, denied: 0 };
  }
}

export interface PolicyRule {
  readonly decision: PermissionDecision;
  readonly tool?: string;
  readonly group?: string;
  readonly permissionKind?: string;
}

export interface PolicyFileConfig {
  readonly defaultDecision: PermissionDecision;
  /** Parsed policy content. Kernel never reads a policy file. First matching rule wins. */
  readonly rules: readonly PolicyRule[];
}

export class PolicyFilePermissionStrategy implements Strategy<
  PermissionStrategyInput,
  PermissionStrategyOutput,
  PolicyFileConfig
> {
  readonly kind = 'permission';
  readonly name = 'policy-file';
  #config: PolicyFileConfig | undefined;
  #allowed = 0;
  #denied = 0;

  async init(config: PolicyFileConfig, ports: KernelPorts): Promise<void> {
    void ports;
    for (const [index, rule] of config.rules.entries()) {
      if (
        rule.tool === undefined &&
        rule.group === undefined &&
        rule.permissionKind === undefined
      ) {
        throw new StrategyConfigError(`Policy rule ${index} must contain a selector.`);
      }
    }
    this.#config = structuredClone(config);
  }

  async apply(
    input: PermissionStrategyInput,
    context: StrategyContext,
  ): Promise<PermissionStrategyOutput> {
    context.signal.throwIfAborted();
    const config = requireInitialized(this.#config, this);
    const matched = config.rules.find((rule) => policyMatches(rule, input));
    const decision = matched?.decision ?? config.defaultDecision;
    if (decision === 'allow') {
      this.#allowed += 1;
    } else {
      this.#denied += 1;
    }
    return {
      decision,
      reason: matched === undefined ? 'policy-default' : 'policy-rule',
    };
  }

  metrics(): StrategyMetrics {
    return { allowed: this.#allowed, denied: this.#denied };
  }
}

export type RetryOperation = 'model' | 'tool' | 'recovery';

export interface RetryStrategyInput {
  /** The one-based attempt that just failed. */
  readonly attempt: number;
  readonly operation: RetryOperation;
  readonly error: unknown;
}

export interface RetryDecision {
  readonly retry: boolean;
  readonly delayMs: number;
}

export interface ExponentialBackoffConfig {
  /** Total attempts, including the initial call. */
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly multiplier?: number;
  readonly maxDelayMs?: number;
}

export class ExponentialBackoffRetryStrategy implements Strategy<
  RetryStrategyInput,
  RetryDecision,
  ExponentialBackoffConfig
> {
  readonly kind = 'retry';
  readonly name = 'exponential-backoff';
  #config: Required<ExponentialBackoffConfig> | undefined;
  #evaluations = 0;
  #retries = 0;
  #exhausted = 0;

  async init(config: ExponentialBackoffConfig, ports: KernelPorts): Promise<void> {
    void ports;
    const multiplier = config.multiplier ?? 2;
    const maxDelayMs = config.maxDelayMs ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1) {
      throw new StrategyConfigError('maxAttempts must be a positive integer.');
    }
    if (!Number.isFinite(config.initialDelayMs) || config.initialDelayMs < 0) {
      throw new StrategyConfigError('initialDelayMs must be non-negative.');
    }
    if (!Number.isFinite(multiplier) || multiplier < 1) {
      throw new StrategyConfigError('multiplier must be at least 1.');
    }
    if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
      throw new StrategyConfigError('maxDelayMs must be non-negative.');
    }
    this.#config = { ...config, multiplier, maxDelayMs };
  }

  async apply(input: RetryStrategyInput, context: StrategyContext): Promise<RetryDecision> {
    context.signal.throwIfAborted();
    const config = requireInitialized(this.#config, this);
    if (!Number.isInteger(input.attempt) || input.attempt < 1) {
      throw new StrategyConfigError('Retry attempt must be a positive integer.');
    }
    this.#evaluations += 1;
    if (input.attempt >= config.maxAttempts) {
      this.#exhausted += 1;
      return { retry: false, delayMs: 0 };
    }
    this.#retries += 1;
    return {
      retry: true,
      delayMs: Math.min(
        config.maxDelayMs,
        config.initialDelayMs * config.multiplier ** (input.attempt - 1),
      ),
    };
  }

  metrics(): StrategyMetrics {
    return {
      evaluations: this.#evaluations,
      retries: this.#retries,
      exhausted: this.#exhausted,
    };
  }
}

export interface CheckpointStrategyInput {
  readonly completedSteps: number;
  readonly eventsSinceCheckpoint: number;
}

export type CheckpointDecision =
  { readonly checkpoint: false } | { readonly checkpoint: true; readonly snapshotRef: string };

export class NoneCheckpointStrategy implements Strategy<
  CheckpointStrategyInput,
  CheckpointDecision,
  undefined
> {
  readonly kind = 'checkpoint';
  readonly name = 'none';
  #applications = 0;

  async init(config: undefined, ports: KernelPorts): Promise<void> {
    void config;
    void ports;
  }

  async apply(
    _input: CheckpointStrategyInput,
    context: StrategyContext,
  ): Promise<CheckpointDecision> {
    context.signal.throwIfAborted();
    this.#applications += 1;
    return { checkpoint: false };
  }

  metrics(): StrategyMetrics {
    return { applications: this.#applications };
  }
}

export class StrategyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrategyConfigError';
  }
}

export function createDefaultStrategyRegistry(): StrategyRegistry {
  return new StrategyRegistry()
    .register(new MaxStepsStopStrategy())
    .register(new NoneCompactionStrategy())
    .register(new SlidingWindowCompactionStrategy())
    .register(new AllowAllPermissionStrategy())
    .register(new PolicyFilePermissionStrategy())
    .register(new ExponentialBackoffRetryStrategy())
    .register(new NoneCheckpointStrategy());
}

function requireInitialized<TValue>(
  value: TValue | undefined,
  strategy: { readonly kind: string; readonly name: string },
): TValue {
  if (value === undefined) {
    throw new StrategyConfigError(
      `Strategy is not initialized: ${strategy.kind}/${strategy.name}.`,
    );
  }
  return value;
}

function validateOrderedEntries(entries: readonly CompactionEntry[]): void {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (
      previous === undefined ||
      current === undefined ||
      current.sourceSeq <= previous.sourceSeq
    ) {
      throw new StrategyConfigError('Compaction entries must have strictly increasing sourceSeq.');
    }
  }
}

function policyMatches(rule: PolicyRule, input: PermissionStrategyInput): boolean {
  return (
    (rule.tool === undefined || rule.tool === input.tool) &&
    (rule.group === undefined || input.groups.includes(rule.group)) &&
    (rule.permissionKind === undefined || rule.permissionKind === input.permission.kind)
  );
}
