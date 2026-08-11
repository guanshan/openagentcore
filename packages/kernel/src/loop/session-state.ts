import { ProjectionInvariantError } from '../events/projection.js';
import type { ActionDescriptor, AgentEvent, JsonValue, UserInput } from '../events/types.js';

export type SessionReplayStatus =
  'idle' | 'running' | 'waiting_approval' | 'done' | 'failed' | 'aborted';

export interface IdleSessionLifecycleState {
  readonly status: 'idle';
}

export interface RunningSessionLifecycleState {
  readonly status: 'running';
  readonly turnId: string;
}

export interface WaitingApprovalSessionLifecycleState {
  readonly status: 'waiting_approval';
  readonly turnId: string;
  readonly reqId: string;
}

export interface TerminalSessionLifecycleState {
  readonly status: 'done' | 'failed' | 'aborted';
  readonly turnId: string;
}

export type SessionLifecycleState =
  | IdleSessionLifecycleState
  | RunningSessionLifecycleState
  | WaitingApprovalSessionLifecycleState
  | TerminalSessionLifecycleState;

type StartableSessionLifecycleState = IdleSessionLifecycleState | TerminalSessionLifecycleState;
type TurnStartedAgentEvent = Extract<AgentEvent, { readonly type: 'turn.started' }>;
type PermissionRequestedAgentEvent = Extract<AgentEvent, { readonly type: 'permission.requested' }>;
type PermissionResolvedAgentEvent = Extract<AgentEvent, { readonly type: 'permission.resolved' }>;
type TurnFinishedAgentEvent = Extract<AgentEvent, { readonly type: 'turn.finished' }>;
type RunningAgentEvent = Exclude<AgentEvent, TurnStartedAgentEvent | PermissionResolvedAgentEvent>;

export type SessionLifecycleEventFor<TState extends SessionLifecycleState> =
  TState extends StartableSessionLifecycleState
    ? TurnStartedAgentEvent
    : TState extends WaitingApprovalSessionLifecycleState
      ? PermissionResolvedAgentEvent
      : TState extends RunningSessionLifecycleState
        ? RunningAgentEvent
        : never;

export type TransitionedSessionLifecycleState<
  TState extends SessionLifecycleState,
  TEvent extends SessionLifecycleEventFor<TState>,
> = TEvent extends TurnStartedAgentEvent
  ? RunningSessionLifecycleState
  : TEvent extends PermissionRequestedAgentEvent
    ? WaitingApprovalSessionLifecycleState
    : TEvent extends PermissionResolvedAgentEvent
      ? RunningSessionLifecycleState
      : TEvent extends TurnFinishedAgentEvent
        ? TerminalSessionLifecycleState
        : TState;

export interface ActiveTurnState {
  readonly turnId: string;
  readonly startedAtSeq: number;
  readonly lastStepIndex: number;
  readonly usesStepEvents: boolean;
}

export interface ActiveStepState {
  readonly turnId: string;
  readonly stepId: string;
  readonly stepIndex: number;
  readonly startedAtSeq: number;
  readonly injectedInputs: readonly UserInput[];
}

export interface PendingToolCallState {
  readonly callId: string;
  readonly stepId?: string;
  readonly tool: string;
  readonly args: JsonValue;
  readonly calledAtSeq: number;
}

export interface PendingPermissionState {
  readonly reqId: string;
  readonly stepId?: string;
  readonly callId?: string;
  readonly action: ActionDescriptor;
  readonly requestedAtSeq: number;
}

export interface ResolvedPermissionState {
  readonly reqId: string;
  readonly stepId?: string;
  readonly callId?: string;
  readonly decision: 'allow' | 'deny';
  readonly reason?: string;
  readonly resolvedAtSeq: number;
}

/**
 * A replayable Session state. The seen/completed ID sets are retained so a snapshot plus tail
 * replay rejects duplicate terminal events with the same semantics as a full replay.
 */
export interface SessionReplayState {
  readonly status: SessionReplayStatus;
  readonly tenantId: string | undefined;
  readonly sessionId: string | undefined;
  readonly lastSeq: number;
  readonly activeTurn: ActiveTurnState | undefined;
  readonly activeStep: ActiveStepState | undefined;
  readonly pendingToolCalls: readonly PendingToolCallState[];
  readonly pendingPermissions: readonly PendingPermissionState[];
  readonly resolvedPermissions: readonly ResolvedPermissionState[];
  readonly seenTurnIds: readonly string[];
  readonly seenStepIds: readonly string[];
  readonly seenToolCallIds: readonly string[];
  readonly completedToolCallIds: readonly string[];
  readonly seenPermissionRequestIds: readonly string[];
  readonly resolvedPermissionIds: readonly string[];
}

export class SessionReplayInvariantError extends ProjectionInvariantError {
  constructor(message: string) {
    super(message);
    this.name = 'SessionReplayInvariantError';
  }
}

export function createSessionLifecycleState(): IdleSessionLifecycleState {
  return { status: 'idle' };
}

export function transitionSessionLifecycle<
  TState extends SessionLifecycleState,
  TEvent extends SessionLifecycleEventFor<TState>,
>(state: TState, event: TEvent): TransitionedSessionLifecycleState<TState, TEvent> {
  let transitioned: SessionLifecycleState;
  switch (event.type) {
    case 'turn.started':
      transitioned = { status: 'running', turnId: event.turnId };
      break;
    case 'permission.requested':
      if (state.status !== 'running') {
        throw new SessionReplayInvariantError('permission.requested requires a running Session.');
      }
      transitioned = { status: 'waiting_approval', turnId: state.turnId, reqId: event.reqId };
      break;
    case 'permission.resolved':
      if (state.status !== 'waiting_approval' || state.reqId !== event.reqId) {
        throw new SessionReplayInvariantError(
          'permission.resolved must match the waiting permission request.',
        );
      }
      transitioned = { status: 'running', turnId: state.turnId };
      break;
    case 'turn.finished':
      if (state.status !== 'running' || state.turnId !== event.turnId) {
        throw new SessionReplayInvariantError('turn.finished must match the running turn.');
      }
      transitioned = { status: terminalStatus(event.stopReason), turnId: event.turnId };
      break;
    default:
      if (state.status !== 'running') {
        throw new SessionReplayInvariantError(`${event.type} requires a running Session.`);
      }
      transitioned = state;
  }
  return transitioned as TransitionedSessionLifecycleState<TState, TEvent>;
}

export function createSessionReplayState(): SessionReplayState {
  return freezeState({
    status: 'idle',
    tenantId: undefined,
    sessionId: undefined,
    lastSeq: -1,
    activeTurn: undefined,
    activeStep: undefined,
    pendingToolCalls: [],
    pendingPermissions: [],
    resolvedPermissions: [],
    seenTurnIds: [],
    seenStepIds: [],
    seenToolCallIds: [],
    completedToolCallIds: [],
    seenPermissionRequestIds: [],
    resolvedPermissionIds: [],
  });
}

export function applyEventToSessionState(
  state: SessionReplayState,
  event: AgentEvent,
): SessionReplayState {
  const next = structuredClone(state) as MutableSessionReplayState;
  assertEventHeader(next, event);

  switch (event.type) {
    case 'turn.started':
      if (next.activeTurn !== undefined) {
        fail(event, `turn ${next.activeTurn.turnId} is already active`);
      }
      if (next.seenTurnIds.includes(event.turnId)) {
        fail(event, `turn ${event.turnId} has already started`);
      }
      next.seenTurnIds.push(event.turnId);
      next.activeTurn = {
        turnId: event.turnId,
        startedAtSeq: event.seq,
        lastStepIndex: 0,
        usesStepEvents: false,
      };
      next.activeStep = undefined;
      next.status = 'running';
      break;

    case 'step.started': {
      const turn = next.activeTurn;
      if (turn === undefined || turn.turnId !== event.turnId) {
        fail(event, `step ${event.stepId} does not belong to the active turn`);
      }
      if (next.activeStep !== undefined) {
        fail(event, `step ${next.activeStep.stepId} is already active`);
      }
      if (next.seenStepIds.includes(event.stepId)) {
        fail(event, `step ${event.stepId} has already started`);
      }
      if (event.stepIndex <= turn.lastStepIndex) {
        fail(event, `stepIndex ${event.stepIndex} must be greater than ${turn.lastStepIndex}`);
      }
      next.seenStepIds.push(event.stepId);
      next.activeTurn = {
        ...turn,
        lastStepIndex: event.stepIndex,
        usesStepEvents: true,
      };
      next.activeStep = {
        turnId: event.turnId,
        stepId: event.stepId,
        stepIndex: event.stepIndex,
        startedAtSeq: event.seq,
        injectedInputs: structuredClone(event.injectedInputs),
      };
      next.status = 'running';
      break;
    }

    case 'step.finished':
      if (
        next.activeStep === undefined ||
        next.activeStep.turnId !== event.turnId ||
        next.activeStep.stepId !== event.stepId
      ) {
        fail(event, `step ${event.stepId} does not match the active step`);
      }
      assertStepHasNoPendingWork(next, event.stepId, event);
      next.activeStep = undefined;
      next.status = 'running';
      break;

    case 'model.request':
    case 'model.delta':
      assertActiveStepAssociation(next, event.stepId, event);
      break;

    case 'tool.call':
      assertActiveStepAssociation(next, event.stepId, event);
      if (next.seenToolCallIds.includes(event.callId)) {
        fail(event, `tool call ${event.callId} has already been recorded`);
      }
      next.seenToolCallIds.push(event.callId);
      next.pendingToolCalls.push({
        callId: event.callId,
        ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
        tool: event.tool,
        args: structuredClone(event.args),
        calledAtSeq: event.seq,
      });
      break;

    case 'tool.result': {
      assertActiveStepAssociation(next, event.stepId, event);
      const pendingIndex = next.pendingToolCalls.findIndex(
        (candidate) => candidate.callId === event.callId,
      );
      if (pendingIndex < 0) {
        const detail = next.completedToolCallIds.includes(event.callId)
          ? 'already has a result'
          : 'has no preceding tool.call';
        fail(event, `tool call ${event.callId} ${detail}`);
      }
      const pending = next.pendingToolCalls[pendingIndex];
      if (
        pending !== undefined &&
        pending.stepId !== undefined &&
        event.stepId !== undefined &&
        pending.stepId !== event.stepId
      ) {
        fail(event, `tool result step ${event.stepId} does not match ${pending.stepId}`);
      }
      next.pendingToolCalls.splice(pendingIndex, 1);
      next.completedToolCallIds.push(event.callId);
      break;
    }

    case 'permission.requested':
      assertActiveStepAssociation(next, event.stepId, event);
      if (next.seenPermissionRequestIds.includes(event.reqId)) {
        fail(event, `permission request ${event.reqId} has already been recorded`);
      }
      if (
        event.callId !== undefined &&
        !next.pendingToolCalls.some((candidate) => candidate.callId === event.callId)
      ) {
        fail(event, `permission request ${event.reqId} refers to no pending tool call`);
      }
      next.seenPermissionRequestIds.push(event.reqId);
      next.pendingPermissions.push({
        reqId: event.reqId,
        ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
        ...(event.callId === undefined ? {} : { callId: event.callId }),
        action: structuredClone(event.action),
        requestedAtSeq: event.seq,
      });
      next.status = 'waiting_approval';
      break;

    case 'permission.resolved': {
      assertActiveStepAssociation(next, event.stepId, event);
      const pendingIndex = next.pendingPermissions.findIndex(
        (candidate) => candidate.reqId === event.reqId,
      );
      if (pendingIndex < 0) {
        const detail = next.resolvedPermissionIds.includes(event.reqId)
          ? 'has already been resolved'
          : 'has no preceding permission.requested';
        fail(event, `permission request ${event.reqId} ${detail}`);
      }
      const pending = next.pendingPermissions[pendingIndex];
      if (pending !== undefined) {
        assertOptionalCorrelation('stepId', pending.stepId, event.stepId, event);
        assertOptionalCorrelation('callId', pending.callId, event.callId, event);
      }
      next.pendingPermissions.splice(pendingIndex, 1);
      next.resolvedPermissionIds.push(event.reqId);
      next.resolvedPermissions.push({
        reqId: event.reqId,
        ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
        ...(event.callId === undefined ? {} : { callId: event.callId }),
        decision: event.decision,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
        resolvedAtSeq: event.seq,
      });
      next.status = next.pendingPermissions.length > 0 ? 'waiting_approval' : activeStatus(next);
      break;
    }

    case 'turn.finished':
      if (next.activeTurn === undefined || next.activeTurn.turnId !== event.turnId) {
        fail(event, `turn ${event.turnId} does not match the active turn`);
      }
      if (next.activeStep !== undefined) {
        fail(
          event,
          `turn ${event.turnId} cannot finish while step ${next.activeStep.stepId} is active`,
        );
      }
      if (next.pendingPermissions.length > 0 || next.pendingToolCalls.length > 0) {
        fail(event, `turn ${event.turnId} cannot finish with pending work`);
      }
      next.activeTurn = undefined;
      next.status = terminalStatus(event.stopReason);
      break;

    case 'compaction.applied':
    case 'checkpoint.created':
      break;
  }

  next.lastSeq = event.seq;
  next.tenantId ??= event.tenantId;
  next.sessionId ??= event.sessionId;
  return freezeState(next);
}

export async function projectSessionState(
  events: Iterable<AgentEvent> | AsyncIterable<AgentEvent>,
  initialState: SessionReplayState = createSessionReplayState(),
): Promise<SessionReplayState> {
  let state = initialState;
  for await (const event of events) {
    state = applyEventToSessionState(state, event);
  }
  return state;
}

interface MutableSessionReplayState {
  status: SessionReplayStatus;
  tenantId: string | undefined;
  sessionId: string | undefined;
  lastSeq: number;
  activeTurn: ActiveTurnState | undefined;
  activeStep: ActiveStepState | undefined;
  pendingToolCalls: PendingToolCallState[];
  pendingPermissions: PendingPermissionState[];
  resolvedPermissions: ResolvedPermissionState[];
  seenTurnIds: string[];
  seenStepIds: string[];
  seenToolCallIds: string[];
  completedToolCallIds: string[];
  seenPermissionRequestIds: string[];
  resolvedPermissionIds: string[];
}

function assertEventHeader(state: MutableSessionReplayState, event: AgentEvent): void {
  if (event.seq <= state.lastSeq) {
    fail(event, `seq must be greater than ${state.lastSeq}`);
  }
  if (
    (state.tenantId !== undefined && state.tenantId !== event.tenantId) ||
    (state.sessionId !== undefined && state.sessionId !== event.sessionId)
  ) {
    fail(event, 'event identity does not match replay state');
  }
}

function assertActiveStepAssociation(
  state: MutableSessionReplayState,
  stepId: string | undefined,
  event: AgentEvent,
): void {
  if (state.activeStep !== undefined) {
    if (stepId !== state.activeStep.stepId) {
      fail(event, `step ${String(stepId)} does not match active step ${state.activeStep.stepId}`);
    }
    return;
  }
  if (state.activeTurn?.usesStepEvents === true && stepId !== undefined) {
    fail(event, `step ${stepId} is not active`);
  }
}

function assertStepHasNoPendingWork(
  state: MutableSessionReplayState,
  stepId: string,
  event: AgentEvent,
): void {
  if (
    state.pendingToolCalls.some((candidate) => candidate.stepId === stepId) ||
    state.pendingPermissions.some((candidate) => candidate.stepId === stepId)
  ) {
    fail(event, `step ${stepId} cannot finish with pending work`);
  }
}

function assertOptionalCorrelation(
  field: 'stepId' | 'callId',
  expected: string | undefined,
  actual: string | undefined,
  event: AgentEvent,
): void {
  if (expected !== undefined && actual !== undefined && expected !== actual) {
    fail(event, `${field} ${actual} does not match ${expected}`);
  }
}

function activeStatus(state: MutableSessionReplayState): SessionReplayStatus {
  return state.activeTurn === undefined ? 'idle' : 'running';
}

function terminalStatus(stopReason: string): TerminalSessionLifecycleState['status'] {
  if (stopReason === 'aborted') {
    return 'aborted';
  }
  if (stopReason === 'failed' || stopReason === 'error') {
    return 'failed';
  }
  return 'done';
}

function fail(event: AgentEvent, message: string): never {
  throw new SessionReplayInvariantError(`${event.type} at seq ${event.seq}: ${message}.`);
}

function freezeState(state: SessionReplayState | MutableSessionReplayState): SessionReplayState {
  return deepFreeze(structuredClone(state)) as SessionReplayState;
}

function deepFreeze<TValue>(value: TValue): TValue {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
