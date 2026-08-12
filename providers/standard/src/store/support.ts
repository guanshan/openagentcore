import {
  EventLogInvariantError,
  type AgentEvent,
  type EventStreamIdentity,
  type EventSubscriber,
  type SubscriberErrorHandler,
  type Unsubscribe,
} from '@openagentcore/kernel';

export function assertStoreIdentity(identity: EventStreamIdentity): void {
  if (identity.tenantId.length === 0 || identity.sessionId.length === 0) {
    throw new EventLogInvariantError('EventLog identity fields must be non-empty.');
  }
}

export function assertAppendInput(
  identity: EventStreamIdentity,
  event: AgentEvent,
  expectedLastSeq: number | undefined,
): void {
  if (event.tenantId !== identity.tenantId || event.sessionId !== identity.sessionId) {
    throw new EventLogInvariantError(
      `Event identity ${event.tenantId}/${event.sessionId} does not match log identity ${identity.tenantId}/${identity.sessionId}.`,
    );
  }
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
    throw new EventLogInvariantError(
      `Event seq must be a non-negative safe integer; received ${event.seq}.`,
    );
  }
  if (
    expectedLastSeq !== undefined &&
    (!Number.isSafeInteger(expectedLastSeq) || expectedLastSeq < -1)
  ) {
    throw new EventLogInvariantError(
      `expectedLastSeq must be a safe integer greater than or equal to -1; received ${expectedLastSeq}.`,
    );
  }
}

export function assertContiguousSequence(event: AgentEvent, actualLastSeq: number): void {
  const next = actualLastSeq + 1;
  if (event.seq !== next) {
    throw new EventLogInvariantError(
      `Durable EventLog requires contiguous seq ${next}; received ${event.seq}.`,
    );
  }
}

export function assertReadCursor(fromSeq: number): void {
  if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) {
    throw new EventLogInvariantError(
      `read(fromSeq) requires a non-negative safe integer; received ${fromSeq}.`,
    );
  }
}

export function parseStoredEvent(value: string, identity: EventStreamIdentity): AgentEvent {
  let event: unknown;
  try {
    event = JSON.parse(value);
  } catch (error) {
    throw new EventLogInvariantError(
      `Stored EventLog row is not valid JSON: ${errorMessage(error)}`,
    );
  }
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    throw new EventLogInvariantError('Stored EventLog row is not an event object.');
  }
  const candidate = event as Partial<AgentEvent>;
  if (
    candidate.tenantId !== identity.tenantId ||
    candidate.sessionId !== identity.sessionId ||
    !Number.isSafeInteger(candidate.seq) ||
    typeof candidate.type !== 'string'
  ) {
    throw new EventLogInvariantError('Stored EventLog row does not match its stream identity.');
  }
  return structuredClone(candidate as AgentEvent);
}

export function repeatableSnapshot(
  events: Promise<readonly AgentEvent[]>,
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of await events) {
        yield structuredClone(event);
      }
    },
  };
}

export class ProcessLocalSubscribers {
  readonly #subscribers = new Map<EventSubscriber, SubscriberErrorHandler | undefined>();

  subscribe(subscriber: EventSubscriber, onError?: SubscriberErrorHandler): Unsubscribe {
    this.#subscribers.set(subscriber, onError);
    let subscribed = true;
    return () => {
      if (subscribed) {
        subscribed = false;
        this.#subscribers.delete(subscriber);
      }
    };
  }

  notify(event: AgentEvent): void {
    for (const [subscriber, onError] of this.#subscribers) {
      try {
        const delivery = subscriber(structuredClone(event));
        if (delivery !== undefined) {
          void delivery.catch((error: unknown) => this.#report(onError, error, event));
        }
      } catch (error) {
        this.#report(onError, error, event);
      }
    }
  }

  #report(handler: SubscriberErrorHandler | undefined, error: unknown, event: AgentEvent): void {
    if (handler === undefined) return;
    try {
      const reporting = handler(error, structuredClone(event));
      if (reporting !== undefined) void reporting.catch(() => undefined);
    } catch {
      // Subscriber error reporting is best-effort and isolated from committed append operations.
    }
  }
}

export function safeInteger(value: unknown, label: string): number {
  const parsed = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new EventLogInvariantError(`${label} is outside the JavaScript safe integer range.`);
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
