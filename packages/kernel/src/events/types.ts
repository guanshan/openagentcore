export type JsonPrimitive = null | boolean | number | string;

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type AgentEventType =
  | 'turn.started'
  | 'step.started'
  | 'step.finished'
  | 'model.request'
  | 'model.delta'
  | 'model.attempt.discarded'
  | 'tool.call'
  | 'tool.result'
  | 'permission.requested'
  | 'permission.resolved'
  | 'credential.used'
  | 'compaction.applied'
  | 'checkpoint.created'
  | 'turn.finished';

export interface UserInput {
  readonly content: string;
}

export type ContextStageId =
  | 'history'
  | 'memory'
  | 'skills'
  | 'compaction'
  | 'slots'
  | 'context-middleware'
  | 'model-middleware';

export interface ContextAssemblyMessage extends JsonObject {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ContextAssemblyToolCall[];
}

export interface ContextAssemblyToolCall extends JsonObject {
  readonly callId: string;
  readonly tool: string;
  readonly args: JsonValue;
}

export interface ContextAssemblyTool extends JsonObject {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
}

export interface ContextSegmentSource extends JsonObject {
  readonly kind:
    | 'event'
    | 'prompt'
    | 'memory'
    | 'skill'
    | 'tool'
    | 'compaction'
    | 'middleware'
    | 'dry-run-input';
  readonly id?: string;
  readonly sourceSeqs?: readonly number[];
  readonly promptId?: string;
  readonly promptSource?: 'builtin' | 'directory' | 'runtime';
  readonly sourceVersion?: string;
  readonly version?: string;
  readonly mode?: 'replace' | 'append';
  readonly middlewareKind?: 'context' | 'model';
  readonly strategy?: string;
}

export interface ContextSegment extends JsonObject {
  readonly id: string;
  readonly stage: ContextStageId;
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly source: ContextSegmentSource;
  readonly tokenCount: number | null;
  readonly messageIndex: number;
}

export interface ContextStageSnapshot extends JsonObject {
  readonly stage: ContextStageId;
  readonly status: 'applied' | 'noop';
  readonly messages: readonly ContextAssemblyMessage[];
  readonly segmentIds: readonly string[];
  readonly tokenCount: number | null;
}

export interface ContextAssembly extends JsonObject {
  readonly messages: readonly ContextAssemblyMessage[];
  readonly tools: readonly ContextAssemblyTool[];
  readonly toolUse: 'native' | 'prompted' | 'none';
  readonly metadata?: JsonObject;
  readonly stages: readonly ContextStageSnapshot[];
  readonly segments: readonly ContextSegment[];
  readonly totalTokens: number | null;
  readonly promptRevision: number;
  readonly capabilityDowngrades: readonly string[];
}

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

export interface ActionPathDescriptor extends JsonObject {
  /** Canonical absolute workspace root used to interpret relative policy globs. */
  readonly root: string;
  /** Canonical absolute paths read by the action. */
  readonly read: readonly string[];
  /** Canonical absolute paths written by the action. */
  readonly write: readonly string[];
}

export interface ActionCommandDescriptor extends JsonObject {
  /** The exact command text supplied by the caller. */
  readonly text: string;
  /** The executable parsed from the first shell command segment. */
  readonly executable: string;
}

export interface ActionDescriptor extends JsonObject {
  /** Required on newly emitted tool permission events; optional for pre-M2 event compatibility. */
  readonly tool?: string;
  readonly args?: JsonValue;
  readonly permission?: JsonObject;
  readonly paths?: ActionPathDescriptor;
  readonly command?: ActionCommandDescriptor;
}

export interface EventRange {
  readonly fromSeq: number;
  readonly toSeq: number;
}

export type StopReason = string;

export interface ModelCost {
  readonly amount: number;
  readonly currency: string;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cost?: ModelCost;
}

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

export interface StepStartedEvent extends BaseAgentEvent<'step.started'> {
  readonly turnId: string;
  readonly stepId: string;
  readonly stepIndex: number;
  readonly injectedInputs: readonly UserInput[];
}

export interface StepFinishedEvent extends BaseAgentEvent<'step.finished'> {
  readonly turnId: string;
  readonly stepId: string;
  readonly outcome: 'succeeded' | 'failed' | 'aborted';
  readonly usage: ModelUsage;
}

export interface ModelRequestEvent extends BaseAgentEvent<'model.request'> {
  readonly stepId: string;
  readonly assembled: ContextAssembly;
  readonly requestId?: string;
  readonly toolUse?: 'native' | 'prompted' | 'none';
  readonly capabilityDowngrades?: readonly string[];
  readonly retryMode?: ModelStreamRetryMode;
}

export type ModelStreamRetryMode = 'discard' | 'strict-prefix';

export interface ModelDeltaEvent extends BaseAgentEvent<'model.delta'> {
  readonly stepId: string;
  readonly delta: TextOrToolDelta;
  readonly requestId?: string;
}

export interface ModelAttemptDiscardedEvent extends BaseAgentEvent<'model.attempt.discarded'> {
  readonly stepId: string;
  readonly requestId: string;
  readonly discarded: EventRange;
  readonly reason: 'provider-failure' | 'recovery';
}

export interface ToolCallEvent extends BaseAgentEvent<'tool.call'> {
  readonly callId: string;
  readonly tool: string;
  readonly args: JsonValue;
  readonly stepId?: string;
  /** Completed model usage copied before tool side effects so recovery can close the step. */
  readonly modelUsage?: ModelUsage;
}

export interface ToolResultEvent extends BaseAgentEvent<'tool.result'> {
  readonly callId: string;
  readonly result: ToolResult;
  readonly stepId?: string;
  readonly outcome?: 'succeeded' | 'failed' | 'denied';
  readonly error?: JsonValue;
  readonly attempts?: number;
}

export interface PermissionRequestedEvent extends BaseAgentEvent<'permission.requested'> {
  readonly reqId: string;
  readonly action: ActionDescriptor;
  readonly stepId?: string;
  readonly callId?: string;
  readonly reason?: string;
}

export interface PermissionResolvedEvent extends BaseAgentEvent<'permission.resolved'> {
  readonly reqId: string;
  readonly decision: 'allow' | 'deny';
  readonly stepId?: string;
  readonly callId?: string;
  readonly reason?: string;
}

export interface CredentialUsedEvent extends BaseAgentEvent<'credential.used'> {
  readonly stepId: string;
  readonly callId: string;
  readonly tool: string;
  readonly scope: string;
  readonly attempt: number;
}

export interface CompactionAppliedEvent extends BaseAgentEvent<'compaction.applied'> {
  readonly summary: string;
  readonly dropped: EventRange;
  readonly strategy?: string;
}

export interface CheckpointCreatedEvent extends BaseAgentEvent<'checkpoint.created'> {
  readonly snapshotRef: string;
}

export interface TurnFinishedEvent extends BaseAgentEvent<'turn.finished'> {
  readonly turnId: string;
  readonly stopReason: StopReason;
  readonly usage?: ModelUsage;
}

export type AgentEvent =
  | TurnStartedEvent
  | StepStartedEvent
  | StepFinishedEvent
  | ModelRequestEvent
  | ModelDeltaEvent
  | ModelAttemptDiscardedEvent
  | ToolCallEvent
  | ToolResultEvent
  | PermissionRequestedEvent
  | PermissionResolvedEvent
  | CredentialUsedEvent
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
