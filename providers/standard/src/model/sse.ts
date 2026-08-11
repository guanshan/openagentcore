export interface ServerSentEvent {
  readonly data: string;
  readonly event?: string;
  readonly id?: string;
}

/**
 * Parses a WHATWG byte stream according to the Server-Sent Events line format.
 * Unknown fields and comment heartbeats are intentionally ignored.
 */
export async function* parseServerSentEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncIterable<ServerSentEvent> {
  signal.throwIfAborted();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  let eventName: string | undefined;
  let eventId: string | undefined;

  const onAbort = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });

  const acceptLine = (line: string): ServerSentEvent | undefined => {
    if (line.length === 0) {
      if (dataLines.length === 0) {
        eventName = undefined;
        return undefined;
      }
      const event: ServerSentEvent = {
        data: dataLines.join('\n'),
        ...(eventName === undefined ? {} : { event: eventName }),
        ...(eventId === undefined ? {} : { id: eventId }),
      };
      dataLines = [];
      eventName = undefined;
      return event;
    }
    if (line.startsWith(':')) {
      return undefined;
    }

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    switch (field) {
      case 'data':
        dataLines.push(value);
        break;
      case 'event':
        eventName = value;
        break;
      case 'id':
        if (!value.includes('\0')) {
          eventId = value;
        }
        break;
      default:
        break;
    }
    return undefined;
  };

  const takeLine = (atEof: boolean): string | undefined => {
    for (let index = 0; index < buffer.length; index += 1) {
      const character = buffer[index];
      if (character === '\n') {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        return line;
      }
      if (character !== '\r') {
        continue;
      }
      if (index + 1 === buffer.length && !atEof) {
        return undefined;
      }
      const consumed = buffer[index + 1] === '\n' ? index + 2 : index + 1;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(consumed);
      return line;
    }
    if (atEof && buffer.length > 0) {
      const line = buffer;
      buffer = '';
      return line;
    }
    return undefined;
  };

  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(next.value, { stream: true });
      while (true) {
        const line = takeLine(false);
        if (line === undefined) {
          break;
        }
        const event = acceptLine(line);
        if (event !== undefined) {
          yield event;
        }
      }
    }

    while (true) {
      const line = takeLine(true);
      if (line === undefined) {
        break;
      }
      const event = acceptLine(line);
      if (event !== undefined) {
        yield event;
      }
    }
    const finalEvent = acceptLine('');
    if (finalEvent !== undefined) {
      yield finalEvent;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
