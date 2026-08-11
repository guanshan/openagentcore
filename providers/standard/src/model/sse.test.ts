import { describe, expect, it } from 'vitest';

import { parseServerSentEvents } from './sse.js';

describe('parseServerSentEvents', () => {
  it('handles byte fragmentation, CRLF, comments, and multiline data', async () => {
    const bytes = new TextEncoder().encode(
      ': heartbeat\r\nevent: message\r\nid: evt-1\r\ndata: {"part":\r\ndata: "你"}\r\n\r\n' +
        'data: [DONE]\n\n',
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 1) {
          controller.enqueue(bytes.slice(offset, offset + 1));
        }
        controller.close();
      },
    });

    await expect(
      collect(parseServerSentEvents(body, new AbortController().signal)),
    ).resolves.toEqual([
      { event: 'message', id: 'evt-1', data: '{"part":\n"你"}' },
      { id: 'evt-1', data: '[DONE]' },
    ]);
  });

  it('cancels its reader when the caller aborts', async () => {
    let cancelledWith: unknown;
    const body = new ReadableStream<Uint8Array>({
      pull() {},
      cancel(reason) {
        cancelledWith = reason;
      },
    });
    const controller = new AbortController();
    const reason = new Error('stop reading');
    const pending = collect(parseServerSentEvents(body, controller.signal));

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(cancelledWith).toBe(reason);
  });

  it('discards pending data when EOF arrives before the terminating empty line', async () => {
    const bytes = new TextEncoder().encode('data: [DONE]\n');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

    await expect(
      collect(parseServerSentEvents(body, new AbortController().signal)),
    ).resolves.toEqual([]);
  });
});

async function collect<TValue>(values: AsyncIterable<TValue>): Promise<TValue[]> {
  const collected: TValue[] = [];
  for await (const value of values) {
    collected.push(value);
  }
  return collected;
}
