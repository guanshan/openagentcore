import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent, ModelUsage } from '../events/types.js';
import { EchoTool } from '../tools/tool.js';
import {
  CostAccountingError,
  createCostAccountingMiddleware,
  MiddlewareNextError,
  MiddlewarePipeline,
  MiddlewareRegistry,
  type EventMiddlewareContext,
  type MiddlewareBaseContext,
} from './middleware.js';

interface TestContext {
  value: string;
}

const baseContext: MiddlewareBaseContext = {
  signal: new AbortController().signal,
  tenantId: 'tenant-test',
  sessionId: 'session-test',
  turnId: 'turn-1',
  stepId: 'step-1',
};

describe('MiddlewarePipeline', () => {
  it('runs in registration order with onion nesting', async () => {
    const calls: string[] = [];
    const pipeline = new MiddlewarePipeline<TestContext>()
      .use(async (_context, next) => {
        calls.push('one:before');
        await next();
        calls.push('one:after');
      })
      .use(async (_context, next) => {
        calls.push('two:before');
        await next();
        calls.push('two:after');
      });

    await pipeline.run({ value: 'initial' }, async () => {
      calls.push('terminal');
    });

    expect(calls).toEqual(['one:before', 'two:before', 'terminal', 'two:after', 'one:after']);
  });

  it('short-circuits when middleware omits next', async () => {
    const terminal = vi.fn();
    const later = vi.fn();
    const context = { value: 'initial' };
    const pipeline = new MiddlewarePipeline<TestContext>()
      .use(async (current) => {
        current.value = 'short-circuited';
      })
      .use(later);

    await pipeline.run(context, terminal);

    expect(context.value).toBe('short-circuited');
    expect(later).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
  });

  it('propagates downstream exceptions through upstream middleware', async () => {
    const error = new Error('downstream failed');
    const observed: unknown[] = [];
    const pipeline = new MiddlewarePipeline<TestContext>().use(async (_context, next) => {
      try {
        await next();
      } catch (caught) {
        observed.push(caught);
        throw caught;
      }
    });

    await expect(
      pipeline.run({ value: 'initial' }, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(observed).toEqual([error]);
  });

  it('rejects calling next more than once', async () => {
    const pipeline = new MiddlewarePipeline<TestContext>().use(async (_context, next) => {
      await next();
      await next();
    });

    await expect(pipeline.run({ value: 'initial' })).rejects.toBeInstanceOf(MiddlewareNextError);
  });
});

describe('MiddlewareRegistry', () => {
  it('provides typed model, tool, context, memory, and event pipelines', async () => {
    const registry = new MiddlewareRegistry()
      .use('model', async (context, next) => {
        context.request = {
          ...context.request,
          messages: [...context.request.messages, { role: 'system', content: 'model-mw' }],
        };
        await next();
      })
      .use('tool', async (context) => {
        context.result = { intercepted: context.request.callId };
      })
      .use('context', async (context, next) => {
        context.messages.push({ role: 'user', content: 'context-mw' });
        await next();
      })
      .use('memory', async (context, next) => {
        context.value = { remembered: true };
        await next();
      })
      .use('event', async (context, next) => {
        if (context.event.type === 'turn.finished') {
          context.event = { ...context.event, stopReason: 'event-mw' };
        }
        await next();
      });

    const modelContext = {
      ...baseContext,
      request: { messages: [], tools: [], toolUse: 'none' } as const,
      chunks: [],
    };
    await registry.run('model', modelContext);
    expect(modelContext.request.messages).toEqual([{ role: 'system', content: 'model-mw' }]);

    const toolContext = {
      ...baseContext,
      tool: new EchoTool(),
      request: { callId: 'call-1', args: null, attempt: 1 },
      result: undefined,
      error: undefined,
    };
    await registry.run('tool', toolContext);
    expect(toolContext.result).toEqual({ intercepted: 'call-1' });

    const contextContext = {
      ...baseContext,
      messages: [],
      tools: [],
      capabilityDowngrades: [],
    };
    await registry.run('context', contextContext);
    expect(contextContext.messages).toEqual([{ role: 'user', content: 'context-mw' }]);

    const memoryContext = {
      ...baseContext,
      operation: 'read' as const,
      key: 'session',
      value: undefined,
    };
    await registry.run('memory', memoryContext);
    expect(memoryContext.value).toEqual({ remembered: true });

    const eventContext = createEventContext(turnFinished(10));
    await registry.run('event', eventContext);
    expect(eventContext.event).toMatchObject({ stopReason: 'event-mw' });
  });
});

describe('cost accounting middleware', () => {
  it('accumulates step tokens and same-currency cost into turn.finished', async () => {
    const registry = new MiddlewareRegistry().use('event', createCostAccountingMiddleware());
    const first = createEventContext(
      stepFinished(1, { inputTokens: 10, outputTokens: 2, totalTokens: 12, cost: usd(0.1) }),
    );
    const second = createEventContext(
      stepFinished(2, { inputTokens: 4, outputTokens: 6, totalTokens: 10, cost: usd(0.2) }),
    );
    await registry.run('event', first);
    await registry.run('event', second);

    const finished = createEventContext(turnFinished(3));
    await registry.run('event', finished);

    expect(finished.event).toMatchObject({
      type: 'turn.finished',
      usage: {
        inputTokens: 14,
        outputTokens: 8,
        totalTokens: 22,
        cost: { amount: 0.30000000000000004, currency: 'USD' },
      },
    });
  });

  it('does not count a step rejected by downstream middleware', async () => {
    const accounting = createCostAccountingMiddleware();
    const rejected = new Error('append rejected');
    const rejectedContext = createEventContext(
      stepFinished(1, { inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
    );
    rejectedContext.persisted = false;
    setPersistedEvent(rejectedContext, undefined);
    await expect(
      accounting(rejectedContext, async () => {
        throw rejected;
      }),
    ).rejects.toBe(rejected);

    const finished = createEventContext(turnFinished(2));
    await accounting(finished, async () => {});
    expect(finished.event).toMatchObject({
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
  });

  it('counts a step persisted before downstream middleware throws', async () => {
    const accounting = createCostAccountingMiddleware();
    const persisted = createEventContext(
      stepFinished(1, { inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
    );
    persisted.persisted = false;
    setPersistedEvent(persisted, undefined);
    const downstream = new Error('after append');

    await expect(
      accounting(persisted, async () => {
        persisted.persisted = true;
        setPersistedEvent(persisted, persisted.event);
        persisted.event = stepFinished(1, {
          inputTokens: 999,
          outputTokens: 999,
          totalTokens: 1_998,
        });
        throw downstream;
      }),
    ).rejects.toBe(downstream);

    const finished = createEventContext(turnFinished(2));
    await accounting(finished, async () => {});
    expect(finished.event).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
  });

  it('does not count a step when the event pipeline short-circuits before append', async () => {
    const accounting = createCostAccountingMiddleware();
    const skipped = createEventContext(
      stepFinished(1, { inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
    );
    skipped.persisted = false;
    setPersistedEvent(skipped, undefined);
    await accounting(skipped, async () => {});

    const finished = createEventContext(turnFinished(2));
    await accounting(finished, async () => {});
    expect(finished.event).toMatchObject({
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
  });

  it('reports mixed currencies after the incompatible step is persisted', async () => {
    const accounting = createCostAccountingMiddleware();
    await accounting(
      createEventContext(
        stepFinished(1, { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: usd(1) }),
      ),
      async () => {},
    );
    const terminal = vi.fn();

    await expect(
      accounting(
        createEventContext(
          stepFinished(2, {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            cost: { amount: 1, currency: 'CNY' },
          }),
        ),
        terminal,
      ),
    ).rejects.toBeInstanceOf(CostAccountingError);
    expect(terminal).toHaveBeenCalledOnce();
  });
});

function createEventContext(event: AgentEvent): EventMiddlewareContext {
  return { ...baseContext, event, persisted: true, persistedEvent: event };
}

function setPersistedEvent(context: EventMiddlewareContext, event: AgentEvent | undefined): void {
  (context as { persistedEvent: AgentEvent | undefined }).persistedEvent = event;
}

function eventBase(seq: number) {
  return {
    seq,
    tenantId: 'tenant-test',
    sessionId: 'session-test',
    ts: '2026-08-11T00:00:00Z',
  } as const;
}

function stepFinished(seq: number, usage: ModelUsage): AgentEvent {
  return {
    ...eventBase(seq),
    type: 'step.finished',
    turnId: 'turn-1',
    stepId: `step-${seq}`,
    outcome: 'succeeded',
    usage,
  };
}

function turnFinished(seq: number): AgentEvent {
  return {
    ...eventBase(seq),
    type: 'turn.finished',
    turnId: 'turn-1',
    stopReason: 'completed',
  };
}

function usd(amount: number) {
  return { amount, currency: 'USD' } as const;
}
