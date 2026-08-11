import { describe, expect, it } from 'vitest';

import {
  AllowAllPermissionStrategy,
  createDefaultStrategyRegistry,
  ExponentialBackoffRetryStrategy,
  MaxStepsStopStrategy,
  NoneCheckpointStrategy,
  NoneCompactionStrategy,
  PolicyFilePermissionStrategy,
  SlidingWindowCompactionStrategy,
  StrategyConfigError,
} from './builtins.js';
import type { StrategyContext } from './registry.js';

const context: StrategyContext = {
  signal: new AbortController().signal,
  tenantId: 'tenant-test',
  sessionId: 'session-test',
  turnId: 'turn-test',
  stepId: 'step-test',
};

describe('built-in strategies', () => {
  it('stops on completion, failure, and the max-steps ceiling', async () => {
    const strategy = new MaxStepsStopStrategy();
    await strategy.init({ maxSteps: 2 }, {});

    await expect(
      strategy.apply(
        { completedSteps: 0, lastStepOutcome: undefined, lastStepHadToolCalls: false },
        context,
      ),
    ).resolves.toEqual({ stop: false });
    await expect(
      strategy.apply(
        { completedSteps: 1, lastStepOutcome: 'completed', lastStepHadToolCalls: false },
        context,
      ),
    ).resolves.toEqual({ stop: true, reason: 'completed' });
    await expect(
      strategy.apply(
        { completedSteps: 2, lastStepOutcome: 'completed', lastStepHadToolCalls: true },
        context,
      ),
    ).resolves.toEqual({ stop: true, reason: 'max-steps' });
    await expect(
      strategy.apply(
        { completedSteps: 1, lastStepOutcome: 'tool-error', lastStepHadToolCalls: false },
        context,
      ),
    ).resolves.toEqual({ stop: true, reason: 'tool-error' });
    expect(strategy.metrics()).toEqual({ evaluations: 4, stops: 3 });
  });

  it('continues after a successful tool step before the ceiling', async () => {
    const strategy = new MaxStepsStopStrategy();
    await strategy.init({ maxSteps: 3 }, {});

    await expect(
      strategy.apply(
        { completedSteps: 1, lastStepOutcome: 'completed', lastStepHadToolCalls: true },
        context,
      ),
    ).resolves.toEqual({ stop: false });
  });

  it('keeps none compaction inert and compacts a sliding-window prefix', async () => {
    const none = new NoneCompactionStrategy();
    await none.init(undefined, {});
    await expect(none.apply({ entries: [] }, context)).resolves.toEqual({ apply: false });

    const sliding = new SlidingWindowCompactionStrategy();
    await sliding.init({ maxEntries: 2, separator: ' | ' }, {});
    await expect(
      sliding.apply(
        {
          entries: [
            { sourceSeq: 1, content: 'one' },
            { sourceSeq: 3, content: 'two' },
            { sourceSeq: 7, content: 'three' },
            { sourceSeq: 9, content: 'four' },
          ],
        },
        context,
      ),
    ).resolves.toEqual({
      apply: true,
      summary: 'one | two',
      dropped: { fromSeq: 1, toSeq: 3 },
    });
    expect(sliding.metrics()).toEqual({
      applications: 1,
      compactions: 1,
      compactedEntries: 2,
    });
  });

  it('allows all or evaluates first-match parsed policy rules without IO', async () => {
    const input = {
      tool: 'write-file',
      groups: ['filesystem'],
      permission: { kind: 'write' },
      args: { path: 'README.md' },
    } as const;
    const allowAll = new AllowAllPermissionStrategy();
    await allowAll.init(undefined, {});
    await expect(allowAll.apply(input, context)).resolves.toEqual({
      decision: 'allow',
      reason: 'allow-all',
    });

    const policy = new PolicyFilePermissionStrategy();
    await policy.init(
      {
        defaultDecision: 'allow',
        rules: [
          { permissionKind: 'write', decision: 'deny' },
          { tool: 'write-file', decision: 'allow' },
        ],
      },
      {},
    );
    await expect(policy.apply(input, context)).resolves.toEqual({
      decision: 'deny',
      reason: 'policy-rule',
    });
    expect(policy.metrics()).toEqual({ allowed: 0, denied: 1 });
  });

  it('returns exponential delay decisions without sleeping', async () => {
    const strategy = new ExponentialBackoffRetryStrategy();
    await strategy.init(
      { maxAttempts: 4, initialDelayMs: 100, multiplier: 3, maxDelayMs: 500 },
      {},
    );

    await expect(
      strategy.apply({ attempt: 1, operation: 'tool', error: new Error('one') }, context),
    ).resolves.toEqual({ retry: true, delayMs: 100 });
    await expect(
      strategy.apply({ attempt: 2, operation: 'recovery', error: new Error('two') }, context),
    ).resolves.toEqual({ retry: true, delayMs: 300 });
    await expect(
      strategy.apply({ attempt: 3, operation: 'model', error: new Error('three') }, context),
    ).resolves.toEqual({ retry: true, delayMs: 500 });
    await expect(
      strategy.apply({ attempt: 4, operation: 'tool', error: new Error('four') }, context),
    ).resolves.toEqual({ retry: false, delayMs: 0 });
    expect(strategy.metrics()).toEqual({ evaluations: 4, retries: 3, exhausted: 1 });
  });

  it('keeps checkpoint none replaceable and checks cancellation in every apply', async () => {
    const checkpoint = new NoneCheckpointStrategy();
    await checkpoint.init(undefined, {});
    await expect(
      checkpoint.apply({ completedSteps: 1, eventsSinceCheckpoint: 10 }, context),
    ).resolves.toEqual({ checkpoint: false });

    const controller = new AbortController();
    const reason = new Error('strategy cancelled');
    controller.abort(reason);
    await expect(
      checkpoint.apply(
        { completedSteps: 1, eventsSinceCheckpoint: 10 },
        { ...context, signal: controller.signal },
      ),
    ).rejects.toBe(reason);
  });

  it('rejects invalid strategy configuration and uninitialized apply', async () => {
    const maxSteps = new MaxStepsStopStrategy();
    await expect(maxSteps.init({ maxSteps: 0 }, {})).rejects.toBeInstanceOf(StrategyConfigError);

    const retry = new ExponentialBackoffRetryStrategy();
    await expect(
      retry.apply({ attempt: 1, operation: 'tool', error: null }, context),
    ).rejects.toBeInstanceOf(StrategyConfigError);

    const policy = new PolicyFilePermissionStrategy();
    await expect(
      policy.init({ defaultDecision: 'deny', rules: [{ decision: 'allow' }] }, {}),
    ).rejects.toBeInstanceOf(StrategyConfigError);
  });

  it('creates a registry containing every built-in strategy', () => {
    const registry = createDefaultStrategyRegistry();

    expect(registry.resolve('stop', 'max-steps')).toBeInstanceOf(MaxStepsStopStrategy);
    expect(registry.resolve('compaction', 'none')).toBeInstanceOf(NoneCompactionStrategy);
    expect(registry.resolve('compaction', 'sliding-window')).toBeInstanceOf(
      SlidingWindowCompactionStrategy,
    );
    expect(registry.resolve('permission', 'allow-all')).toBeInstanceOf(AllowAllPermissionStrategy);
    expect(registry.resolve('permission', 'policy-file')).toBeInstanceOf(
      PolicyFilePermissionStrategy,
    );
    expect(registry.resolve('retry', 'exponential-backoff')).toBeInstanceOf(
      ExponentialBackoffRetryStrategy,
    );
    expect(registry.resolve('checkpoint', 'none')).toBeInstanceOf(NoneCheckpointStrategy);
  });
});
