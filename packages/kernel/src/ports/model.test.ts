import { describe, expect, it } from 'vitest';

import {
  ScriptedModelExhaustedError,
  ScriptedModelPort,
  type ModelChunk,
  type ModelRequest,
} from './model.js';

const request: ModelRequest = {
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
  toolUse: 'none',
};

async function collect<TValue>(values: AsyncIterable<TValue>): Promise<TValue[]> {
  const collected: TValue[] = [];
  for await (const value of values) {
    collected.push(value);
  }
  return collected;
}

describe('ScriptedModelPort', () => {
  it('yields scripted chunks in call order and records isolated requests', async () => {
    const first: readonly ModelChunk[] = [
      { kind: 'text', text: 'hello' },
      {
        kind: 'usage',
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      },
      { kind: 'finish', reason: 'stop' },
    ];
    const second: readonly ModelChunk[] = [
      { kind: 'tool-call', callId: 'call-1', tool: 'echo', args: { value: 'ok' } },
      { kind: 'finish', reason: 'tool-calls' },
    ];
    const model = new ScriptedModelPort([first, second]);
    const signal = new AbortController().signal;

    await expect(collect(model.stream(request, signal))).resolves.toEqual(first);
    await expect(collect(model.stream(request, signal))).resolves.toEqual(second);

    const recorded = model.requests[0];
    expect(recorded).toEqual(request);
    if (recorded === undefined) {
      throw new Error('Expected a recorded request.');
    }
    (recorded.messages[0] as { content: string }).content = 'mutated';
    expect(model.requests[0]).toEqual(request);
  });

  it('exposes negotiated capabilities without sharing mutable aliases', () => {
    const model = new ScriptedModelPort([], {
      capabilities: { toolUse: 'prompted', maxContext: 4_096 },
    });

    expect(model.capabilities).toMatchObject({
      streaming: true,
      toolUse: 'prompted',
      maxContext: 4_096,
    });
    expect(Object.isFrozen(model.capabilities)).toBe(true);
  });

  it('raises a scripted error after yielding a deterministic prefix', async () => {
    const interruption = new Error('stream interrupted');
    const model = new ScriptedModelPort([
      { chunks: [{ kind: 'text', text: 'partial' }], error: interruption },
    ]);
    const iterator = model.stream(request, new AbortController().signal)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { kind: 'text', text: 'partial' },
    });
    await expect(iterator.next()).rejects.toBe(interruption);
  });

  it('checks AbortSignal before starting and between chunks', async () => {
    const beforeStart = new AbortController();
    const beforeStartReason = new Error('cancelled before start');
    beforeStart.abort(beforeStartReason);
    const neverStarted = new ScriptedModelPort([[{ kind: 'text', text: 'unused' }]]);

    await expect(collect(neverStarted.stream(request, beforeStart.signal))).rejects.toBe(
      beforeStartReason,
    );
    expect(neverStarted.requests).toEqual([]);

    const duringStream = new AbortController();
    const duringStreamReason = new Error('cancelled during stream');
    const model = new ScriptedModelPort([
      [
        { kind: 'text', text: 'first' },
        { kind: 'text', text: 'second' },
      ],
    ]);
    const iterator = model.stream(request, duringStream.signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { text: 'first' } });
    duringStream.abort(duringStreamReason);
    await expect(iterator.next()).rejects.toBe(duringStreamReason);
  });

  it('returns scripted token counts, records requests, and checks AbortSignal', async () => {
    const model = new ScriptedModelPort([], { tokenCounts: [17] });
    const signal = new AbortController().signal;

    await expect(model.countTokens(request, signal)).resolves.toBe(17);
    expect(model.tokenCountRequests).toEqual([request]);
    await expect(model.countTokens(request, signal)).rejects.toBeInstanceOf(
      ScriptedModelExhaustedError,
    );

    const controller = new AbortController();
    const reason = new Error('count cancelled');
    controller.abort(reason);
    await expect(model.countTokens(request, controller.signal)).rejects.toBe(reason);
  });

  it('uses a deterministic default counter and reports exhausted stream scripts', async () => {
    const model = new ScriptedModelPort([]);
    const signal = new AbortController().signal;

    await expect(model.countTokens(request, signal)).resolves.toBe(5);
    await expect(collect(model.stream(request, signal))).rejects.toBeInstanceOf(
      ScriptedModelExhaustedError,
    );
  });
});
