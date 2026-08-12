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

export interface MySqlStoreOptions {
  readonly uri: string;
}

export const MYSQL_STORE_CAPABILITIES = Object.freeze({
  atomicCas: true,
  sequence: 'contiguous',
  readConsistency: 'strong-primary',
  durability: 'committed',
} satisfies StoreCapabilities);

interface MySqlQueryable {
  query(sql: string, values?: readonly unknown[]): Promise<readonly [unknown, unknown]>;
}

interface MySqlConnection extends MySqlQueryable {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

interface MySqlPool extends MySqlQueryable {
  getConnection(): Promise<MySqlConnection>;
  end(): Promise<void>;
}

interface MySqlDriver {
  createPool(uri: string): MySqlPool;
}

export class MySqlStore implements StorePort {
  readonly capabilities = MYSQL_STORE_CAPABILITIES;
  readonly kv: KvPort;
  readonly eventLog: StorePort['eventLog'];

  readonly #pool: MySqlPool;
  #closed = false;

  private constructor(pool: MySqlPool) {
    this.#pool = pool;
    this.kv = new MySqlKv(pool, () => this.#assertOpen());
    this.eventLog = Object.freeze({
      open: (identity: EventStreamIdentity) => {
        this.#assertOpen();
        return new MySqlEventLog(pool, identity, () => this.#assertOpen());
      },
    });
  }

  static async create(options: MySqlStoreOptions): Promise<MySqlStore> {
    if (options.uri.length === 0) throw new Error('MySQL uri must be non-empty.');
    const specifier = 'mysql2/promise';
    let driver: MySqlDriver;
    try {
      driver = (await import(specifier)) as unknown as MySqlDriver;
    } catch (error) {
      throw new Error(
        'MySQL Store requires the optional peer dependency "mysql2". Install it in the application.',
        { cause: error },
      );
    }
    const pool = driver.createPool(options.uri);
    try {
      await pool.query('SELECT 1');
      await initializeMySql(pool);
      return new MySqlStore(pool);
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      await this.#pool.end();
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('MySQL store is closed.');
  }
}

class MySqlKv implements KvPort {
  readonly #pool: MySqlPool;
  readonly #assertOpen: () => void;

  constructor(pool: MySqlPool, assertOpen: () => void) {
    this.#pool = pool;
    this.#assertOpen = assertOpen;
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    this.#assertOpen();
    const [raw] = await this.#pool.query('SELECT value FROM oac_kv WHERE entry_key = ?', [key]);
    const row = rows(raw)[0] as { readonly value?: Uint8Array } | undefined;
    return row?.value === undefined ? undefined : new Uint8Array(row.value);
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.#assertOpen();
    await this.#pool.query(
      `INSERT INTO oac_kv (entry_key, value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [key, value],
    );
  }

  async delete(key: string): Promise<boolean> {
    this.#assertOpen();
    const [raw] = await this.#pool.query('DELETE FROM oac_kv WHERE entry_key = ?', [key]);
    const result = raw as { readonly affectedRows?: number };
    return (result.affectedRows ?? 0) > 0;
  }
}

class MySqlEventLog implements EventLog {
  readonly tenantId: string;
  readonly sessionId: string;

  readonly #pool: MySqlPool;
  readonly #assertOpen: () => void;
  readonly #subscribers = new ProcessLocalSubscribers();

  constructor(pool: MySqlPool, identity: EventStreamIdentity, assertOpen: () => void) {
    assertStoreIdentity(identity);
    this.#pool = pool;
    this.#assertOpen = assertOpen;
    this.tenantId = identity.tenantId;
    this.sessionId = identity.sessionId;
  }

  async append(event: AgentEvent, expectedLastSeq?: number): Promise<void> {
    this.#assertOpen();
    const identity = this.#identity();
    assertAppendInput(identity, event, expectedLastSeq);
    const connection = await this.#pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(
        'INSERT IGNORE INTO oac_event_streams (tenant_id, session_id, last_seq) VALUES (?, ?, -1)',
        [this.tenantId, this.sessionId],
      );
      const [raw] = await connection.query(
        `SELECT last_seq FROM oac_event_streams
         WHERE tenant_id = ? AND session_id = ? FOR UPDATE`,
        [this.tenantId, this.sessionId],
      );
      const row = rows(raw)[0] as { readonly last_seq?: unknown } | undefined;
      const actualLastSeq = safeInteger(row?.last_seq, 'MySQL stream head');
      if (expectedLastSeq !== undefined && expectedLastSeq !== actualLastSeq) {
        throw new EventLogConflictError(expectedLastSeq, actualLastSeq);
      }
      assertContiguousSequence(event, actualLastSeq);
      await connection.query(
        'INSERT INTO oac_events (tenant_id, session_id, seq, event_json) VALUES (?, ?, ?, ?)',
        [this.tenantId, this.sessionId, event.seq, JSON.stringify(structuredClone(event))],
      );
      await connection.query(
        'UPDATE oac_event_streams SET last_seq = ? WHERE tenant_id = ? AND session_id = ?',
        [event.seq, this.tenantId, this.sessionId],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
    this.#subscribers.notify(event);
  }

  read(fromSeq: number): AsyncIterable<AgentEvent> {
    this.#assertOpen();
    assertReadCursor(fromSeq);
    return repeatableSnapshot(this.#readSnapshot(fromSeq));
  }

  subscribe(subscriber: EventSubscriber, onError?: SubscriberErrorHandler): Unsubscribe {
    return this.#subscribers.subscribe(subscriber, onError);
  }

  async #readSnapshot(fromSeq: number): Promise<readonly AgentEvent[]> {
    const connection = await this.#pool.getConnection();
    try {
      await connection.beginTransaction();
      const [headRaw] = await connection.query(
        'SELECT last_seq FROM oac_event_streams WHERE tenant_id = ? AND session_id = ?',
        [this.tenantId, this.sessionId],
      );
      const headRow = rows(headRaw)[0] as { readonly last_seq?: unknown } | undefined;
      const head = headRow === undefined ? -1 : safeInteger(headRow.last_seq, 'MySQL stream head');
      if (head < fromSeq) {
        await connection.commit();
        return [];
      }
      const [eventRaw] = await connection.query(
        `SELECT event_json FROM oac_events
         WHERE tenant_id = ? AND session_id = ? AND seq >= ? AND seq <= ? ORDER BY seq`,
        [this.tenantId, this.sessionId, fromSeq, head],
      );
      const events = rows(eventRaw).map((row) => {
        const value = (row as { readonly event_json?: unknown }).event_json;
        return parseStoredEvent(String(value), this.#identity());
      });
      await connection.commit();
      return events;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  #identity(): EventStreamIdentity {
    return { tenantId: this.tenantId, sessionId: this.sessionId };
  }
}

async function initializeMySql(pool: MySqlPool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oac_event_streams (
      tenant_id VARBINARY(512) NOT NULL,
      session_id VARBINARY(512) NOT NULL,
      last_seq BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, session_id)
    ) ENGINE=InnoDB
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oac_events (
      tenant_id VARBINARY(512) NOT NULL,
      session_id VARBINARY(512) NOT NULL,
      seq BIGINT NOT NULL,
      event_json LONGTEXT NOT NULL,
      PRIMARY KEY (tenant_id, session_id, seq)
    ) ENGINE=InnoDB
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oac_kv (
      entry_key VARBINARY(1024) NOT NULL PRIMARY KEY,
      value LONGBLOB NOT NULL
    ) ENGINE=InnoDB
  `);
}

function rows(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error('MySQL driver returned a non-row result.');
  return value;
}
