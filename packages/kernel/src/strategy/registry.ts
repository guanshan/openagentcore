import type { EventLog } from '../events/event-log.js';
import type { ModelPort } from '../ports/model.js';
import type { SandboxPort } from '../ports/sandbox.js';
import type { VaultPort } from '../ports/vault.js';
import type { PromptRegistrySnapshot } from '../prompts/registry.js';
import type { ToolRegistry } from '../tools/tool.js';

export type StrategyKind =
  'stop' | 'compaction' | 'permission' | 'retry' | 'checkpoint' | (string & {});

export interface KernelPorts {
  readonly eventLog?: EventLog;
  readonly model?: ModelPort;
  readonly sandbox?: SandboxPort;
  readonly vault?: VaultPort;
  readonly tools?: ToolRegistry;
  readonly prompts?: PromptRegistrySnapshot;
}

export interface StrategyContext {
  readonly signal: AbortSignal;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly turnId: string | undefined;
  readonly stepId: string | undefined;
}

export type StrategyMetrics = Readonly<Record<string, number>>;

export interface Strategy<TInput, TOutput, TConfig = unknown> {
  readonly kind: StrategyKind;
  readonly name: string;
  init(config: TConfig, ports: KernelPorts): Promise<void>;
  apply(input: TInput, context: StrategyContext): Promise<TOutput>;
  metrics?(): StrategyMetrics;
}

export interface StrategyMetricsSnapshot {
  readonly kind: StrategyKind;
  readonly name: string;
  readonly metrics: StrategyMetrics;
}

export class StrategyRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrategyRegistryError';
  }
}

type ErasedStrategy = Strategy<never, unknown, never>;

export class StrategyRegistry {
  readonly #strategies = new Map<string, ErasedStrategy>();

  register<TInput, TOutput, TConfig>(strategy: Strategy<TInput, TOutput, TConfig>): this {
    if (strategy.kind.length === 0 || strategy.name.length === 0) {
      throw new StrategyRegistryError('Strategy kind and name must be non-empty.');
    }
    const key = strategyKey(strategy.kind, strategy.name);
    if (this.#strategies.has(key)) {
      throw new StrategyRegistryError(
        `Strategy already registered: ${strategy.kind}/${strategy.name}.`,
      );
    }
    this.#strategies.set(key, strategy as unknown as ErasedStrategy);
    return this;
  }

  resolve<TInput, TOutput, TConfig = unknown>(
    kind: StrategyKind,
    name: string,
  ): Strategy<TInput, TOutput, TConfig> {
    const strategy = this.#strategies.get(strategyKey(kind, name));
    if (strategy === undefined) {
      throw new StrategyRegistryError(`Strategy not registered: ${kind}/${name}.`);
    }
    return strategy as unknown as Strategy<TInput, TOutput, TConfig>;
  }

  async init<TInput, TOutput, TConfig>(
    kind: StrategyKind,
    name: string,
    config: TConfig,
    ports: KernelPorts,
  ): Promise<Strategy<TInput, TOutput, TConfig>> {
    const strategy = this.resolve<TInput, TOutput, TConfig>(kind, name);
    await strategy.init(config, ports);
    return strategy;
  }

  async initialize<TInput, TOutput, TConfig>(
    kind: StrategyKind,
    name: string,
    config: TConfig,
    ports: KernelPorts,
  ): Promise<Strategy<TInput, TOutput, TConfig>> {
    return this.init(kind, name, config, ports);
  }

  metrics(): readonly StrategyMetricsSnapshot[] {
    return [...this.#strategies.values()].map((strategy) => ({
      kind: strategy.kind,
      name: strategy.name,
      metrics: Object.freeze({ ...(strategy.metrics?.() ?? {}) }),
    }));
  }
}

function strategyKey(kind: StrategyKind, name: string): string {
  return `${kind}\u0000${name}`;
}
