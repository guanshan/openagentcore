/// <reference types="node" />

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  AgentLoop,
  EchoTool,
  InMemoryEventLog,
  ModelPortError,
  ScriptedModelPort,
  ToolRegistry,
  type AgentEvent,
  type ModelCapabilities,
  type ModelPort,
  type ModelRequest,
} from '@openagentcore/kernel';
import type { AnySchema } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it, vi } from 'vitest';

import {
  MODEL_RECORDING_KIND,
  MODEL_RECORDING_REDACTION,
  MODEL_RECORDING_SPEC_VERSION,
  ModelRecordingInvariantError,
  ModelReplayCancellationMismatchError,
  ModelReplayExhaustedError,
  ModelReplayMismatchError,
  RecordingModelPort,
  ReplayModelPort,
  type ModelRecording,
  type ModelRecordingOperation,
} from './recording.js';

const specDirectory = fileURLToPath(new URL('../../../../spec/', import.meta.url));
const vectorDirectory = `${specDirectory}model-recording-vectors/`;

type VectorExpectation = 'accepted' | 'schema-rejected' | 'replay-rejected';

interface RecordingVector {
  readonly fileName: string;
  readonly description: string;
  readonly expected: VectorExpectation;
  readonly recording: unknown;
}

const capabilities: ModelCapabilities = {
  streaming: true,
  toolUse: 'native',
  promptCaching: false,
  structuredOutput: false,
  maxContext: 128_000,
  vision: false,
};

const request: ModelRequest = {
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
  toolUse: 'none',
};

const recordingSchema = await readJson<AnySchema>(
  `${specDirectory}schemas/model-recording.v0.json`,
);
const vectors = await loadVectors();
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateRecording = ajv.compile(recordingSchema);

describe('ModelPort recording schema', () => {
  it('discovers hand-written accepted, schema-rejected, and replay-rejected vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(4);
    expect(new Set(vectors.map((vector) => vector.expected))).toEqual(
      new Set<VectorExpectation>(['accepted', 'schema-rejected', 'replay-rejected']),
    );
  });

  it.each(vectors)('$fileName: $description', (vector) => {
    const schemaAccepted = validateRecording(vector.recording);
    if (vector.expected === 'schema-rejected') {
      expect(schemaAccepted).toBe(false);
      expect(() => new ReplayModelPort(vector.recording)).toThrow(ModelRecordingInvariantError);
      return;
    }

    expect(schemaAccepted, JSON.stringify(validateRecording.errors)).toBe(true);
    if (vector.expected === 'replay-rejected') {
      expect(() => new ReplayModelPort(vector.recording)).toThrow(ModelRecordingInvariantError);
    } else {
      expect(() => new ReplayModelPort(vector.recording)).not.toThrow();
    }
  });

  it('requires capabilities.maxContext to be a positive integer', () => {
    const zeroContextRecording = {
      ...makeRecording([]),
      capabilities: { ...capabilities, maxContext: 0 },
    };

    expect(validateRecording(zeroContextRecording)).toBe(false);
    expect(() => new ReplayModelPort(zeroContextRecording)).toThrow(ModelRecordingInvariantError);
    expect(
      () => new RecordingModelPort(new ScriptedModelPort([], { capabilities: { maxContext: 0 } })),
    ).toThrow(ModelRecordingInvariantError);
  });

  it.each([
    {
      name: 'message missing content',
      recording: {
        ...makeRecording([]),
        operations: [
          {
            seq: 0,
            operation: 'countTokens',
            request: { messages: [{ role: 'user' }], tools: [], toolUse: 'none' },
            outcome: { kind: 'returned', atMs: 0, tokens: 1 },
          },
        ],
      },
    },
    {
      name: 'tool missing inputSchema',
      recording: {
        ...makeRecording([]),
        operations: [
          {
            seq: 0,
            operation: 'countTokens',
            request: {
              messages: [],
              tools: [{ name: 'echo' }],
              toolUse: 'native',
            },
            outcome: { kind: 'returned', atMs: 0, tokens: 1 },
          },
        ],
      },
    },
    {
      name: 'usage missing token fields',
      recording: {
        ...makeRecording([]),
        operations: [
          {
            seq: 0,
            operation: 'stream',
            request,
            frames: [
              { kind: 'chunk', atMs: 0, chunk: { kind: 'usage', usage: {} } },
              { kind: 'completed', atMs: 0 },
            ],
          },
        ],
      },
    },
    {
      name: 'duplicate redaction key',
      recording: {
        ...makeRecording([]),
        redaction: {
          replacement: MODEL_RECORDING_REDACTION,
          sensitiveKeys: ['authorization', 'authorization'],
          pointers: [],
        },
      },
    },
  ])('rejects nested data rejected by the schema: $name', ({ recording }) => {
    expect(validateRecording(recording)).toBe(false);
    expect(() => new ReplayModelPort(recording)).toThrow(ModelRecordingInvariantError);
  });
});

describe('RecordingModelPort and ReplayModelPort', () => {
  it('replays a complete multi-step AgentLoop turn with identical events except timestamps', async () => {
    const scripted = new ScriptedModelPort([
      [
        { kind: 'tool-call', callId: 'call-recorded', tool: 'echo', args: { text: 'ping' } },
        {
          kind: 'usage',
          usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
        },
        { kind: 'finish', reason: 'tool-calls' },
      ],
      [
        { kind: 'text', text: 'Echo complete.' },
        {
          kind: 'usage',
          usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 },
        },
        { kind: 'finish', reason: 'stop' },
      ],
    ]);
    const recorder = new RecordingModelPort(scripted);
    const originalTool = new EchoTool();
    const originalLoop = createIntegrationLoop(recorder, originalTool, '2026-08-11T00:00:00Z');
    const input = { content: 'Echo ping, then report completion.' } as const;

    const original = await originalLoop.runTurn(input);
    const recording = recorder.snapshot();
    expect(
      recording.operations.filter((operation) => operation.operation === 'stream'),
    ).toHaveLength(2);
    expect(originalTool.requests).toHaveLength(1);
    expect(original.events.some((event) => event.type === 'tool.result')).toBe(true);

    const replay = new ReplayModelPort(recording);
    const replayTool = new EchoTool();
    const replayLoop = createIntegrationLoop(replay, replayTool, '2026-08-11T00:01:00Z');
    const replayed = await replayLoop.runTurn(input);

    expect(replayTool).not.toBe(originalTool);
    expect(replayTool.requests).toEqual(originalTool.requests);
    expect(eventsWithoutTimestamps(replayed.events)).toEqual(
      eventsWithoutTimestamps(original.events),
    );
    replay.assertExhausted();
  });

  it('round-trips normalized calls, redacts secrets, and reconstructs ModelPortError', async () => {
    const mutableCapabilities = { ...capabilities };
    const received: ModelRequest[] = [];
    const failure = new ModelPortError(
      'rate-limit',
      'credential top-secret rejected pointer-secret and client-secret',
      {
        retryable: true,
        status: 429,
        retryAfterMs: 2_000,
        providerCode: 'pointer-secret',
        details: { api_key: 'detail-secret', safe: 'kept' },
      },
    );
    const delegate: ModelPort = {
      capabilities: mutableCapabilities,
      async countTokens(receivedRequest, signal) {
        signal.throwIfAborted();
        received.push(receivedRequest);
        return 11;
      },
      async *stream(receivedRequest, signal) {
        signal.throwIfAborted();
        received.push(receivedRequest);
        yield { kind: 'text', text: 'partial' };
        throw failure;
      },
    };
    const clockValues = [10, 14, 30, 33, 39];
    const recorder = new RecordingModelPort(delegate, {
      now: () => {
        const value = clockValues.shift();
        if (value === undefined) throw new Error('Clock exhausted.');
        return value;
      },
      additionalSensitiveKeys: ['clientSecret'],
      redactPointers: ['/metadata/private'],
    });
    const secretRequest: ModelRequest = {
      ...request,
      metadata: {
        Authorization: 'Bearer top-secret',
        apiKey: 'api-secret',
        clientSecret: 'client-secret',
        private: 'pointer-secret',
        safe: 'kept',
      },
    };

    await expect(recorder.countTokens(secretRequest, new AbortController().signal)).resolves.toBe(
      11,
    );
    const recordedStream = recorder.stream(secretRequest, new AbortController().signal);
    const iterator = recordedStream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { kind: 'text', text: 'partial' },
    });
    await expect(iterator.next()).rejects.toBe(failure);

    expect(received).toEqual([secretRequest, secretRequest]);
    mutableCapabilities.maxContext = 1;
    const recording = recorder.snapshot();
    expect(validateRecording(recording), JSON.stringify(validateRecording.errors)).toBe(true);
    expect(recording.capabilities.maxContext).toBe(128_000);
    expect(recording.operations.map((operation) => operation.operation)).toEqual([
      'countTokens',
      'stream',
    ]);
    expect(recording.operations[0]).toMatchObject({
      seq: 0,
      outcome: { kind: 'returned', atMs: 4, tokens: 11 },
    });
    expect(recording.operations[1]).toMatchObject({
      seq: 1,
      frames: [
        { kind: 'chunk', atMs: 3 },
        { kind: 'error', atMs: 9 },
      ],
    });
    expect(Object.isFrozen(recording)).toBe(true);
    expect(Object.isFrozen(recording.operations)).toBe(true);

    const serialized = JSON.stringify(recording);
    for (const secret of [
      'top-secret',
      'api-secret',
      'client-secret',
      'pointer-secret',
      'detail-secret',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain(MODEL_RECORDING_REDACTION);
    expect(serialized).toContain('kept');

    const replayRequest: ModelRequest = {
      ...secretRequest,
      metadata: {
        Authorization: 'Bearer replacement-auth',
        apiKey: 'replacement-api-key',
        clientSecret: 'replacement-client-secret',
        private: 'replacement-private',
        safe: 'kept',
      },
    };
    const replay = new ReplayModelPort(recording);
    await expect(replay.countTokens(replayRequest, new AbortController().signal)).resolves.toBe(11);
    const replayedStream = replay.stream(replayRequest, new AbortController().signal);
    const replayIterator = replayedStream[Symbol.asyncIterator]();
    await expect(replayIterator.next()).resolves.toMatchObject({
      value: { kind: 'text', text: 'partial' },
    });

    let replayFailure: unknown;
    try {
      await replayIterator.next();
    } catch (error) {
      replayFailure = error;
    }
    expect(replayFailure).toBeInstanceOf(ModelPortError);
    expect(replayFailure).toMatchObject({
      kind: 'rate-limit',
      retryable: true,
      status: 429,
      retryAfterMs: 2_000,
      providerCode: MODEL_RECORDING_REDACTION,
      details: { api_key: MODEL_RECORDING_REDACTION, safe: 'kept' },
    });
    expect((replayFailure as Error).message).not.toContain('top-secret');
    replay.assertExhausted();
  });

  it('matches requests strictly without consuming a mismatched operation', async () => {
    const replay = new ReplayModelPort(
      makeRecording([
        {
          seq: 0,
          operation: 'countTokens',
          request,
          outcome: { kind: 'returned', atMs: 0, tokens: 3 },
        },
      ]),
    );
    const wrongRequest: ModelRequest = {
      ...request,
      messages: [{ role: 'user', content: 'different' }],
    };

    let mismatch: unknown;
    try {
      await replay.countTokens(wrongRequest, new AbortController().signal);
    } catch (error) {
      mismatch = error;
    }
    expect(mismatch).toBeInstanceOf(ModelReplayMismatchError);
    expect(mismatch).toMatchObject({ path: '/request/messages/0/content' });

    await expect(replay.countTokens(request, new AbortController().signal)).resolves.toBe(3);
    replay.assertExhausted();
    await expect(replay.countTokens(request, new AbortController().signal)).rejects.toBeInstanceOf(
      ModelReplayExhaustedError,
    );
  });

  it('redacts overlapping secret values longest-first', async () => {
    const delegate: ModelPort = {
      capabilities,
      async countTokens() {
        throw new Error('credential abcdef was rejected');
      },
      async *stream() {
        yield* [];
      },
    };
    const recorder = new RecordingModelPort(delegate);
    const overlappingRequest: ModelRequest = {
      ...request,
      metadata: { apiKey: 'abc', access_token: 'abcdef' },
    };

    await expect(
      recorder.countTokens(overlappingRequest, new AbortController().signal),
    ).rejects.toThrow('abcdef');
    const serialized = JSON.stringify(recorder.snapshot());
    expect(serialized).not.toContain('abcdef');
    expect(serialized).not.toContain('[REDACTED]def');
  });

  it('replays instantly by default and can preserve relative stream timing', async () => {
    const recording = makeRecording([
      {
        seq: 0,
        operation: 'stream',
        request,
        frames: [
          { kind: 'chunk', atMs: 5, chunk: { kind: 'text', text: 'a' } },
          { kind: 'chunk', atMs: 9, chunk: { kind: 'text', text: 'b' } },
          { kind: 'completed', atMs: 9 },
        ],
      },
    ]);
    const instantSleep = vi.fn(async () => undefined);
    const instant = new ReplayModelPort(recording, { sleep: instantSleep });
    await expect(collect(instant.stream(request, new AbortController().signal))).resolves.toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'b' },
    ]);
    expect(instantSleep).not.toHaveBeenCalled();

    const delays: number[] = [];
    const timed = new ReplayModelPort(recording, {
      timing: 'recorded',
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });
    await collect(timed.stream(request, new AbortController().signal));
    expect(delays).toEqual([5, 4]);
  });

  it('splits recorded delays that exceed the runtime timer limit', async () => {
    vi.useFakeTimers();
    try {
      const maximumTimerDelay = 2_147_483_647;
      const replay = new ReplayModelPort(
        makeRecording([
          {
            seq: 0,
            operation: 'stream',
            request,
            frames: [
              {
                kind: 'chunk',
                atMs: maximumTimerDelay + 5,
                chunk: { kind: 'text', text: 'after long wait' },
              },
              { kind: 'completed', atMs: maximumTimerDelay + 5 },
            ],
          },
        ]),
        { timing: 'recorded' },
      );
      const pending = collect(replay.stream(request, new AbortController().signal));
      let settled = false;
      void pending.finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(maximumTimerDelay);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(5);
      await expect(pending).resolves.toEqual([{ kind: 'text', text: 'after long wait' }]);
      replay.assertExhausted();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects consumer return that does not match the recorded terminal', async () => {
    const replay = new ReplayModelPort(
      makeRecording([
        {
          seq: 0,
          operation: 'stream',
          request,
          frames: [
            { kind: 'chunk', atMs: 0, chunk: { kind: 'text', text: 'first' } },
            { kind: 'completed', atMs: 0 },
          ],
        },
      ]),
    );
    const stream = replay.stream(request, new AbortController().signal);
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    await expect(iterator.return?.()).rejects.toBeInstanceOf(ModelReplayMismatchError);
  });

  it('records AbortSignal cancellation as cancellation, never as a provider error', async () => {
    const delegate: ModelPort = {
      capabilities,
      async countTokens(_request, signal) {
        signal.throwIfAborted();
        return await new Promise<number>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      async *stream() {
        yield* [];
      },
    };
    const recorder = new RecordingModelPort(delegate, { now: sequenceClock([0, 2]) });
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const pending = recorder.countTokens(request, controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    const recording = recorder.snapshot();
    expect(recording.operations[0]).toMatchObject({
      operation: 'countTokens',
      outcome: { kind: 'cancelled', atMs: 2 },
    });

    const nonAbortedReplay = new ReplayModelPort(recording);
    let mismatch: unknown;
    try {
      await nonAbortedReplay.countTokens(request, new AbortController().signal);
    } catch (error) {
      mismatch = error;
    }
    expect(mismatch).toBeInstanceOf(ModelReplayCancellationMismatchError);
    expect(mismatch).not.toBeInstanceOf(ModelPortError);

    const replayController = new AbortController();
    const replayReason = new Error('replay cancelled');
    const cancelledReplay = new ReplayModelPort(recording, {
      timing: 'recorded',
      sleep: async () => {
        replayController.abort(replayReason);
      },
    });
    await expect(cancelledReplay.countTokens(request, replayController.signal)).rejects.toBe(
      replayReason,
    );
    cancelledReplay.assertExhausted();
  });

  it('does not consume on pre-abort and records early iterator return as cancellation', async () => {
    let delegateCleanups = 0;
    const delegate: ModelPort = {
      capabilities,
      async countTokens() {
        return 0;
      },
      async *stream(_request, signal) {
        try {
          signal.throwIfAborted();
          yield { kind: 'text', text: 'first' };
          yield { kind: 'text', text: 'second' };
        } finally {
          delegateCleanups += 1;
        }
      },
    };
    const recorder = new RecordingModelPort(delegate, { now: sequenceClock([0, 1, 2]) });
    const iterator = recorder.stream(request, new AbortController().signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { text: 'first' } });
    await iterator.return?.();
    expect(delegateCleanups).toBe(1);
    const recording = recorder.snapshot();
    expect(recording.operations[0]).toMatchObject({
      frames: [
        { kind: 'chunk', atMs: 1 },
        { kind: 'cancelled', atMs: 2 },
      ],
    });
    const cancellationReplay = new ReplayModelPort(recording);
    const cancellationStream = cancellationReplay.stream(request, new AbortController().signal);
    const replayIterator = cancellationStream[Symbol.asyncIterator]();
    await replayIterator.next();
    await expect(replayIterator.return?.()).resolves.toMatchObject({ done: true });
    cancellationReplay.assertExhausted();

    const returnedRecording = makeRecording([
      {
        seq: 0,
        operation: 'countTokens',
        request,
        outcome: { kind: 'returned', atMs: 0, tokens: 8 },
      },
    ]);
    const replay = new ReplayModelPort(returnedRecording);
    const preAborted = new AbortController();
    const preAbortReason = new Error('already cancelled');
    preAborted.abort(preAbortReason);
    await expect(replay.countTokens(request, preAborted.signal)).rejects.toBe(preAbortReason);
    await expect(replay.countTokens(request, new AbortController().signal)).resolves.toBe(8);
    replay.assertExhausted();
  });
});

function makeRecording(operations: readonly ModelRecordingOperation[]): ModelRecording {
  return {
    specVersion: MODEL_RECORDING_SPEC_VERSION,
    kind: MODEL_RECORDING_KIND,
    capabilities,
    redaction: {
      replacement: MODEL_RECORDING_REDACTION,
      sensitiveKeys: [],
      pointers: [],
    },
    operations,
  };
}

function createIntegrationLoop(model: ModelPort, tool: EchoTool, timestamp: string): AgentLoop {
  return new AgentLoop({
    eventLog: new InMemoryEventLog({
      tenantId: 'tenant-recording-integration',
      sessionId: 'session-recording-integration',
    }),
    model,
    tools: new ToolRegistry().register(tool),
    now: () => timestamp,
    sleep: async (_delayMs, signal) => signal.throwIfAborted(),
  });
}

function eventsWithoutTimestamps(events: readonly AgentEvent[]): readonly unknown[] {
  return events.map((event) =>
    Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'ts')),
  );
}

function sequenceClock(values: readonly number[]): () => number {
  const remaining = [...values];
  return () => {
    const value = remaining.shift();
    if (value === undefined) throw new Error('Clock exhausted.');
    return value;
  };
}

async function collect<TValue>(values: AsyncIterable<TValue>): Promise<TValue[]> {
  const collected: TValue[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}

async function loadVectors(): Promise<RecordingVector[]> {
  const fileNames = (await readdir(vectorDirectory))
    .filter((fileName) => fileName.endsWith('.json'))
    .sort();
  return await Promise.all(
    fileNames.map(async (fileName) => ({
      ...(await readJson<Omit<RecordingVector, 'fileName'>>(`${vectorDirectory}${fileName}`)),
      fileName,
    })),
  );
}

async function readJson<TValue>(path: string): Promise<TValue> {
  return JSON.parse(await readFile(path, 'utf8')) as TValue;
}
