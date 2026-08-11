import type { AgentEvent } from './types.js';

export interface EventStreamIdentity {
  readonly tenantId: string;
  readonly sessionId: string;
}

export type EventSubscriber = (event: AgentEvent) => void;

export type Unsubscribe = () => void;

export interface EventLog extends EventStreamIdentity {
  append(event: AgentEvent): Promise<void>;
  read(fromSeq: number): AsyncIterable<AgentEvent>;
  subscribe(subscriber: EventSubscriber): Unsubscribe;
}

export class EventLogInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventLogInvariantError';
  }
}

export class InMemoryEventLog implements EventLog {
  readonly tenantId: string;
  readonly sessionId: string;

  readonly #events: AgentEvent[] = [];
  readonly #subscribers = new Set<EventSubscriber>();

  constructor(identity: EventStreamIdentity) {
    if (identity.tenantId.length === 0 || identity.sessionId.length === 0) {
      throw new EventLogInvariantError('EventLog identity fields must be non-empty.');
    }

    this.tenantId = identity.tenantId;
    this.sessionId = identity.sessionId;
  }

  async append(event: AgentEvent): Promise<void> {
    if (event.tenantId !== this.tenantId || event.sessionId !== this.sessionId) {
      throw new EventLogInvariantError(
        `Event identity ${event.tenantId}/${event.sessionId} does not match log identity ${this.tenantId}/${this.sessionId}.`,
      );
    }

    if (!Number.isInteger(event.seq) || event.seq < 0) {
      throw new EventLogInvariantError(
        `Event seq must be a non-negative integer; received ${event.seq}.`,
      );
    }

    const previous = this.#events.at(-1);
    if (previous !== undefined && event.seq <= previous.seq) {
      throw new EventLogInvariantError(
        `Event seq must be strictly increasing; received ${event.seq} after ${previous.seq}.`,
      );
    }

    const storedEvent = structuredClone(event);
    this.#events.push(storedEvent);
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(structuredClone(storedEvent));
      } catch {
        continue;
      }
    }
  }

  read(fromSeq: number): AsyncIterable<AgentEvent> {
    if (!Number.isInteger(fromSeq) || fromSeq < 0) {
      throw new EventLogInvariantError(
        `read(fromSeq) requires a non-negative integer; received ${fromSeq}.`,
      );
    }

    const snapshot = this.#events
      .filter((event) => event.seq >= fromSeq)
      .map((event) => structuredClone(event));
    return (async function* readSnapshot() {
      yield* snapshot;
    })();
  }

  subscribe(subscriber: EventSubscriber): Unsubscribe {
    this.#subscribers.add(subscriber);
    let subscribed = true;

    return () => {
      if (subscribed) {
        this.#subscribers.delete(subscriber);
        subscribed = false;
      }
    };
  }
}
