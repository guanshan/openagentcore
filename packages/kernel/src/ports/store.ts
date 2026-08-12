import type { EventLog, EventStreamIdentity } from '../events/event-log.js';

export type StoreSequenceSemantics = 'contiguous' | 'strictly-increasing';
export type StoreReadConsistency = 'strong-primary' | 'eventual';
export type StoreDurability = 'committed' | 'deployment-configured' | 'volatile';

export interface StoreCapabilities {
  /** append(expectedLastSeq) compares and writes in one storage-engine operation. */
  readonly atomicCas: boolean;
  /** Whether accepted event sequence numbers must be adjacent or only monotonic. */
  readonly sequence: StoreSequenceSemantics;
  /** The consistency level actually used by EventLog reads. */
  readonly readConsistency: StoreReadConsistency;
  /** What an acknowledged append says about survival beyond the current process. */
  readonly durability: StoreDurability;
}

/** A small byte-native primitive for provider-owned durable metadata such as consumer cursors. */
export interface KvPort {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** Opens an identity-scoped EventLog without leaking database handles into Kernel APIs. */
export interface EventLogPort {
  open(identity: EventStreamIdentity): EventLog;
}

export interface StorePort {
  readonly capabilities: StoreCapabilities;
  readonly kv: KvPort;
  readonly eventLog: EventLogPort;
  close?(): Promise<void>;
}
