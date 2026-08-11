export { EventLogInvariantError, InMemoryEventLog } from './events/event-log.js';
export type {
  EventLog,
  EventStreamIdentity,
  EventSubscriber,
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
  ModelDeltaEvent,
  ModelRequestEvent,
  PermissionRequestedEvent,
  PermissionResolvedEvent,
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
