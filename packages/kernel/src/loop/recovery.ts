import type { AgentEvent } from '../events/types.js';
import type { PendingToolCallState, SessionReplayState } from './session-state.js';
import { runMemoryPipeline } from './context.js';
import {
  AgentLoopInvariantError,
  activeModelDeltas,
  emitDeniedToolResult,
  emitToolFailure,
  EMPTY_MODEL_USAGE,
  executePersistedToolCall,
  recordedToolCall,
  requestPermission,
  resumeInterruptedModelStep,
  type StepRuntime,
} from './step.js';

export class UnknownToolResultError extends Error {
  constructor(callId: string) {
    super(`Tool call ${callId} has no persisted result; its external outcome is unknown.`);
    this.name = 'UnknownToolResultError';
  }
}

export interface RecoveryRuntime extends StepRuntime {
  readonly reloadState: () => Promise<SessionReplayState>;
  readonly eventsForStep: (stepId: string) => Promise<readonly AgentEvent[]>;
}

export async function recoverActiveStep(
  runtime: RecoveryRuntime,
  signal: AbortSignal,
): Promise<void> {
  let state = await runtime.reloadState();
  const activeStep = state.activeStep;
  const activeTurn = state.activeTurn;
  if (activeTurn === undefined || activeStep === undefined) {
    return;
  }

  const initialStepEvents = await runtime.eventsForStep(activeStep.stepId);
  if (!initialStepEvents.some((event) => event.type === 'tool.call')) {
    await resumeInterruptedModelStep(
      runtime,
      activeTurn.turnId,
      activeStep.stepId,
      initialStepEvents,
      signal,
    );
    return;
  }

  await reconcilePersistedToolBatch(runtime, activeStep.stepId, signal);
  state = await runtime.reloadState();

  for (const permission of [...state.pendingPermissions]) {
    const call = state.pendingToolCalls.find((candidate) => candidate.callId === permission.callId);
    if (call === undefined) {
      continue;
    }
    const tool = runtime.tools.get(call.tool);
    if (tool === undefined) {
      await runtime.emit(
        {
          type: 'permission.resolved',
          reqId: permission.reqId,
          stepId: activeStep.stepId,
          callId: call.callId,
          decision: 'deny',
          reason: 'tool-not-registered',
        },
        signal,
      );
      await emitDeniedToolResult(
        runtime,
        call.callId,
        activeStep.stepId,
        'tool-not-registered',
        signal,
      );
      continue;
    }
    const decision = await runtime.permission.apply(
      {
        tool: tool.name,
        groups: runtime.tools.groupsFor(tool.name),
        permission: tool.permission,
        args: call.args,
      },
      strategyContext(runtime, signal, activeTurn.turnId, activeStep.stepId),
    );
    const persisted = await runtime.emit(
      {
        type: 'permission.resolved',
        reqId: permission.reqId,
        stepId: activeStep.stepId,
        callId: call.callId,
        decision: decision.decision,
        reason: decision.reason,
      },
      signal,
    );
    if (persisted.type !== 'permission.resolved') {
      throw new AgentLoopInvariantError('Expected permission.resolved while recovering approval.');
    }
    const persistedReason = persisted.reason ?? decision.reason;
    if (persisted.decision === 'deny') {
      await emitDeniedToolResult(runtime, call.callId, activeStep.stepId, persistedReason, signal);
    } else {
      await executePersistedToolCall(
        runtime,
        tool,
        { callId: call.callId, args: call.args },
        activeTurn.turnId,
        activeStep.stepId,
        1,
        signal,
      );
    }
  }

  state = await runtime.reloadState();
  for (const call of [...state.pendingToolCalls]) {
    await recoverPendingToolCall(runtime, call, state, signal);
    state = await runtime.reloadState();
  }

  const refreshed = await runtime.reloadState();
  if (refreshed.activeStep === undefined) {
    return;
  }
  const stepResults = await runtime.eventsForStep(refreshed.activeStep.stepId);
  const failed = stepResults.some(
    (event) =>
      event.type === 'tool.result' &&
      (event.outcome === 'denied' || (event.outcome === 'failed' && event.error !== undefined)),
  );
  const completedToolWork = stepResults.some((event) => event.type === 'tool.call');
  const recoveredUsage = [...stepResults]
    .reverse()
    .find(
      (event): event is Extract<AgentEvent, { readonly type: 'tool.call' }> =>
        event.type === 'tool.call' && event.modelUsage !== undefined,
    )?.modelUsage;
  runtime.setActiveUsage(recoveredUsage ?? EMPTY_MODEL_USAGE);
  if (completedToolWork) {
    await runMemoryPipeline(
      runtime,
      'write',
      refreshed.activeStep.turnId,
      refreshed.activeStep.stepId,
      signal,
    );
  }
  await runtime.emit(
    {
      type: 'step.finished',
      turnId: refreshed.activeStep.turnId,
      stepId: refreshed.activeStep.stepId,
      // A model-only step has no durable finish marker, so an unfinished one cannot be
      // proven successful during replay. Tool work is complete only after all calls close.
      outcome: failed || !completedToolWork ? 'failed' : 'succeeded',
      usage: runtime.getActiveUsage(),
    },
    signal,
  );
  if (completedToolWork) {
    await runtime.maybeCompact(refreshed.activeStep.turnId, refreshed.activeStep.stepId, signal);
    await runtime.maybeCheckpoint(refreshed.activeStep.turnId, refreshed.activeStep.stepId, signal);
  }
}

export async function closeAfterFailure(
  runtime: RecoveryRuntime,
  error: unknown,
  aborted: boolean,
): Promise<void> {
  const signal = new AbortController().signal;
  try {
    let state = await runtime.reloadState();
    for (const permission of [...state.pendingPermissions]) {
      await runtime.emit(
        {
          type: 'permission.resolved',
          reqId: permission.reqId,
          ...(permission.stepId === undefined ? {} : { stepId: permission.stepId }),
          ...(permission.callId === undefined ? {} : { callId: permission.callId }),
          decision: 'deny',
          reason: aborted ? 'aborted' : 'failed',
        },
        signal,
      );
    }
    state = await runtime.reloadState();
    for (const call of [...state.pendingToolCalls]) {
      await emitToolFailure(
        runtime,
        call.callId,
        call.stepId ?? state.activeStep?.stepId ?? 'unknown',
        1,
        error,
        signal,
      );
    }
    state = await runtime.reloadState();
    if (state.activeStep !== undefined) {
      await runtime.emit(
        {
          type: 'step.finished',
          turnId: state.activeStep.turnId,
          stepId: state.activeStep.stepId,
          outcome: aborted ? 'aborted' : 'failed',
          usage: runtime.getActiveUsage(),
        },
        signal,
      );
    }
    state = await runtime.reloadState();
    if (state.activeTurn !== undefined) {
      await runtime.emit(
        {
          type: 'turn.finished',
          turnId: state.activeTurn.turnId,
          stopReason: aborted ? 'aborted' : 'failed',
        },
        signal,
      );
    }
  } catch {
    // Preserve the original failure. The remaining prefix is replayable for a later recovery.
  }
}

async function reconcilePersistedToolBatch(
  runtime: RecoveryRuntime,
  stepId: string,
  signal: AbortSignal,
): Promise<void> {
  const events = await runtime.eventsForStep(stepId);
  const calls = events.filter(
    (event): event is Extract<AgentEvent, { readonly type: 'tool.call' }> =>
      event.type === 'tool.call',
  );
  if (calls.length === 0) {
    return;
  }

  const persistedCallIds = new Set(calls.map((call) => call.callId));
  const batchUsage = [...calls].reverse().find((call) => call.modelUsage !== undefined)?.modelUsage;
  const modelCallIds = new Set<string>();
  const requestId = events.find((event) => event.type === 'model.request')?.requestId;
  const activeDeltas = activeModelDeltas(events, requestId ?? `${stepId}:request`);
  for (const event of activeDeltas) {
    if (event.delta.kind !== 'tool') {
      continue;
    }
    const call = recordedToolCall(event.delta.toolCallDelta);
    if (call === undefined) {
      continue;
    }
    if (modelCallIds.has(call.callId)) {
      throw new AgentLoopInvariantError(
        `Model response contains duplicate tool call ID ${call.callId}.`,
      );
    }
    modelCallIds.add(call.callId);
    if (persistedCallIds.has(call.callId)) {
      continue;
    }
    await runtime.emit(
      {
        type: 'tool.call',
        stepId,
        callId: call.callId,
        tool: call.tool,
        args: call.args,
        ...(batchUsage === undefined ? {} : { modelUsage: batchUsage }),
      },
      signal,
    );
    persistedCallIds.add(call.callId);
  }
}

async function recoverPendingToolCall(
  runtime: RecoveryRuntime,
  call: PendingToolCallState,
  state: SessionReplayState,
  signal: AbortSignal,
): Promise<void> {
  const turn = state.activeTurn;
  const step = state.activeStep;
  if (turn === undefined || step === undefined) {
    throw new AgentLoopInvariantError('Pending tool work requires an active turn and step.');
  }
  const tool = runtime.tools.get(call.tool);
  if (tool === undefined) {
    await emitToolFailure(
      runtime,
      call.callId,
      step.stepId,
      1,
      new Error('Tool is not registered.'),
      signal,
    );
    return;
  }

  const resolved = [...state.resolvedPermissions]
    .reverse()
    .find((candidate) => candidate.callId === call.callId);
  if (resolved === undefined) {
    const decision = await requestPermission(
      runtime,
      tool,
      { callId: call.callId, tool: call.tool, args: call.args },
      turn.turnId,
      step.stepId,
      signal,
    );
    if (decision.decision === 'deny') {
      await emitDeniedToolResult(runtime, call.callId, step.stepId, decision.reason, signal);
      return;
    }
    await executePersistedToolCall(
      runtime,
      tool,
      { callId: call.callId, args: call.args },
      turn.turnId,
      step.stepId,
      1,
      signal,
    );
    return;
  }
  if (resolved.decision === 'deny') {
    await emitDeniedToolResult(
      runtime,
      call.callId,
      step.stepId,
      resolved.reason ?? 'permission-denied',
      signal,
    );
    return;
  }

  const unknown = new UnknownToolResultError(call.callId);
  const retry = await runtime.retry.apply(
    { attempt: 1, operation: 'recovery', error: unknown },
    strategyContext(runtime, signal, turn.turnId, step.stepId),
  );
  if (retry.action !== 'retry') {
    await emitToolFailure(runtime, call.callId, step.stepId, 1, unknown, signal);
    return;
  }
  await runtime.sleep(retry.delayMs, signal);
  await executePersistedToolCall(
    runtime,
    tool,
    { callId: call.callId, args: call.args },
    turn.turnId,
    step.stepId,
    2,
    signal,
  );
}

function strategyContext(
  runtime: RecoveryRuntime,
  signal: AbortSignal,
  turnId: string | undefined,
  stepId: string | undefined,
) {
  return {
    signal,
    tenantId: runtime.eventLog.tenantId,
    sessionId: runtime.eventLog.sessionId,
    turnId,
    stepId,
  };
}
