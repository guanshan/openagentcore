import {
  EventLogConflictError,
  EventLogInvariantError,
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
  assertReadCursor,
  assertStoreIdentity,
  parseStoredEvent,
  ProcessLocalSubscribers,
  repeatableSnapshot,
  safeInteger,
} from './support.js';

export interface RedisStoreOptions {
  readonly url: string;
  readonly keyPrefix?: string;
}

export const REDIS_STORE_CAPABILITIES = Object.freeze({
  atomicCas: true,
  sequence: 'contiguous',
  readConsistency: 'strong-primary',
  durability: 'deployment-configured',
} satisfies StoreCapabilities);

interface RedisClient {
  connect(): Promise<void>;
  quit(): Promise<unknown>;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  sendCommand(arguments_: readonly string[]): Promise<unknown>;
}

interface RedisDriver {
  createClient(options: { readonly url: string }): RedisClient;
}

const APPEND_SCRIPT = `
local head = tonumber(redis.call('GET', KEYS[1]) or '-1')
local expected = ARGV[1]
local seq = tonumber(ARGV[2])
if expected ~= '' and tonumber(expected) ~= head then
  return {0, head}
end
if seq ~= head + 1 then
  return {-1, head}
end
redis.call('ZADD', KEYS[2], seq, ARGV[3])
redis.call('SET', KEYS[1], seq)
return {1, seq}
`;

export class RedisStore implements StorePort {
  readonly capabilities = REDIS_STORE_CAPABILITIES;
  readonly kv: KvPort;
  readonly eventLog: StorePort['eventLog'];

  readonly #client: RedisClient;
  #closed = false;

  private constructor(client: RedisClient, keyPrefix: string) {
    this.#client = client;
    this.kv = new RedisKv(client, keyPrefix, () => this.#assertOpen());
    this.eventLog = Object.freeze({
      open: (identity: EventStreamIdentity) => {
        this.#assertOpen();
        return new RedisEventLog(client, keyPrefix, identity, () => this.#assertOpen());
      },
    });
  }

  static async create(options: RedisStoreOptions): Promise<RedisStore> {
    if (options.url.length === 0) throw new Error('Redis url must be non-empty.');
    const specifier = 'redis';
    let driver: RedisDriver;
    try {
      driver = (await import(specifier)) as unknown as RedisDriver;
    } catch (error) {
      throw new Error(
        'Redis Store requires the optional peer dependency "redis". Install it in the application.',
        { cause: error },
      );
    }
    const client = driver.createClient({ url: options.url });
    client.on('error', () => {
      // Command/connect promises are authoritative; observing the emitter prevents process crashes.
    });
    await client.connect();
    return new RedisStore(client, options.keyPrefix ?? 'oac');
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      await this.#client.quit();
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Redis store is closed.');
  }
}

class RedisKv implements KvPort {
  readonly #client: RedisClient;
  readonly #prefix: string;
  readonly #assertOpen: () => void;

  constructor(client: RedisClient, prefix: string, assertOpen: () => void) {
    this.#client = client;
    this.#prefix = prefix;
    this.#assertOpen = assertOpen;
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    this.#assertOpen();
    const value = await this.#client.sendCommand(['GET', this.#key(key)]);
    return value === null || value === undefined
      ? undefined
      : new Uint8Array(Buffer.from(String(value), 'base64'));
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.#assertOpen();
    await this.#client.sendCommand(['SET', this.#key(key), Buffer.from(value).toString('base64')]);
  }

  async delete(key: string): Promise<boolean> {
    this.#assertOpen();
    const deleted = await this.#client.sendCommand(['DEL', this.#key(key)]);
    return Number(deleted) > 0;
  }

  #key(key: string): string {
    return `${this.#prefix}:kv:${Buffer.from(key).toString('base64url')}`;
  }
}

class RedisEventLog implements EventLog {
  readonly tenantId: string;
  readonly sessionId: string;

  readonly #client: RedisClient;
  readonly #prefix: string;
  readonly #assertOpen: () => void;
  readonly #subscribers = new ProcessLocalSubscribers();

  constructor(
    client: RedisClient,
    prefix: string,
    identity: EventStreamIdentity,
    assertOpen: () => void,
  ) {
    assertStoreIdentity(identity);
    this.#client = client;
    this.#prefix = prefix;
    this.#assertOpen = assertOpen;
    this.tenantId = identity.tenantId;
    this.sessionId = identity.sessionId;
  }

  async append(event: AgentEvent, expectedLastSeq?: number): Promise<void> {
    this.#assertOpen();
    const identity = this.#identity();
    assertAppendInput(identity, event, expectedLastSeq);
    const [headKey, eventsKey] = this.#streamKeys();
    const raw = await this.#client.sendCommand([
      'EVAL',
      APPEND_SCRIPT,
      '2',
      headKey,
      eventsKey,
      expectedLastSeq === undefined ? '' : String(expectedLastSeq),
      String(event.seq),
      JSON.stringify(structuredClone(event)),
    ]);
    if (!Array.isArray(raw)) throw new Error('Redis append script returned an invalid result.');
    const status = Number(raw[0]);
    const actualLastSeq = safeInteger(raw[1], 'Redis stream head');
    if (status === 0 && expectedLastSeq !== undefined) {
      throw new EventLogConflictError(expectedLastSeq, actualLastSeq);
    }
    if (status === -1) {
      throw new EventLogInvariantError(
        `Durable EventLog requires contiguous seq ${actualLastSeq + 1}; received ${event.seq}.`,
      );
    }
    if (status !== 1) throw new Error(`Redis append script returned status ${String(status)}.`);
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
    const [headKey, eventsKey] = this.#streamKeys();
    const headValue = await this.#client.sendCommand(['GET', headKey]);
    const head =
      headValue === null || headValue === undefined
        ? -1
        : safeInteger(headValue, 'Redis stream head');
    if (head < fromSeq) return [];
    const raw = await this.#client.sendCommand([
      'ZRANGEBYSCORE',
      eventsKey,
      String(fromSeq),
      String(head),
    ]);
    if (!Array.isArray(raw)) throw new Error('Redis range read returned a non-array result.');
    return raw.map((value) => parseStoredEvent(String(value), this.#identity()));
  }

  #streamKeys(): readonly [string, string] {
    const identity = Buffer.from(`${this.tenantId}\u0000${this.sessionId}`).toString('base64url');
    const slot = `{${this.#prefix}:${identity}}`;
    return [`${slot}:head`, `${slot}:events`];
  }

  #identity(): EventStreamIdentity {
    return { tenantId: this.tenantId, sessionId: this.sessionId };
  }
}
