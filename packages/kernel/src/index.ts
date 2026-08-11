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
  AgentDefinitionSummary,
  AgentEvent,
  AgentEventType,
  CheckpointCreatedEvent,
  CompactionAppliedEvent,
  ContextAssembly,
  EventRange,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ModelCost,
  ModelDeltaEvent,
  ModelRequestEvent,
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

export { ScriptedModelExhaustedError, ScriptedModelPort } from './ports/model.js';
export type {
  FinishModelChunk,
  ModelCapabilities,
  ModelChunk,
  ModelFinishReason,
  ModelMessage,
  ModelMessageRole,
  ModelPort,
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
  EchoTool,
  FailingTool,
  ResultFailingTool,
  SlowTool,
  ToolRegistry,
  ToolRegistryError,
} from './tools/tool.js';
export type {
  Tool,
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
  RetryDecision,
  RetryOperation,
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
  UnknownToolResultError,
} from './loop/agent-loop.js';
export type {
  AgentLoopOptions,
  AgentLoopSleeper,
  AgentLoopStrategySelections,
  RunTurnOptions,
  StrategySelection,
  TurnResult,
} from './loop/agent-loop.js';
