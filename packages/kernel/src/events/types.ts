export type JsonPrimitive = null | boolean | number | string;

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type AgentEventType =
  | 'turn.started'
  | 'model.request'
  | 'model.delta'
  | 'tool.call'
  | 'tool.result'
  | 'permission.requested'
  | 'permission.resolved'
  | 'compaction.applied'
  | 'checkpoint.created'
  | 'turn.finished';

export interface UserInput {
  readonly content: string;
}

export type ContextAssembly = JsonObject;

export interface TextDelta {
  readonly kind: 'text';
  readonly text: string;
}

export interface ToolDelta {
  readonly kind: 'tool';
  readonly toolCallDelta: JsonValue;
}

export type TextOrToolDelta = TextDelta | ToolDelta;

export type ToolResult = JsonValue;

export type ActionDescriptor = JsonObject;

export interface EventRange {
  readonly fromSeq: number;
  readonly toSeq: number;
}

export type StopReason = string;

interface BaseAgentEvent<TType extends AgentEventType> {
  readonly type: TType;
  readonly seq: number;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly ts: string;
}

export interface TurnStartedEvent extends BaseAgentEvent<'turn.started'> {
  readonly turnId: string;
  readonly input: UserInput;
}

export interface ModelRequestEvent extends BaseAgentEvent<'model.request'> {
  readonly stepId: string;
  readonly assembled: ContextAssembly;
}

export interface ModelDeltaEvent extends BaseAgentEvent<'model.delta'> {
  readonly stepId: string;
  readonly delta: TextOrToolDelta;
}

export interface ToolCallEvent extends BaseAgentEvent<'tool.call'> {
  readonly callId: string;
  readonly tool: string;
  readonly args: JsonValue;
}

export interface ToolResultEvent extends BaseAgentEvent<'tool.result'> {
  readonly callId: string;
  readonly result: ToolResult;
}

export interface PermissionRequestedEvent extends BaseAgentEvent<'permission.requested'> {
  readonly reqId: string;
  readonly action: ActionDescriptor;
}

export interface PermissionResolvedEvent extends BaseAgentEvent<'permission.resolved'> {
  readonly reqId: string;
  readonly decision: 'allow' | 'deny';
}

export interface CompactionAppliedEvent extends BaseAgentEvent<'compaction.applied'> {
  readonly summary: string;
  readonly dropped: EventRange;
}

export interface CheckpointCreatedEvent extends BaseAgentEvent<'checkpoint.created'> {
  readonly snapshotRef: string;
}

export interface TurnFinishedEvent extends BaseAgentEvent<'turn.finished'> {
  readonly turnId: string;
  readonly stopReason: StopReason;
}

export type AgentEvent =
  | TurnStartedEvent
  | ModelRequestEvent
  | ModelDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | PermissionRequestedEvent
  | PermissionResolvedEvent
  | CompactionAppliedEvent
  | CheckpointCreatedEvent
  | TurnFinishedEvent;

export type AgentDefinitionSummary = JsonObject;

export interface TrajectoryMetadata {
  readonly specVersion: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly agentDefinitionSummary: AgentDefinitionSummary;
}

export interface Trajectory {
  readonly metadata: TrajectoryMetadata;
  readonly events: readonly AgentEvent[];
}
