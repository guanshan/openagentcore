import { describe, expect, expectTypeOf, it } from 'vitest';

import { assertSchemaValidEvent } from '../events/schema.test-support.js';
import type { AgentEvent } from '../events/types.js';
import {
  createSessionLifecycleState,
  projectSessionState,
  SessionReplayInvariantError,
  transitionSessionLifecycle,
} from './session-state.js';
import type {
  RunningSessionLifecycleState,
  WaitingApprovalSessionLifecycleState,
} from './session-state.js';

const common = {
  tenantId: 'tenant-test',
  sessionId: 'session-test',
  ts: '2026-08-11T00:00:00Z',
} as const;

const turnStarted = assertSchemaValidEvent({
  ...common,
  type: 'turn.started',
  seq: 0,
  turnId: 'turn-1',
  input: { content: 'Start.' },
});

const stepStarted = assertSchemaValidEvent({
  ...common,
  type: 'step.started',
  seq: 1,
  turnId: 'turn-1',
  stepId: 'step-1',
  stepIndex: 1,
  injectedInputs: [{ content: 'Steer.' }],
});

const toolCall = assertSchemaValidEvent({
  ...common,
  type: 'tool.call',
  seq: 2,
  stepId: 'step-1',
  callId: 'call-1',
  tool: 'echo',
  args: { value: 'test' },
});

const permissionRequested = assertSchemaValidEvent({
  ...common,
  type: 'permission.requested',
  seq: 3,
  stepId: 'step-1',
  callId: 'call-1',
  reqId: 'permission-1',
  action: { kind: 'tool', tool: 'echo' },
});

const permissionResolved = assertSchemaValidEvent({
  ...common,
  type: 'permission.resolved',
  seq: 4,
  stepId: 'step-1',
  callId: 'call-1',
  reqId: 'permission-1',
  decision: 'allow',
  reason: 'test policy',
});

const toolResult = assertSchemaValidEvent({
  ...common,
  type: 'tool.result',
  seq: 5,
  stepId: 'step-1',
  callId: 'call-1',
  outcome: 'succeeded',
  result: { value: 'test' },
});

const stepFinished = assertSchemaValidEvent({
  ...common,
  type: 'step.finished',
  seq: 6,
  turnId: 'turn-1',
  stepId: 'step-1',
  outcome: 'succeeded',
  usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
});

const turnFinished = assertSchemaValidEvent({
  ...common,
  type: 'turn.finished',
  seq: 7,
  turnId: 'turn-1',
  stopReason: 'completed',
});

describe('Session replay projection', () => {
  it('rebuilds a completed turn and retains permission decisions', async () => {
    const state = await projectSessionState([
      turnStarted,
      stepStarted,
      toolCall,
      permissionRequested,
      permissionResolved,
      toolResult,
      stepFinished,
      turnFinished,
    ]);

    expect(state).toMatchObject({
      status: 'done',
      lastSeq: 7,
      activeTurn: undefined,
      activeStep: undefined,
      pendingToolCalls: [],
      pendingPermissions: [],
      resolvedPermissions: [
        {
          reqId: 'permission-1',
          callId: 'call-1',
          stepId: 'step-1',
          decision: 'allow',
          reason: 'test policy',
          resolvedAtSeq: 4,
        },
      ],
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.resolvedPermissions)).toBe(true);
  });

  it('preserves an unfinished tool call as a valid recovery prefix', async () => {
    const state = await projectSessionState([turnStarted, stepStarted, toolCall]);

    expect(state.status).toBe('running');
    expect(state.activeTurn?.turnId).toBe('turn-1');
    expect(state.activeStep?.stepId).toBe('step-1');
    expect(state.pendingToolCalls).toEqual([
      {
        callId: 'call-1',
        stepId: 'step-1',
        tool: 'echo',
        args: { value: 'test' },
        calledAtSeq: 2,
      },
    ]);
  });

  it('rejects unmatched and duplicate terminal events', async () => {
    await expect(projectSessionState([toolResult])).rejects.toBeInstanceOf(
      SessionReplayInvariantError,
    );
    await expect(
      projectSessionState([
        turnStarted,
        stepStarted,
        toolCall,
        toolResult,
        { ...toolResult, seq: 6 },
      ]),
    ).rejects.toBeInstanceOf(SessionReplayInvariantError);
  });
});

describe('typed Session lifecycle transitions', () => {
  it('narrows the next state and rejects invalid state/event pairs at compile time', () => {
    const idle = createSessionLifecycleState();
    const running = transitionSessionLifecycle(idle, turnStarted);
    expectTypeOf(running).toEqualTypeOf<RunningSessionLifecycleState>();

    const waiting = transitionSessionLifecycle(running, permissionRequested);
    expectTypeOf(waiting).toEqualTypeOf<WaitingApprovalSessionLifecycleState>();

    const resumed = transitionSessionLifecycle(waiting, permissionResolved);
    expectTypeOf(resumed).toEqualTypeOf<RunningSessionLifecycleState>();

    const assertInvalidTransitions = (): void => {
      // @ts-expect-error An idle Session cannot resolve a permission request.
      transitionSessionLifecycle(idle, permissionResolved);
      // @ts-expect-error A waiting Session cannot start a step before approval is resolved.
      transitionSessionLifecycle(waiting, stepStarted);
    };
    void assertInvalidTransitions;
  });

  it('keeps non-transitioning running events in the running state', () => {
    const running = transitionSessionLifecycle(createSessionLifecycleState(), turnStarted);
    const afterStep = transitionSessionLifecycle(running, stepStarted);

    expectTypeOf(afterStep).toEqualTypeOf<RunningSessionLifecycleState>();
    expect(afterStep).toEqual(running);
  });
});

const _agentEventCoverage: readonly AgentEvent[] = [
  turnStarted,
  stepStarted,
  toolCall,
  permissionRequested,
  permissionResolved,
  toolResult,
  stepFinished,
  turnFinished,
];
void _agentEventCoverage;
