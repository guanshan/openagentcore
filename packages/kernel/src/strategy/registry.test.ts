import { describe, expect, it } from 'vitest';

import {
  StrategyRegistry,
  StrategyRegistryError,
  type KernelPorts,
  type Strategy,
  type StrategyContext,
} from './registry.js';

const context: StrategyContext = {
  signal: new AbortController().signal,
  tenantId: 'tenant-test',
  sessionId: 'session-test',
  turnId: 'turn-test',
  stepId: undefined,
};

describe('StrategyRegistry', () => {
  it('registers, resolves, and initializes an external strategy by kind and name', async () => {
    let initializedWith: { config: { prefix: string }; ports: KernelPorts } | undefined;
    let applications = 0;
    const external: Strategy<string, string, { prefix: string }> = {
      kind: 'external-kind',
      name: 'prefix',
      async init(config, ports) {
        initializedWith = { config, ports };
      },
      async apply(input, applyContext) {
        applyContext.signal.throwIfAborted();
        applications += 1;
        return `${initializedWith?.config.prefix ?? ''}${input}`;
      },
      metrics() {
        return { applications };
      },
    };
    const ports: KernelPorts = {};
    const registry = new StrategyRegistry().register(external);

    const selected = await registry.init<string, string, { prefix: string }>(
      'external-kind',
      'prefix',
      { prefix: 'selected:' },
      ports,
    );

    await expect(selected.apply('value', context)).resolves.toBe('selected:value');
    expect(initializedWith).toEqual({ config: { prefix: 'selected:' }, ports });
    expect(registry.metrics()).toEqual([
      { kind: 'external-kind', name: 'prefix', metrics: { applications: 1 } },
    ]);
  });

  it('rejects duplicate registrations and missing resolutions', () => {
    const strategy: Strategy<unknown, unknown> = {
      kind: 'stop',
      name: 'custom',
      async init() {},
      async apply(input) {
        return input;
      },
    };
    const registry = new StrategyRegistry().register(strategy);

    expect(() => registry.register(strategy)).toThrow(StrategyRegistryError);
    expect(() => registry.resolve('stop', 'missing')).toThrow(StrategyRegistryError);
  });
});
