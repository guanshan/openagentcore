import { describe, expect, it } from 'vitest';

import { InMemoryEventLog } from '../events/event-log.js';
import { projectMessageHistory } from '../events/projection.js';
import { assertSchemaValidEvent } from '../events/schema.test-support.js';
import type { AgentEvent, JsonObject, JsonValue } from '../events/types.js';
import { ScriptedModelPort, type ModelChunk } from '../ports/model.js';
import {
  type CheckpointDecision,
  type CheckpointStrategyInput,
  createDefaultStrategyRegistry,
  type StopDecision,
  type StopStrategyInput,
} from '../strategy/builtins.js';
import type { KernelPorts, Strategy, StrategyContext } from '../strategy/registry.js';
import { EchoTool, FailingTool, SlowTool, ToolRegistry, type Tool } from '../tools/tool.js';
import { AgentLoop, AgentLoopCrashError, PROMPTED_TOOL_CALL_PREFIX } from './agent-loop.js';
import { projectSessionState } from './session-state.js';

const timestamp = '2026-08-11T00:00:00Z';

describe('AgentLoop', () => {
  it('runs a zero-tool turn and records aggregate usage', async () => {
    const model = new ScriptedModelPort([
      [
        { kind: 'text', text: 'Hello.' },
        { kind: 'usage', usage: usage(3, 2, 0.01) },
        { kind: 'finish', reason: 'stop' },
      ],
    ]);
    const { loop, log } = createLoop(model);

    const result = await loop.runTurn({ content: 'Say hello.' });

    expect(result.stopReason).toBe('completed');
    expect(result.usage).toEqual(usage(3, 2, 0.01));
    expect(result.history).toContainEqual({
      kind: 'message',
      role: 'assistant',
      stepId: 'turn-0:step:1',
      content: 'Hello.',
      sourceSeqs: [3],
    });
    await expectClosedAndSchemaValid(log, 'done');
  });

  it('keeps event sequence and identity authoritative across event middleware', async () => {
    const model = new ScriptedModelPort([
      [
        { kind: 'text', text: 'Stable envelope.' },
        { kind: 'finish', reason: 'stop' },
      ],
    ]);
    const { loop, log } = createLoop(model);
    loop.use('event', async (context, next) => {
      context.event = {
        ...context.event,
        seq: 999,
        tenantId: 'middleware-tenant',
        sessionId: 'middleware-session',
        ts: '1900-01-01T00:00:00Z',
      };
      await next();
    });

    await loop.runTurn({ content: 'Preserve the envelope.' });

    const events = await readEvents(log);
    expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index));
    expect(events.every((event) => event.tenantId === 'tenant-test')).toBe(true);
    expect(events.every((event) => event.sessionId === 'session-default')).toBe(true);
    expect(events.every((event) => event.ts === timestamp)).toBe(true);
  });

  it('accounts from the persisted snapshot when middleware edits context after append', async () => {
    const model = new ScriptedModelPort([
      [
        { kind: 'text', text: 'Persisted usage.' },
        { kind: 'usage', usage: usage(2, 1, 0.01) },
        { kind: 'finish', reason: 'stop' },
      ],
    ]);
    const { loop } = createLoop(model);
    loop.use('event', async (context, next) => {
      await next();
      if (context.event.type === 'step.finished') {
        context.event = {
          ...context.event,
          usage: usage(999, 999, 99),
        };
      }
    });

    const result = await loop.runTurn({ content: 'Keep persisted accounting.' });

    expect(result.usage).toEqual(usage(2, 1, 0.01));
  });

  it('closes a persisted turn when event middleware throws after append', async () => {
    const failure = new Error('after turn.started append');
    const model = new ScriptedModelPort([]);
    const { loop, log } = createLoop(model);
    loop.use('event', async (context, next) => {
      await next();
      if (context.event.type === 'turn.started') {
        throw failure;
      }
    });

    await expect(loop.runTurn({ content: 'Start then fail.' })).rejects.toBe(failure);
    await expectClosedAndSchemaValid(log, 'failed');
  });

  it('runs a native tool call and gives its result to the next model step', async () => {
    const model = new ScriptedModelPort([
      [
        toolCall('call-1', 'echo', { text: 'ping' }),
        { kind: 'usage', usage: usage(4, 1, 0.02) },
        { kind: 'finish', reason: 'tool-calls' },
      ],
      [
        { kind: 'text', text: 'Echo complete.' },
        { kind: 'usage', usage: usage(7, 2, 0.03) },
        { kind: 'finish', reason: 'stop' },
      ],
    ]);
    const tools = new ToolRegistry().register(new EchoTool(), { groups: ['safe'] });
    const { loop, log } = createLoop(model, { tools });

    const result = await loop.runTurn({ content: 'Echo ping.' });

    expect(result.usage).toEqual(usage(11, 3, 0.05));
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]?.messages).toContainEqual({
      role: 'tool',
      content: '{"text":"ping"}',
      toolCallId: 'call-1',
    });
    expect(result.events.map((event) => event.type)).toEqual([
      'turn.started',
      'step.started',
      'model.request',
      'model.delta',
      'tool.call',
      'permission.requested',
      'permission.resolved',
      'tool.result',
      'step.finished',
      'step.started',
      'model.request',
      'model.delta',
      'step.finished',
      'turn.finished',
    ]);
    await expectClosedAndSchemaValid(log, 'done');
  });

  it('applies sliding-window compaction repeatedly across tool call and result content', async () => {
    const model = new ScriptedModelPort([
      [
        toolCall('call-compact', 'echo', { text: 'compact' }),
        { kind: 'finish', reason: 'tool-calls' },
      ],
      [
        { kind: 'text', text: 'Compaction complete.' },
        { kind: 'finish', reason: 'stop' },
      ],
    ]);
    const { loop, log } = createLoop(model, {
      tools: new ToolRegistry().register(new EchoTool()),
      strategies: {
        compaction: { use: 'sliding-window', config: { maxEntries: 1 } },
      },
    });

    const result = await loop.runTurn({ content: 'Compact tool history.' });
    const compactions = result.events.filter(
      (event): event is Extract<AgentEvent, { readonly type: 'compaction.applied' }> =>
        event.type === 'compaction.applied',
    );

    expect(compactions).toHaveLength(2);
    expect(compactions[0]?.summary).toContain('echo({"text":"compact"})');
    expect(compactions[1]?.summary).toContain('{"text":"compact"}');
    await expectClosedAndSchemaValid(log, 'done');
  });

  it('uses the prompted text protocol and records the capability downgrade', async () => {
    const prompted = `${PROMPTED_TOOL_CALL_PREFIX}${JSON.stringify({
      callId: 'call-prompted',
      tool: 'echo',
      args: { text: 'degraded' },
    })}`;
    const model = new ScriptedModelPort(
      [
        [
          { kind: 'text', text: prompted.slice(0, 7) },
          { kind: 'text', text: prompted.slice(7, 23) },
          { kind: 'text', text: prompted.slice(23) },
          { kind: 'finish', reason: 'tool-calls' },
        ],
        [
          { kind: 'text', text: 'Prompted call complete.' },
          { kind: 'finish', reason: 'stop' },
        ],
      ],
      { capabilities: { toolUse: 'prompted' } },
    );
    const { loop } = createLoop(model, {
      tools: new ToolRegistry().register(new EchoTool()),
    });

    const result = await loop.runTurn({ content: 'Use the tool.' });
    const requestEvent = result.events.find(
      (event): event is Extract<AgentEvent, { readonly type: 'model.request' }> =>
        event.type === 'model.request',
    );

    expect(requestEvent).toMatchObject({
      toolUse: 'prompted',
      capabilityDowngrades: ['tool-use:native->prompted'],
    });
    expect(model.requests[0]?.toolUse).toBe('prompted');
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool.result',
        callId: 'call-prompted',
        outcome: 'succeeded',
      }),
    );
  });

  it('persists steering injected during step 2 and includes it in step 3 context', async () => {
    const model = new ScriptedModelPort([
      [toolCall('call-1', 'echo', 1), { kind: 'finish', reason: 'tool-calls' }],
      [toolCall('call-2', 'echo', 2), { kind: 'finish', reason: 'tool-calls' }],
      [
        { kind: 'text', text: 'Steering observed.' },
        { kind: 'finish', reason: 'stop' },
      ],
    ]);
    const { loop } = createLoop(model, {
      tools: new ToolRegistry().register(new EchoTool()),
    });
    loop.use('model', async (context, next) => {
      if (context.stepId?.endsWith(':2') === true) {
        loop.steer({ content: 'Change direction.' });
      }
      await next();
    });

    const result = await loop.runTurn({ content: 'Start.' });
    const thirdStep = result.events.find(
      (event) => event.type === 'step.started' && event.stepIndex === 3,
    );

    expect(thirdStep).toMatchObject({
      injectedInputs: [{ content: 'Change direction.' }],
    });
    expect(model.requests[2]?.messages).toContainEqual({
      role: 'user',
      content: 'Change direction.',
    });
  });

  it('consumes steering when step.started persists before middleware throws', async () => {
    const failure = new Error('after step.started append');
    const model = new ScriptedModelPort([
      [
        { kind: 'text', text: 'Second turn.' },
        { kind: 'finish', reason: 'stop' },
      ],
    ]);
    const { loop } = createLoop(model);
    let failFirstStep = true;
    loop.use('event', async (context, next) => {
      await next();
      if (failFirstStep && context.event.type === 'step.started') {
        failFirstStep = false;
        throw failure;
      }
    });
    loop.steer({ content: 'Persist exactly once.' });

    await expect(loop.runTurn({ content: 'First turn.' })).rejects.toBe(failure);
    const result = await loop.runTurn({ content: 'Second turn.' });
    const secondTurnStep = result.events.find((event) => event.type === 'step.started');

    expect(secondTurnStep).toMatchObject({ injectedInputs: [] });
  });

  it('runs externally registered Strategy and Middleware through the full loop', async () => {
    const registry = createDefaultStrategyRegistry().register(new OneStepStopStrategy());
    const model = new ScriptedModelPort([
      [
        { kind: 'text', text: 'Base.' },
        { kind: 'finish', reason: 'stop' },
      ],
    ]);
    const { loop } = createLoop(model, {
      strategyRegistry: registry,
      strategies: { stop: { use: 'external-one-step' } },
    });
    loop.use('context', async (context, next) => {
      context.messages.push({ role: 'system', content: 'external-middleware' });
      await next();
    });

    const result = await loop.runTurn({ content: 'Run once.' });

    expect(result.stopReason).toBe('external-stop');
    expect(model.requests[0]?.messages).toContainEqual({
      role: 'system',
      content: 'external-middleware',
    });
    expect(loop.strategyMetrics()).toContainEqual({
      kind: 'stop',
      name: 'external-one-step',
      metrics: { evaluations: 2 },
    });
  });

  it('runs an externally registered checkpoint strategy after a completed step', async () => {
    const registry = createDefaultStrategyRegistry().register(new EveryStepCheckpointStrategy());
    const model = new ScriptedModelPort([
      [
        { kind: 'text', text: 'Checkpointed.' },
        { kind: 'finish', reason: 'stop' },
      ],
    ]);
    const { loop } = createLoop(model, {
      strategyRegistry: registry,
      strategies: { checkpoint: { use: 'external-every-step' } },
    });

    const result = await loop.runTurn({ content: 'Create a checkpoint marker.' });

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'checkpoint.created',
        snapshotRef: 'snapshot-step-1',
      }),
    );
  });

  it('records a failing tool result, closes the turn, and rethrows the tool error', async () => {
    const failure = new Error('boom');
    const model = new ScriptedModelPort([
      [toolCall('call-fail', 'failing', null), { kind: 'finish', reason: 'tool-calls' }],
    ]);
    const { loop, log } = createLoop(model, {
      tools: new ToolRegistry().register(new FailingTool(failure)),
    });

    await expect(loop.runTurn({ content: 'Fail.' })).rejects.toBe(failure);
    const failed = (await readEvents(log)).find((event) => event.type === 'tool.result');

    expect(failed).toMatchObject({
      outcome: 'failed',
      attempts: 1,
      error: { name: 'Error', message: 'boom' },
    });
    await expectClosedAndSchemaValid(log, 'failed');
  });

  it('does not retry a tool when event middleware throws after its result is persisted', async () => {
    const failure = new Error('after tool.result append');
    const tool = new EchoTool();
    const model = new ScriptedModelPort([
      [toolCall('call-once', 'echo', { value: 1 }), { kind: 'finish', reason: 'tool-calls' }],
    ]);
    const { loop, log } = createLoop(model, {
      tools: new ToolRegistry().register(tool),
    });
    loop.use('event', async (context, next) => {
      await next();
      if (context.event.type === 'tool.result' && context.event.outcome === 'succeeded') {
        throw failure;
      }
    });

    await expect(loop.runTurn({ content: 'Execute once.' })).rejects.toBe(failure);

    const events = await readEvents(log);
    expect(tool.requests).toHaveLength(1);
    expect(events.filter((event) => event.type === 'tool.result')).toHaveLength(1);
    await expectClosedAndSchemaValid(log, 'failed');
  });

  it('persists partial model output and closes the lifecycle when a stream fails', async () => {
    const interruption = new Error('model stream interrupted');
    const model = new ScriptedModelPort([
      {
        chunks: [{ kind: 'text', text: 'Partial.' }],
        error: interruption,
      },
    ]);
    const { loop, log } = createLoop(model);

    await expect(loop.runTurn({ content: 'Interrupt.' })).rejects.toBe(interruption);

    const events = await readEvents(log);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'model.delta',
        delta: { kind: 'text', text: 'Partial.' },
      }),
    );
    await expectClosedAndSchemaValid(log, 'failed');
  });

  it('conservatively fails an unfinished model-only step during crash recovery', async () => {
    const crash = new AgentLoopCrashError('model process lost');
    const log = new InMemoryEventLog(identity('model-crash'));
    const crashing = new AgentLoop({
      eventLog: log,
      model: new ScriptedModelPort([
        { chunks: [{ kind: 'text', text: 'Partial.' }], error: crash },
      ]),
      now: () => timestamp,
    });

    await expect(crashing.runTurn({ content: 'Crash the model.' })).rejects.toBe(crash);

    const resumed = new AgentLoop({
      eventLog: log,
      model: new ScriptedModelPort([]),
      now: () => timestamp,
    });
    const result = await resumed.resumeTurn();

    expect(result.stopReason).toBe('failed');
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'step.finished',
        outcome: 'failed',
      }),
    );
    await expectClosedAndSchemaValid(log, 'failed');
  });

  it('records a denied tool result and leaves no pending work', async () => {
    const model = new ScriptedModelPort([
      [toolCall('call-denied', 'echo', null), { kind: 'finish', reason: 'tool-calls' }],
    ]);
    const { loop, log } = createLoop(model, {
      tools: new ToolRegistry().register(new EchoTool()),
      strategies: {
        permission: {
          use: 'policy-file',
          config: { defaultDecision: 'deny', rules: [] },
        },
      },
    });

    const result = await loop.runTurn({ content: 'Denied.' });

    expect(result.stopReason).toBe('failed');
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool.result',
        callId: 'call-denied',
        outcome: 'denied',
      }),
    );
    await expectClosedAndSchemaValid(log, 'failed');
  });

  it('uses the persisted permission decision when event middleware tightens policy', async () => {
    const tool = new EchoTool();
    const model = new ScriptedModelPort([
      [toolCall('call-event-denied', 'echo', null), { kind: 'finish', reason: 'tool-calls' }],
    ]);
    const { loop, log } = createLoop(model, {
      tools: new ToolRegistry().register(tool),
    });
    loop.use('event', async (context, next) => {
      if (context.event.type === 'permission.resolved') {
        context.event = {
          ...context.event,
          decision: 'deny',
          reason: 'event-policy',
        };
      }
      await next();
    });

    const result = await loop.runTurn({ content: 'Apply event policy.' });

    expect(result.stopReason).toBe('failed');
    expect(tool.requests).toHaveLength(0);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'permission.resolved',
        decision: 'deny',
        reason: 'event-policy',
      }),
    );
    await expectClosedAndSchemaValid(log, 'failed');
  });

  it('stops at max-steps after a tool step', async () => {
    const model = new ScriptedModelPort([
      [toolCall('call-limit', 'echo', null), { kind: 'finish', reason: 'tool-calls' }],
    ]);
    const { loop } = createLoop(model, {
      tools: new ToolRegistry().register(new EchoTool()),
      strategies: { stop: { use: 'max-steps', config: { maxSteps: 1 } } },
    });

    const result = await loop.runTurn({ content: 'One step only.' });

    expect(result.stopReason).toBe('max-steps');
    expect(model.requests).toHaveLength(1);
  });

  it('propagates abort to a tool and atomically closes every pending lifecycle item', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel slow tool');
    const model = new ScriptedModelPort([
      [toolCall('call-slow', 'slow', null), { kind: 'finish', reason: 'tool-calls' }],
    ]);
    const { loop, log } = createLoop(model, {
      tools: new ToolRegistry().register(new SlowTool(10_000)),
    });
    loop.use('tool', async (_context, next) => {
      controller.abort(reason);
      await next();
    });

    await expect(
      loop.runTurn({ content: 'Run slowly.' }, { signal: controller.signal }),
    ).rejects.toBe(reason);

    await expectClosedAndSchemaValid(log, 'aborted');
  });

  it('recovers a multi-tool batch with stable callIds, usage, and uninterrupted history', async () => {
    const firstResponse: readonly ModelChunk[] = [
      toolCall('call-recover', 'work', { value: 42 }),
      toolCall('call-after', 'work', { value: 43 }),
      { kind: 'usage', usage: usage(5, 1, 0.02) },
      { kind: 'finish', reason: 'tool-calls' },
    ];
    const finalResponse: readonly ModelChunk[] = [
      { kind: 'text', text: 'Recovered.' },
      { kind: 'usage', usage: usage(3, 2, 0.03) },
      { kind: 'finish', reason: 'stop' },
    ];

    const uninterruptedModel = new ScriptedModelPort([firstResponse, finalResponse]);
    const uninterrupted = createLoop(uninterruptedModel, {
      tools: new ToolRegistry().register(new CrashOnceTool(false)),
      strategies: retryTwice(),
    });
    const expected = await uninterrupted.loop.runTurn({ content: 'Recover work.' });

    const log = new InMemoryEventLog(identity('recovery'));
    const crashingTool = new CrashOnceTool(true);
    const crashing = new AgentLoop({
      eventLog: log,
      model: new ScriptedModelPort([firstResponse]),
      tools: new ToolRegistry().register(crashingTool),
      strategies: retryTwice(),
      now: () => timestamp,
    });
    await expect(crashing.runTurn({ content: 'Recover work.' })).rejects.toBeInstanceOf(
      AgentLoopCrashError,
    );
    const interrupted = await projectSessionState(log.read(0));
    expect(interrupted.pendingToolCalls).toHaveLength(2);

    const resumed = new AgentLoop({
      eventLog: log,
      model: new ScriptedModelPort([finalResponse]),
      tools: new ToolRegistry().register(crashingTool),
      strategies: retryTwice(),
      now: () => timestamp,
    });
    const actual = await resumed.resumeTurn();

    expect(actual.history).toEqual(expected.history);
    expect(actual.usage).toEqual(expected.usage);
    expect(
      crashingTool.requests.map((request) => ({
        callId: request.callId,
        attempt: request.attempt,
      })),
    ).toEqual([
      { callId: 'call-recover', attempt: 1 },
      { callId: 'call-recover', attempt: 2 },
      { callId: 'call-after', attempt: 1 },
    ]);
    expect(
      actual.events.filter(
        (event) => event.type === 'tool.call' && event.callId === 'call-recover',
      ),
    ).toHaveLength(1);
    expect(
      actual.events.filter((event) => event.type === 'tool.call' && event.callId === 'call-after'),
    ).toHaveLength(1);
    await expectClosedAndSchemaValid(log, 'done');
  });

  it('marks an unknown recovered tool result failed when retry is exhausted', async () => {
    const log = new InMemoryEventLog(identity('recovery-failed'));
    const tool = new CrashOnceTool(true);
    const crashing = new AgentLoop({
      eventLog: log,
      model: new ScriptedModelPort([
        [toolCall('call-unknown', 'work', null), { kind: 'finish', reason: 'tool-calls' }],
      ]),
      tools: new ToolRegistry().register(tool),
      now: () => timestamp,
    });
    await expect(crashing.runTurn({ content: 'Crash.' })).rejects.toBeInstanceOf(
      AgentLoopCrashError,
    );

    const resumed = new AgentLoop({
      eventLog: log,
      model: new ScriptedModelPort([]),
      tools: new ToolRegistry().register(tool),
      now: () => timestamp,
    });
    const result = await resumed.resumeTurn();

    expect(result.stopReason).toBe('failed');
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool.result',
        callId: 'call-unknown',
        outcome: 'failed',
      }),
    );
    expect(tool.requests).toHaveLength(1);
  });
});

interface LoopOverrides {
  readonly tools?: ToolRegistry;
  readonly strategyRegistry?: ReturnType<typeof createDefaultStrategyRegistry>;
  readonly strategies?: ConstructorParameters<typeof AgentLoop>[0]['strategies'];
}

function createLoop(model: ScriptedModelPort, overrides: LoopOverrides = {}) {
  const log = new InMemoryEventLog(identity('default'));
  const loop = new AgentLoop({
    eventLog: log,
    model,
    ...(overrides.tools === undefined ? {} : { tools: overrides.tools }),
    ...(overrides.strategyRegistry === undefined
      ? {}
      : { strategyRegistry: overrides.strategyRegistry }),
    ...(overrides.strategies === undefined ? {} : { strategies: overrides.strategies }),
    now: () => timestamp,
    sleep: async (_delayMs, signal) => signal.throwIfAborted(),
  });
  return { loop, log };
}

function identity(suffix: string) {
  return {
    tenantId: 'tenant-test',
    sessionId: `session-${suffix}`,
  } as const;
}

function usage(inputTokens: number, outputTokens: number, amount?: number) {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(amount === undefined ? {} : { cost: { amount, currency: 'USD' } }),
  } as const;
}

function toolCall(callId: string, tool: string, args: JsonValue): ModelChunk {
  return { kind: 'tool-call', callId, tool, args };
}

function retryTwice() {
  return {
    retry: {
      use: 'exponential-backoff',
      config: { maxAttempts: 2, initialDelayMs: 0 },
    },
  } as const;
}

async function readEvents(log: InMemoryEventLog): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of log.read(0)) {
    events.push(assertSchemaValidEvent(event));
  }
  return events;
}

async function expectClosedAndSchemaValid(
  log: InMemoryEventLog,
  status: 'done' | 'failed' | 'aborted',
): Promise<void> {
  const events = await readEvents(log);
  const state = await projectSessionState(events);
  expect(state).toMatchObject({
    status,
    activeTurn: undefined,
    activeStep: undefined,
    pendingToolCalls: [],
    pendingPermissions: [],
  });
  await expect(projectMessageHistory(events)).resolves.toBeDefined();
}

class OneStepStopStrategy implements Strategy<StopStrategyInput, StopDecision, undefined> {
  readonly kind = 'stop';
  readonly name = 'external-one-step';
  #evaluations = 0;

  async init(config: undefined, ports: KernelPorts): Promise<void> {
    void config;
    void ports;
  }

  async apply(input: StopStrategyInput, context: StrategyContext): Promise<StopDecision> {
    context.signal.throwIfAborted();
    this.#evaluations += 1;
    return input.completedSteps === 0 ? { stop: false } : { stop: true, reason: 'external-stop' };
  }

  metrics() {
    return { evaluations: this.#evaluations };
  }
}

class EveryStepCheckpointStrategy implements Strategy<
  CheckpointStrategyInput,
  CheckpointDecision,
  undefined
> {
  readonly kind = 'checkpoint';
  readonly name = 'external-every-step';

  async init(config: undefined, ports: KernelPorts): Promise<void> {
    void config;
    void ports;
  }

  async apply(
    input: CheckpointStrategyInput,
    context: StrategyContext,
  ): Promise<CheckpointDecision> {
    context.signal.throwIfAborted();
    return { checkpoint: true, snapshotRef: `snapshot-step-${input.completedSteps}` };
  }
}

class CrashOnceTool implements Tool {
  readonly name = 'work';
  readonly inputSchema: JsonObject = { type: 'object', additionalProperties: true };
  readonly permission = { kind: 'write', description: 'Run recoverable work.' } as const;
  readonly requests: { callId: string; args: JsonValue; attempt: number }[] = [];
  #crash: boolean;

  constructor(crash: boolean) {
    this.#crash = crash;
  }

  async execute(
    request: { callId: string; args: JsonValue; attempt: number },
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    this.requests.push(structuredClone(request));
    if (this.#crash) {
      this.#crash = false;
      throw new AgentLoopCrashError('simulated process loss');
    }
    return structuredClone(request.args);
  }
}
