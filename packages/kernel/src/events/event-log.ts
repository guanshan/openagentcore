import type { AgentEvent } from './types.js';

export interface EventStreamIdentity {
  readonly tenantId: string;
  readonly sessionId: string;
}

export type EventSubscriber = (event: AgentEvent) => void;

export type SubscriberErrorHandler = (error: unknown, event: AgentEvent) => void;

export type Unsubscribe = () => void;

export interface EventLog extends EventStreamIdentity {
  /**
   * Appends an event after atomically comparing the current head when expectedLastSeq is supplied.
   * The head of an empty stream is -1; omitting expectedLastSeq performs an unconditional append.
   */
  append(event: AgentEvent, expectedLastSeq?: number): Promise<void>;

  /**
   * Returns a repeatable, finite snapshot whose inclusive cursor is fromSeq.
   * Distributed consumers persist a seq cursor and retry reads to achieve at-least-once delivery.
   */
  read(fromSeq: number): AsyncIterable<AgentEvent>;

  /**
   * Registers a process-local convenience subscriber for future successful appends.
   * This does not provide cross-process delivery; subscriber failures are isolated from append.
   */
  subscribe(subscriber: EventSubscriber, onSubscriberError?: SubscriberErrorHandler): Unsubscribe;
}

export class EventLogInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventLogInvariantError';
  }
}

export class EventLogConflictError extends Error {
  readonly expectedLastSeq: number;
  readonly actualLastSeq: number;

  constructor(expectedLastSeq: number, actualLastSeq: number) {
    super(
      `EventLog head conflict: expected last seq ${expectedLastSeq}, actual last seq ${actualLastSeq}.`,
    );
    this.name = 'EventLogConflictError';
    this.expectedLastSeq = expectedLastSeq;
    this.actualLastSeq = actualLastSeq;
  }
}

export class InMemoryEventLog implements EventLog {
  readonly tenantId: string;
  readonly sessionId: string;

  readonly #events: AgentEvent[] = [];
  readonly #subscribers = new Map<EventSubscriber, SubscriberErrorHandler | undefined>();

  constructor(identity: EventStreamIdentity) {
    if (identity.tenantId.length === 0 || identity.sessionId.length === 0) {
      throw new EventLogInvariantError('EventLog identity fields must be non-empty.');
    }

    this.tenantId = identity.tenantId;
    this.sessionId = identity.sessionId;
  }

  async append(event: AgentEvent, expectedLastSeq?: number): Promise<void> {
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

    if (
      expectedLastSeq !== undefined &&
      (!Number.isInteger(expectedLastSeq) || expectedLastSeq < -1)
    ) {
      throw new EventLogInvariantError(
        `expectedLastSeq must be an integer greater than or equal to -1; received ${expectedLastSeq}.`,
      );
    }

    const previous = this.#events.at(-1);
    const actualLastSeq = previous?.seq ?? -1;
    if (expectedLastSeq !== undefined && expectedLastSeq !== actualLastSeq) {
      throw new EventLogConflictError(expectedLastSeq, actualLastSeq);
    }

    if (previous !== undefined && event.seq <= previous.seq) {
      throw new EventLogInvariantError(
        `Event seq must be strictly increasing; received ${event.seq} after ${previous.seq}.`,
      );
    }

    const storedEvent = structuredClone(event);
    this.#events.push(storedEvent);
    for (const [subscriber, onSubscriberError] of this.#subscribers) {
      try {
        subscriber(structuredClone(storedEvent));
      } catch (error) {
        try {
          onSubscriberError?.(error, structuredClone(storedEvent));
        } catch {
          // Error reporting is best-effort and must not affect append or other subscribers.
        }
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
    return {
      async *[Symbol.asyncIterator]() {
        for (const event of snapshot) {
          yield structuredClone(event);
        }
      },
    };
  }

  subscribe(subscriber: EventSubscriber, onSubscriberError?: SubscriberErrorHandler): Unsubscribe {
    this.#subscribers.set(subscriber, onSubscriberError);
    let subscribed = true;

    return () => {
      if (subscribed) {
        this.#subscribers.delete(subscriber);
        subscribed = false;
      }
    };
  }
}
