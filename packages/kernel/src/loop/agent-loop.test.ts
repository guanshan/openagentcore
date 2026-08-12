import { describe, expect, it } from 'vitest';

import { InMemoryEventLog } from '../events/event-log.js';
import { projectMessageHistory } from '../events/projection.js';
import { assertSchemaValidEvent } from '../events/schema.test-support.js';
import type { AgentEvent, JsonObject, JsonValue } from '../events/types.js';
import { ModelPortError, ScriptedModelPort, type ModelChunk } from '../ports/model.js';
import {
  type CheckpointDecision,
  type CheckpointStrategyInput,
  createDefaultStrategyRegistry,
  type StopDecision,
  type StopStrategyInput,
} from '../strategy/builtins.js';
import type { KernelPorts, Strategy, StrategyContext } from '../strategy/registry.js';
import {
  EchoTool,
  FailingTool,
  ResultFailingTool,
  SlowTool,
  ToolContractError,
  ToolRegistry,
  type Tool,
} from '../tools/tool.js';
import {
  AgentLoop,
  AgentLoopCrashError,
  AgentLoopInvariantError,
  PROMPTED_TOOL_CALL_PREFIX,
  PROMPTED_TOOL_RESULT_PREFIX,
} from './agent-loop.js';
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
      role: 'assistant',
      content: '',
      toolCalls: [{ callId: 'call-1', tool: 'echo', args: { text: 'ping' } }],
    });
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

  it('groups parallel native calls into one structured assistant message', async () => {
    const model = new ScriptedModelPort([
      [
        toolCall('call-a', 'echo', { value: 'a' }),
        toolCall('call-b', 'echo', { value: 'b' }),
        { kind: 'finish', reason: 'tool-calls' },
      ],
      [
        { kind: 'text', text: 'Both calls complete.' },
        { kind: 'finish', reason: 'stop' },
      ],
    ]);
    const { loop } = createLoop(model, {
      tools: new ToolRegistry().register(new EchoTool()),
    });

    await loop.runTurn({ content: 'Echo twice.' });

    expect(model.requests[1]?.messages).toContainEqual({
      role: 'assistant',
      content: '',
      toolCalls: [
        { callId: 'call-a', tool: 'echo', args: { value: 'a' } },
        { callId: 'call-b', tool: 'echo', args: { value: 'b' } },
      ],
    });
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
    expect(compactions.map((event) => event.strategy)).toEqual([
      'sliding-window',
      'sliding-window',
    ]);
    const preview = await loop.dryRunContext({ content: 'Inspect compacted context.' });
    expect(preview.assembly.stages).toContainEqual(
      expect.objectContaining({ stage: 'compaction', status: 'applied' }),
    );
    expect(preview.assembly.segments).toContainEqual(
      expect.objectContaining({
        source: expect.objectContaining({ kind: 'compaction', strategy: 'sliding-window' }),
      }),
    );
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
    expect(model.requests[0]?.messages[0]?.content).toContain('"name":"echo"');
    expect(model.requests[1]?.messages).toContainEqual({
      role: 'user',
      content: `${PROMPTED_TOOL_RESULT_PREFIX}${JSON.stringify({
        callId: 'call-prompted',
        result: { text: 'degraded' },
      })}`,
    });
    expect(model.requests[1]?.messages.some((message) => message.role === 'tool')).toBe(false);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool.result',
        callId: 'call-prompted',
        outcome: 'succeeded',
      }),
    );
  });

  it('restarts prompted tool-call buffering after an interrupted model attempt', async () => {
    const prompted = `${PROMPTED_TOOL_CALL_PREFIX}${JSON.stringify({
      callId: 'call-prompted-retry',
      tool: 'echo',
      args: { text: 'retried' },
    })}`;
    const tool = new EchoTool();
    const model = new ScriptedModelPort(
      [
        {
          chunks: [{ kind: 'text', text: prompted.slice(0, 5) }],
          error: new Error('prompted stream interrupted'),
        },
        [
          { kind: 'text', text: prompted },
          { kind: 'finish', reason: 'tool-calls' },
        ],
        [
          { kind: 'text', text: 'Prompted retry complete.' },
          { kind: 'finish', reason: 'stop' },
        ],
      ],
      { capabilities: { toolUse: 'prompted' } },
    );
    const { loop } = createLoop(model, {
      tools: new ToolRegistry().register(tool),
    });

    const result = await loop.runTurn({ content: 'Retry the prompted call.' });

    expect(result.stopReason).toBe('completed');
    expect(tool.requests.map((request) => request.callId)).toEqual(['call-prompted-retry']);
    expect(
      result.events.filter((event) => event.type === 'tool.call').map((event) => event.callId),
    ).toEqual(['call-prompted-retry']);
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
      strategies: {
        retry: {
          use: 'exponential-backoff',
          config: { maxAttempts: 1, initialDelayMs: 0, exhaustedAction: 'fail-turn' },
        },
      },
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

  it('reports malformed tool results with the tool name and does not enter retry', async () => {
    const invalidTool = {
      name: 'bad',
      inputSchema: { type: 'object' },
      permission: { kind: 'none' },
      execute: async () => ({ result: { unexpected: true } }) as never,
    } satisfies Tool;
    const model = new ScriptedModelPort([
      [toolCall('call-bad', 'bad', null), { kind: 'finish', reason: 'tool-calls' }],
    ]);
    const { loop } = createLoop(model, {
      tools: new ToolRegistry().register(invalidTool),
    });

    let contractError: unknown;
    try {
      await loop.runTurn({ content: 'Call the malformed tool.' });
    } catch (error) {
      contractError = error;
    }
    expect(contractError).toBeInstanceOf(ToolContractError);
    expect(contractError).toEqual(
      expect.objectContaining({
        message: 'Tool "bad" must return { outcome, result }, received object without "outcome".',
      }),
    );
    expect(loop.strategyMetrics()).toContainEqual({
      kind: 'retry',
      name: 'exponential-backoff',
      metrics: { evaluations: 0, retries: 0, exhausted: 0 },
    });
  });

  it('feeds back an exhausted execution failure so the model can choose another tool', async () => {
    const failure = new Error('compiler unavailable');
    const failing = new FailingTool(failure);
    const echo = new EchoTool();
    const model = new ScriptedModelPort([
      [toolCall('call-compile-1', 'failing', null), { kind: 'finish', reason: 'tool-calls' }],
      [toolCall('call-compile-2', 'failing', null), { kind: 'finish', reason: 'tool-calls' }],
      [
        toolCall('call-fallback', 'echo', { path: 'fallback' }),
        { kind: 'finish', reason: 'tool-calls' },
      ],
      [
        { kind: 'text', text: 'Completed with the fallback.' },
        { kind: 'finish', reason: 'stop' },
      ],
    ]);
    const { loop, log } = createLoop(model, {
      tools: new ToolRegistry().register(failing).register(echo),
    });

    const result = await loop.runTurn({ content: 'Complete the task.' });

    expect(result.stopReason).toBe('completed');
    expect(failing.requests.map((request) => request.attempt)).toEqual([1, 2, 1, 2]);
    expect(echo.requests).toHaveLength(1);
    expect(
      result.events.filter((event) => event.type === 'tool.result' && event.outcome === 'failed'),
    ).toEqual([
      expect.objectContaining({ callId: 'call-compile-1', attempts: 2 }),
      expect.objectContaining({ callId: 'call-compile-2', attempts: 2 }),
    ]);
    expect(model.requests[2]?.messages).toContainEqual({
      role: 'tool',
      content: JSON.stringify({
        error: { name: 'Error', message: 'compiler unavailable' },
      }),
      toolCallId: 'call-compile-2',
    });
    expect(result.events).toContainEqual({
      type: 'tool.call',
      seq: expect.any(Number),
      tenantId: 'tenant-test',
      sessionId: 'session-default',
      ts: timestamp,
      stepId: 'turn-0:step:3',
      callId: 'call-fallback',
      tool: 'echo',
      args: { path: 'fallback' },
      modelUsage: expect.any(Object),
    });
    await expectClosedAndSchemaValid(log, 'done');
  });

  it('feeds a completed failed result to the model without retrying or failing the turn', async () => {
    const failedResult = { exitCode: 1, stderr: 'tests failed' } as const;
    const tool = new ResultFailingTool(failedResult);
    const model = new ScriptedModelPort([
      [
        toolCall('call-result-fail', 'result-failing', null),
        { kind: 'finish', reason: 'tool-calls' },
      ],
      [
        { kind: 'text', text: 'Adjusted after the test failure.' },
        { kind: 'finish', reason: 'stop' },
      ],
    ]);
    const { loop } = createLoop(model, {
      tools: new ToolRegistry().register(tool),
    });

    const result = await loop.runTurn({ content: 'Run the tests.' });

    expect(result.stopReason).toBe('completed');
    expect(tool.requests).toHaveLength(1);
    const failureEvent = result.events.find(
      (event) => event.type === 'tool.result' && event.callId === 'call-result-fail',
    );
    expect(failureEvent).toMatchObject({ outcome: 'failed', result: failedResult });
    expect(failureEvent).not.toHaveProperty('error');
    expect(model.requests[1]?.messages).toContainEqual({
      role: 'tool',
      content: JSON.stringify(failedResult),
      toolCallId: 'call-result-fail',
    });
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
    const { loop, log } = createLoop(model, {
      strategies: {
        retry: {
          use: 'exponential-backoff',
          config: { maxAttempts: 1, initialDelayMs: 0, exhaustedAction: 'fail-turn' },
        },
      },
    });

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

  it('treats a content-filter finish as a non-retryable model failure', async () => {
    const model = new ScriptedModelPort([[{ kind: 'finish', reason: 'content-filter' }]]);
    const { loop, log } = createLoop(model);

    let failure: unknown;
    try {
      await loop.runTurn({ content: 'Blocked request.' });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ModelPortError);
    expect(failure).toMatchObject({ kind: 'content-filter', retryable: false });
    expect(model.requests).toHaveLength(1);
    expect(loop.strategyMetrics()).toContainEqual({
      kind: 'retry',
      name: 'exponential-backoff',
      metrics: { evaluations: 1, retries: 0, exhausted: 1 },
    });
    await expectClosedAndSchemaValid(log, 'failed');
  });

  it('retries an interrupted model stream without duplicating a rechunked text prefix', async () => {
    const interruption = new Error('transient model stream failure');
    const model = new ScriptedModelPort([
      {
        chunks: [
          { kind: 'text', text: 'Par' },
          { kind: 'text', text: 'tial ' },
        ],
        error: interruption,
      },
      [
        { kind: 'text', text: 'Partial' },
        { kind: 'text', text: ' answer.' },
        { kind: 'usage', usage: usage(5, 2) },
        { kind: 'finish', reason: 'stop' },
      ],
    ]);
    const { loop, log } = createLoop(model, { modelStreamRetryMode: 'strict-prefix' });

    const result = await loop.runTurn({ content: 'Retry the model.' });

    expect(result.stopReason).toBe('completed');
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]).toEqual(model.requests[0]);
    expect(result.history).toContainEqual({
      kind: 'message',
      role: 'assistant',
      stepId: 'turn-0:step:1',
      content: 'Partial answer.',
      sourceSeqs: [3, 4, 5],
    });
    const events = await readEvents(log);
    const requestEvent = events.find(
      (event): event is Extract<AgentEvent, { readonly type: 'model.request' }> =>
        event.type === 'model.request',
    );
    expect(events.filter((event) => event.type === 'model.request')).toHaveLength(1);
    expect(requestEvent).toBeDefined();
    expect(
      events
        .filter((event) => event.type === 'model.delta')
        .every((event) => event.requestId === requestEvent?.requestId),
    ).toBe(true);
    expect(
      events.flatMap((event) =>
        event.type === 'model.delta' && event.delta.kind === 'text' ? [event.delta.text] : [],
      ),
    ).toEqual(['Par', 'tial ', 'answer.']);
    await expectClosedAndSchemaValid(log, 'done');
  });

  it('discards a divergent partial attempt and completes the turn by default', async () => {
    const model = new ScriptedModelPort([
      {
        chunks: [{ kind: 'text', text: 'The answer is ' }],
        error: new Error('connection reset'),
      },
      [
        { kind: 'text', text: 'The answer would be 42.' },
        { kind: 'finish', reason: 'stop' },
      ],
    ]);
    const { loop, log } = createLoop(model);

    const result = await loop.runTurn({ content: 'Answer the question.' });

    expect(result.stopReason).toBe('completed');
    expect(result.history).toContainEqual(
      expect.objectContaining({
        kind: 'message',
        role: 'assistant',
        content: 'The answer would be 42.',
      }),
    );
    const events = await readEvents(log);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'model.attempt.discarded',
        reason: 'provider-failure',
        discarded: { fromSeq: 3, toSeq: 3 },
      }),
    );
    expect(
      events.flatMap((event) =>
        event.type === 'model.delta' && event.delta.kind === 'text' ? [event.delta.text] : [],
      ),
    ).toEqual(['The answer is ', 'The answer would be 42.']);
    await expectClosedAndSchemaValid(log, 'done');
  });

  it('retries token counting before opening a model stream', async () => {
    const countFailure = new Error('transient token counter failure');
    const model = new ScriptedModelPort(
      [
        [
          { kind: 'text', text: 'Counted after retry.' },
          { kind: 'finish', reason: 'stop' },
        ],
      ],
      { tokenCounts: [countFailure, 7] },
    );
    const { loop, log } = createLoop(model);

    const result = await loop.runTurn({ content: 'Retry token counting.' });

    expect(result.stopReason).toBe('completed');
    expect(model.tokenCountRequests).toHaveLength(2);
    expect(model.requests).toHaveLength(1);
    expect((await readEvents(log)).filter((event) => event.type === 'model.request')).toHaveLength(
      1,
    );
  });

  it('does not retry an error raised by model middleware after the Port completes', async () => {
    const middlewareFailure = new Error('model middleware failed after next');
    const model = new ScriptedModelPort([
      [
        { kind: 'text', text: 'Persisted once.' },
        { kind: 'finish', reason: 'stop' },
      ],
      [{ kind: 'finish', reason: 'stop' }],
    ]);
    const { loop } = createLoop(model);
    loop.use('model', async (_context, next) => {
      await next();
      throw middlewareFailure;
    });

    await expect(loop.runTurn({ content: 'Do not retry middleware.' })).rejects.toBe(
      middlewareFailure,
    );

    expect(model.requests).toHaveLength(1);
    expect(loop.strategyMetrics()).toContainEqual({
      kind: 'retry',
      name: 'exponential-backoff',
      metrics: { evaluations: 0, retries: 0, exhausted: 0 },
    });
  });

  it('does not retry an event middleware error after a model delta is persisted', async () => {
    const middlewareFailure = new Error('event middleware failed after model.delta');
    const model = new ScriptedModelPort([
      [
        { kind: 'text', text: 'Persisted once.' },
        { kind: 'finish', reason: 'stop' },
      ],
      [{ kind: 'finish', reason: 'stop' }],
    ]);
    const { loop, log } = createLoop(model);
    loop.use('event', async (context, next) => {
      await next();
      if (context.event.type === 'model.delta') {
        throw middlewareFailure;
      }
    });

    await expect(loop.runTurn({ content: 'Do not retry event middleware.' })).rejects.toBe(
      middlewareFailure,
    );

    expect(model.requests).toHaveLength(1);
    expect((await readEvents(log)).filter((event) => event.type === 'model.delta')).toHaveLength(1);
    expect(loop.strategyMetrics()).toContainEqual({
      kind: 'retry',
      name: 'exponential-backoff',
      metrics: { evaluations: 0, retries: 0, exhausted: 0 },
    });
  });

  it('deduplicates tool calls when a model stream retry extends the durable prefix', async () => {
    const interruption = new Error('retry tool response');
    const tool = new EchoTool();
    const first = toolCall('call-model-a', 'echo', { value: 1 });
    const second = toolCall('call-model-b', 'echo', { value: 2 });
    const model = new ScriptedModelPort([
      { chunks: [first], error: interruption },
      [first, second, { kind: 'finish', reason: 'tool-calls' }],
      [
        { kind: 'text', text: 'Both calls completed.' },
        { kind: 'finish', reason: 'stop' },
      ],
    ]);
    const { loop } = createLoop(model, {
      tools: new ToolRegistry().register(tool),
      modelStreamRetryMode: 'strict-prefix',
    });

    const result = await loop.runTurn({ content: 'Use both calls.' });

    expect(result.stopReason).toBe('completed');
    expect(tool.requests.map((request) => request.callId)).toEqual([
      'call-model-a',
      'call-model-b',
    ]);
    expect(
      result.events.filter((event) => event.type === 'tool.call').map((event) => event.callId),
    ).toEqual(['call-model-a', 'call-model-b']);
    expect(
      result.events.filter((event) => event.type === 'model.delta' && event.delta.kind === 'tool'),
    ).toHaveLength(2);
  });

  it('fails closed when a retried model stream changes a durable tool call', async () => {
    const interruption = new Error('retry changed tool call');
    const tool = new EchoTool();
    const model = new ScriptedModelPort([
      {
        chunks: [toolCall('call-model-diverged', 'echo', { value: 1 })],
        error: interruption,
      },
      [
        toolCall('call-model-diverged', 'echo', { value: 2 }),
        { kind: 'finish', reason: 'tool-calls' },
      ],
    ]);
    const { loop } = createLoop(model, {
      tools: new ToolRegistry().register(tool),
      modelStreamRetryMode: 'strict-prefix',
    });

    await expect(loop.runTurn({ content: 'Keep the call stable.' })).rejects.toBeInstanceOf(
      AgentLoopInvariantError,
    );

    expect(model.requests).toHaveLength(2);
    expect(tool.requests).toHaveLength(0);
    expect(loop.strategyMetrics()).toContainEqual({
      kind: 'retry',
      name: 'exponential-backoff',
      metrics: { evaluations: 1, retries: 1, exhausted: 0 },
    });
  });

  it('resumes an interrupted model-only step by discarding its persisted delta prefix', async () => {
    const crash = new AgentLoopCrashError('model process lost');
    const log = new InMemoryEventLog(identity('model-crash'));
    const firstModel = new ScriptedModelPort([
      { chunks: [{ kind: 'text', text: 'Partial.' }], error: crash },
    ]);
    const crashing = new AgentLoop({
      eventLog: log,
      model: firstModel,
      now: () => timestamp,
    });

    await expect(crashing.runTurn({ content: 'Crash the model.' })).rejects.toBe(crash);

    const resumedModel = new ScriptedModelPort([
      [
        { kind: 'text', text: 'Par' },
        { kind: 'text', text: 'tial. Recovered.' },
        { kind: 'finish', reason: 'stop' },
      ],
    ]);
    const resumed = new AgentLoop({
      eventLog: log,
      model: resumedModel,
      now: () => timestamp,
    });
    const result = await resumed.resumeTurn();

    expect(result.stopReason).toBe('completed');
    expect(result.history).toContainEqual(
      expect.objectContaining({
        kind: 'message',
        role: 'assistant',
        content: 'Partial. Recovered.',
      }),
    );
    expect(resumedModel.requests[0]).toEqual(firstModel.requests[0]);
    expect(resumedModel.requests[0]?.messages).not.toContainEqual(
      expect.objectContaining({ role: 'assistant', content: 'Partial.' }),
    );
    expect(result.events.filter((event) => event.type === 'model.request')).toHaveLength(1);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'model.attempt.discarded',
        reason: 'recovery',
      }),
    );
    const requestEvent = result.events.find((event) => event.type === 'model.request');
    expect(
      result.events
        .filter((event) => event.type === 'model.delta')
        .every((event) => event.requestId === requestEvent?.requestId),
    ).toBe(true);
    await expectClosedAndSchemaValid(log, 'done');
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

  it('uses the persisted decision while recovering a pending permission', async () => {
    const log = new InMemoryEventLog(identity('permission-recovery'));
    const tool = new EchoTool();
    const crashing = new AgentLoop({
      eventLog: log,
      model: new ScriptedModelPort([
        [toolCall('call-pending-policy', 'echo', null), { kind: 'finish', reason: 'tool-calls' }],
      ]),
      tools: new ToolRegistry().register(tool),
      now: () => timestamp,
    });
    crashing.use('event', async (context, next) => {
      await next();
      if (context.event.type === 'permission.requested') {
        throw new AgentLoopCrashError('lost while awaiting policy');
      }
    });

    await expect(crashing.runTurn({ content: 'Recover the policy.' })).rejects.toBeInstanceOf(
      AgentLoopCrashError,
    );

    const resumed = new AgentLoop({
      eventLog: log,
      model: new ScriptedModelPort([]),
      tools: new ToolRegistry().register(tool),
      now: () => timestamp,
    });
    resumed.use('event', async (context, next) => {
      if (context.event.type === 'permission.resolved') {
        context.event = { ...context.event, decision: 'deny', reason: 'recovered-event-policy' };
      }
      await next();
    });

    const result = await resumed.resumeTurn();

    expect(result.stopReason).toBe('failed');
    expect(tool.requests).toHaveLength(0);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'permission.resolved',
        decision: 'deny',
        reason: 'recovered-event-policy',
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

  it('reconciles the remaining tool intents after a crash during batch persistence', async () => {
    const firstResponse: readonly ModelChunk[] = [
      toolCall('call-batch-1', 'echo', { value: 1 }),
      toolCall('call-batch-2', 'echo', { value: 2 }),
      { kind: 'usage', usage: usage(4, 2, 0.02) },
      { kind: 'finish', reason: 'tool-calls' },
    ];
    const finalResponse: readonly ModelChunk[] = [
      { kind: 'text', text: 'Batch recovered.' },
      { kind: 'usage', usage: usage(2, 2, 0.01) },
      { kind: 'finish', reason: 'stop' },
    ];
    const expectedLoop = createLoop(new ScriptedModelPort([firstResponse, finalResponse]), {
      tools: new ToolRegistry().register(new EchoTool()),
    });
    const expected = await expectedLoop.loop.runTurn({ content: 'Run the batch.' });

    const log = new InMemoryEventLog(identity('batch-persistence'));
    const tool = new EchoTool();
    const crashing = new AgentLoop({
      eventLog: log,
      model: new ScriptedModelPort([firstResponse]),
      tools: new ToolRegistry().register(tool),
      now: () => timestamp,
    });
    let crashAfterFirstIntent = true;
    crashing.use('event', async (context, next) => {
      await next();
      if (crashAfterFirstIntent && context.event.type === 'tool.call') {
        crashAfterFirstIntent = false;
        throw new AgentLoopCrashError('lost while persisting tool batch');
      }
    });

    await expect(crashing.runTurn({ content: 'Run the batch.' })).rejects.toBeInstanceOf(
      AgentLoopCrashError,
    );
    expect((await projectSessionState(log.read(0))).pendingToolCalls).toHaveLength(1);

    const resumed = new AgentLoop({
      eventLog: log,
      model: new ScriptedModelPort([finalResponse]),
      tools: new ToolRegistry().register(tool),
      now: () => timestamp,
    });
    const actual = await resumed.resumeTurn();

    expect(actual.history).toEqual(expected.history);
    expect(actual.usage).toEqual(expected.usage);
    expect(tool.requests.map((request) => request.callId)).toEqual([
      'call-batch-1',
      'call-batch-2',
    ]);
    expect(actual.events.filter((event) => event.type === 'tool.call')).toHaveLength(2);
    await expectClosedAndSchemaValid(log, 'done');
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

  it('continues after recovery persists a business-level failed tool result', async () => {
    const log = new InMemoryEventLog(identity('recovery-result-failed'));
    const tool = new CrashOnceTool(true, 'failed');
    const crashing = new AgentLoop({
      eventLog: log,
      model: new ScriptedModelPort([
        [toolCall('call-result-failed', 'work', null), { kind: 'finish', reason: 'tool-calls' }],
      ]),
      tools: new ToolRegistry().register(tool),
      strategies: retryTwice(),
      now: () => timestamp,
    });
    await expect(crashing.runTurn({ content: 'Recover a test failure.' })).rejects.toBeInstanceOf(
      AgentLoopCrashError,
    );

    const resumed = new AgentLoop({
      eventLog: log,
      model: new ScriptedModelPort([
        [
          { kind: 'text', text: 'Failure observed and corrected.' },
          { kind: 'finish', reason: 'stop' },
        ],
      ]),
      tools: new ToolRegistry().register(tool),
      strategies: retryTwice(),
      now: () => timestamp,
    });
    const result = await resumed.resumeTurn();

    expect(result.stopReason).toBe('completed');
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool.result',
        callId: 'call-result-failed',
        outcome: 'failed',
        attempts: 2,
      }),
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'step.finished',
        stepId: 'turn-0:step:1',
        outcome: 'succeeded',
      }),
    );
  });
});

interface LoopOverrides {
  readonly tools?: ToolRegistry;
  readonly strategyRegistry?: ReturnType<typeof createDefaultStrategyRegistry>;
  readonly strategies?: ConstructorParameters<typeof AgentLoop>[0]['strategies'];
  readonly modelStreamRetryMode?: ConstructorParameters<
    typeof AgentLoop
  >[0]['modelStreamRetryMode'];
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
    ...(overrides.modelStreamRetryMode === undefined
      ? {}
      : { modelStreamRetryMode: overrides.modelStreamRetryMode }),
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
  readonly #outcome: 'succeeded' | 'failed';

  constructor(crash: boolean, outcome: 'succeeded' | 'failed' = 'succeeded') {
    this.#crash = crash;
    this.#outcome = outcome;
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
    return { outcome: this.#outcome, result: structuredClone(request.args) };
  }
}
