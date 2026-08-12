import { DatabaseSync } from 'node:sqlite';

import {
  EventLogConflictError,
  type AgentEvent,
  type EventLog,
  type EventStreamIdentity,
  type EventSubscriber,
  type KvPort,
  type StoreCapabilities,
  type StorePort,
  type SubscriberErrorHandler,
  type Unsubscribe,
} from '@openagentcore/kernel';

import {
  assertAppendInput,
  assertContiguousSequence,
  assertReadCursor,
  assertStoreIdentity,
  parseStoredEvent,
  ProcessLocalSubscribers,
  repeatableSnapshot,
  safeInteger,
} from './support.js';

export interface SqliteStoreOptions {
  readonly filename: string;
  readonly busyTimeoutMs?: number;
}

export const SQLITE_STORE_CAPABILITIES = Object.freeze({
  atomicCas: true,
  sequence: 'contiguous',
  readConsistency: 'strong-primary',
  durability: 'committed',
} satisfies StoreCapabilities);

export class SqliteStore implements StorePort {
  readonly capabilities = SQLITE_STORE_CAPABILITIES;
  readonly kv: StorePort['kv'];
  readonly eventLog: StorePort['eventLog'];

  readonly #database: DatabaseSync;
  #closed = false;

  constructor(options: SqliteStoreOptions) {
    if (options.filename.length === 0) throw new Error('SQLite filename must be non-empty.');
    const timeout = options.busyTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeout) || timeout < 0) {
      throw new Error('SQLite busyTimeoutMs must be a non-negative safe integer.');
    }
    this.#database = new DatabaseSync(options.filename);
    this.#database.exec(`PRAGMA busy_timeout = ${String(timeout)}`);
    this.#database.exec('PRAGMA journal_mode = WAL');
    this.#database.exec('PRAGMA synchronous = FULL');
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS oac_event_streams (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        last_seq INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, session_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS oac_events (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, session_id, seq)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS oac_kv (
        key TEXT PRIMARY KEY,
        value BLOB NOT NULL
      ) STRICT;
    `);
    this.kv = new SqliteKv(this.#database, () => this.#assertOpen());
    this.eventLog = Object.freeze({
      open: (identity: EventStreamIdentity) => {
        this.#assertOpen();
        return new SqliteEventLog(this.#database, identity, () => this.#assertOpen());
      },
    });
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#database.close();
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('SQLite store is closed.');
  }
}

class SqliteKv implements KvPort {
  readonly #database: DatabaseSync;
  readonly #assertOpen: () => void;

  constructor(database: DatabaseSync, assertOpen: () => void) {
    this.#database = database;
    this.#assertOpen = assertOpen;
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    this.#assertOpen();
    const row = this.#database.prepare('SELECT value FROM oac_kv WHERE key = ?').get(key) as
      { readonly value: Uint8Array } | undefined;
    return row === undefined ? undefined : new Uint8Array(row.value);
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.#assertOpen();
    this.#database
      .prepare(
        'INSERT INTO oac_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  async delete(key: string): Promise<boolean> {
    this.#assertOpen();
    const result = this.#database.prepare('DELETE FROM oac_kv WHERE key = ?').run(key);
    return result.changes > 0;
  }
}

class SqliteEventLog implements EventLog {
  readonly tenantId: string;
  readonly sessionId: string;

  readonly #database: DatabaseSync;
  readonly #assertOpen: () => void;
  readonly #subscribers = new ProcessLocalSubscribers();

  constructor(database: DatabaseSync, identity: EventStreamIdentity, assertOpen: () => void) {
    assertStoreIdentity(identity);
    this.#database = database;
    this.#assertOpen = assertOpen;
    this.tenantId = identity.tenantId;
    this.sessionId = identity.sessionId;
  }

  async append(event: AgentEvent, expectedLastSeq?: number): Promise<void> {
    this.#assertOpen();
    const identity = this.#identity();
    assertAppendInput(identity, event, expectedLastSeq);
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#database
        .prepare('SELECT last_seq FROM oac_event_streams WHERE tenant_id = ? AND session_id = ?')
        .get(this.tenantId, this.sessionId) as { readonly last_seq: number } | undefined;
      const actualLastSeq =
        row === undefined ? -1 : safeInteger(row.last_seq, 'SQLite stream head');
      if (expectedLastSeq !== undefined && expectedLastSeq !== actualLastSeq) {
        throw new EventLogConflictError(expectedLastSeq, actualLastSeq);
      }
      assertContiguousSequence(event, actualLastSeq);
      const stored = JSON.stringify(structuredClone(event));
      this.#database
        .prepare(
          'INSERT INTO oac_events (tenant_id, session_id, seq, event_json) VALUES (?, ?, ?, ?)',
        )
        .run(this.tenantId, this.sessionId, event.seq, stored);
      this.#database
        .prepare(
          `INSERT INTO oac_event_streams (tenant_id, session_id, last_seq) VALUES (?, ?, ?)
           ON CONFLICT(tenant_id, session_id) DO UPDATE SET last_seq = excluded.last_seq`,
        )
        .run(this.tenantId, this.sessionId, event.seq);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
    this.#subscribers.notify(event);
  }

  read(fromSeq: number): AsyncIterable<AgentEvent> {
    this.#assertOpen();
    assertReadCursor(fromSeq);
    const headRow = this.#database
      .prepare('SELECT last_seq FROM oac_event_streams WHERE tenant_id = ? AND session_id = ?')
      .get(this.tenantId, this.sessionId) as { readonly last_seq: number } | undefined;
    const head = headRow === undefined ? -1 : safeInteger(headRow.last_seq, 'SQLite stream head');
    const rows =
      head < fromSeq
        ? []
        : (this.#database
            .prepare(
              `SELECT event_json FROM oac_events
               WHERE tenant_id = ? AND session_id = ? AND seq >= ? AND seq <= ? ORDER BY seq`,
            )
            .all(this.tenantId, this.sessionId, fromSeq, head) as unknown as readonly {
            readonly event_json: string;
          }[]);
    const events = rows.map((row) => parseStoredEvent(row.event_json, this.#identity()));
    return repeatableSnapshot(Promise.resolve(events));
  }

  subscribe(subscriber: EventSubscriber, onError?: SubscriberErrorHandler): Unsubscribe {
    return this.#subscribers.subscribe(subscriber, onError);
  }

  #identity(): EventStreamIdentity {
    return { tenantId: this.tenantId, sessionId: this.sessionId };
  }
}
