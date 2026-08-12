export {
  EventLogConflictError,
  EventLogInvariantError,
  InMemoryEventLog,
} from './events/event-log.js';
export type {
  EventLog,
  EventStreamIdentity,
  EventSubscriber,
  SubscriberErrorHandler,
  Unsubscribe,
} from './events/event-log.js';

export { InMemorySnapshotStore, SnapshotStoreInvariantError } from './events/snapshot-store.js';
export type { SnapshotInput, SnapshotStore, StoredSnapshot } from './events/snapshot-store.js';

export {
  applyEventToMessageProjection,
  createMessageProjection,
  materializeMessageHistory,
  projectMessageHistory,
  ProjectionInvariantError,
} from './events/projection.js';
export type {
  MessageHistoryItem,
  MessageProjectionEntry,
  MessageProjectionState,
} from './events/projection.js';

export type {
  ActionDescriptor,
  ActionCommandDescriptor,
  ActionPathDescriptor,
  AgentDefinitionSummary,
  AgentEvent,
  AgentEventType,
  CheckpointCreatedEvent,
  CompactionAppliedEvent,
  ContextAssembly,
  ContextAssemblyMessage,
  ContextAssemblyToolCall,
  ContextAssemblyTool,
  ContextSegment,
  ContextSegmentSource,
  ContextStageId,
  ContextStageSnapshot,
  EventRange,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ModelCost,
  ModelAttemptDiscardedEvent,
  ModelDeltaEvent,
  ModelRequestEvent,
  ModelStreamRetryMode,
  ModelUsage,
  PermissionRequestedEvent,
  PermissionResolvedEvent,
  StepFinishedEvent,
  StepStartedEvent,
  StopReason,
  TextDelta,
  TextOrToolDelta,
  ToolCallEvent,
  ToolDelta,
  ToolResult,
  ToolResultEvent,
  Trajectory,
  TrajectoryMetadata,
  TurnFinishedEvent,
  TurnStartedEvent,
  UserInput,
} from './events/types.js';

export {
  BUILTIN_PROMPTS,
  BUILTIN_PROMPT_SOURCE,
  BUILTIN_PROMPT_SOURCE_VERSION,
  createDefaultPromptRegistry,
} from './prompts/builtins.js';
export { PROMPT_SOURCE_KINDS, PromptRegistry, PromptRegistryError } from './prompts/registry.js';
export type {
  Prompt,
  PromptContribution,
  PromptDefinition,
  PromptOverrideMode,
  PromptRegistrySnapshot,
  PromptSourceInfo,
  PromptSourceKind,
  PromptSourceRef,
  PromptSourceSnapshot,
} from './prompts/registry.js';

export {
  MODEL_PORT_ERROR_KINDS,
  ModelPortError,
  ScriptedModelExhaustedError,
  ScriptedModelPort,
} from './ports/model.js';

export {
  LocalProcessSandbox,
  negotiateSandboxCapabilities,
  SANDBOX_WORKSPACE_PATH,
  SandboxBoundaryError,
  SandboxContractError,
  validateSandboxCapabilities,
} from './ports/sandbox.js';
export type {
  LocalProcessSandboxOptions,
  SandboxCapabilities,
  SandboxCapabilityNegotiation,
  SandboxCapabilityRequest,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxFileSystemPort,
  SandboxPort,
  SandboxSnapshot,
} from './ports/sandbox.js';
export type {
  EventLogPort,
  KvPort,
  StoreCapabilities,
  StoreDurability,
  StorePort,
  StoreReadConsistency,
  StoreSequenceSemantics,
} from './ports/store.js';
export type {
  FinishModelChunk,
  ModelCapabilities,
  ModelChunk,
  ModelFinishReason,
  ModelMessage,
  ModelMessageRole,
  ModelMessageToolCall,
  ModelPort,
  ModelPortErrorKind,
  ModelPortErrorOptions,
  ModelRequest,
  ModelToolDefinition,
  ModelToolUse,
  ScriptedModelPortOptions,
  ScriptedModelResponse,
  ScriptedModelStep,
  TextModelChunk,
  ToolCallModelChunk,
  UsageModelChunk,
} from './ports/model.js';

export {
  describeToolAction,
  EchoTool,
  FailingTool,
  ResultFailingTool,
  SlowTool,
  ToolContractError,
  ToolRegistry,
  ToolRegistryError,
} from './tools/tool.js';
export type {
  Tool,
  ToolActionDetails,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolPermissionDescriptor,
  ToolPort,
  ToolRegistrationOptions,
} from './tools/tool.js';

export { StrategyRegistry, StrategyRegistryError } from './strategy/registry.js';
export type {
  KernelPorts,
  Strategy,
  StrategyContext,
  StrategyKind,
  StrategyMetrics,
  StrategyMetricsSnapshot,
} from './strategy/registry.js';

export {
  AllowAllPermissionStrategy,
  createDefaultStrategyRegistry,
  ExponentialBackoffRetryStrategy,
  MaxStepsStopStrategy,
  NoneCheckpointStrategy,
  NoneCompactionStrategy,
  PolicyFilePermissionStrategy,
  SlidingWindowCompactionStrategy,
  StrategyConfigError,
} from './strategy/builtins.js';
export type {
  CheckpointDecision,
  CheckpointStrategyInput,
  CompactionDecision,
  CompactionEntry,
  CompactionStrategyInput,
  ExponentialBackoffConfig,
  MaxStepsConfig,
  PermissionDecision,
  PermissionStrategyInput,
  PermissionStrategyOutput,
  PolicyFileConfig,
  PolicyRule,
  RetryAction,
  RetryDecision,
  RetryOperation,
  RetryOperationOverride,
  RetryStrategyInput,
  SlidingWindowCompactionConfig,
  StopDecision,
  StopStepOutcome,
  StopStrategyInput,
} from './strategy/builtins.js';

export {
  CostAccountingError,
  createCostAccountingMiddleware,
  MiddlewareNextError,
  MiddlewarePipeline,
  MiddlewareRegistry,
} from './loop/middleware.js';
export type {
  ContextMiddlewareContext,
  EventMiddlewareContext,
  MemoryMiddlewareContext,
  Middleware,
  MiddlewareBaseContext,
  MiddlewareContextMap,
  MiddlewareKind,
  MiddlewareExecutionMode,
  MiddlewareNext,
  ModelMiddlewareContext,
  ToolMiddlewareContext,
} from './loop/middleware.js';

export {
  applyEventToSessionState,
  createSessionLifecycleState,
  createSessionReplayState,
  projectSessionState,
  SessionReplayInvariantError,
  transitionSessionLifecycle,
} from './loop/session-state.js';
export type {
  ActiveStepState,
  ActiveTurnState,
  IdleSessionLifecycleState,
  PendingPermissionState,
  PendingToolCallState,
  ResolvedPermissionState,
  RunningSessionLifecycleState,
  SessionLifecycleEventFor,
  SessionLifecycleState,
  SessionReplayState,
  SessionReplayStatus,
  TerminalSessionLifecycleState,
  TransitionedSessionLifecycleState,
  WaitingApprovalSessionLifecycleState,
} from './loop/session-state.js';

export {
  AgentLoop,
  AgentLoopCrashError,
  AgentLoopInvariantError,
  PROMPTED_TOOL_CALL_PREFIX,
  PROMPTED_TOOL_RESULT_PREFIX,
  UnknownToolResultError,
} from './loop/agent-loop.js';
export { formatContextAssembly } from './loop/context.js';
export type {
  AgentLoopOptions,
  AgentLoopSleeper,
  AgentLoopStrategySelections,
  DryRunContextOptions,
  DryRunContextResult,
  RunTurnOptions,
  StrategySelection,
  TurnResult,
} from './loop/agent-loop.js';
