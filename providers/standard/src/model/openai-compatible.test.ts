import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import type { ModelChunk, ModelPortError, ModelRequest } from '@openagentcore/kernel';
import { describe, expect, it } from 'vitest';

import {
  estimateTokensByCharacters,
  OpenAICompatibleConfigError,
  OpenAICompatibleModel,
} from './openai-compatible.js';

const noToolsRequest: ModelRequest = {
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
  toolUse: 'none',
};

describe('OpenAICompatibleModel', () => {
  it('uses conservative capabilities and validates endpoint configuration', () => {
    const model = createModel(async () => streamResponse(stopStream()), {
      capabilities: { maxContext: 8_192 },
    });

    expect(model.capabilities).toEqual({
      streaming: true,
      toolUse: 'prompted',
      promptCaching: false,
      structuredOutput: false,
      maxContext: 8_192,
      vision: false,
    });
    expect(Object.isFrozen(model.capabilities)).toBe(true);

    expect(
      () =>
        new OpenAICompatibleModel({
          baseUrl: 'not a URL',
          model: 'demo',
          capabilities: { maxContext: 1 },
        }),
    ).toThrow(/baseUrl/);
    expect(
      () =>
        new OpenAICompatibleModel({
          baseUrl: 'http://127.0.0.1/v1',
          model: ' ',
          capabilities: { maxContext: 1 },
        }),
    ).toThrow(/model/);
    expect(
      () =>
        new OpenAICompatibleModel({
          baseUrl: 'http://127.0.0.1/v1',
          model: 'demo',
          capabilities: { maxContext: 0 },
        }),
    ).toThrow(OpenAICompatibleConfigError);

    let credentialError: unknown;
    try {
      new OpenAICompatibleModel({
        baseUrl: 'http://user:super-secret@127.0.0.1/v1',
        model: 'demo',
        capabilities: { maxContext: 1 },
      });
    } catch (error) {
      credentialError = error;
    }
    expect(credentialError).toBeInstanceOf(OpenAICompatibleConfigError);
    expect(credentialError).toMatchObject({ path: 'baseUrl' });
    expect(String(credentialError)).not.toContain('super-secret');
  });

  it('maps native messages and tools, aggregates indexed tool fragments, usage, and finish', async () => {
    let requestedUrl: string | undefined;
    let requestedInit: RequestInit | undefined;
    const fetchMock: typeof globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return streamResponse(
        sse([
          chunk({ choices: [choice({ content: 'Using tools. ' })] }),
          chunk({
            choices: [
              choice({
                tool_calls: [toolFragment(1, 'call-b', 'beta', '{"value":')],
              }),
            ],
          }),
          chunk({
            choices: [
              choice({
                tool_calls: [toolFragment(0, 'call-a', 'alpha', '{"value":')],
              }),
            ],
          }),
          chunk({
            choices: [choice({ tool_calls: [toolFragment(1, null, null, '2}')] })],
          }),
          chunk({
            choices: [choice({ tool_calls: [toolFragment(0, null, null, '1}')] })],
          }),
          chunk({ choices: [choice({}, 'tool_calls')] }),
          chunk({
            choices: [],
            usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
          }),
          '[DONE]',
        ]),
        [1, 2, 5, 3, 8, 13],
      );
    };
    const model = createModel(fetchMock, {
      apiKey: 'secret',
      capabilities: { maxContext: 32_768, toolUse: 'native' },
    });
    const request: ModelRequest = {
      messages: [
        { role: 'user', content: 'Use both tools.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ callId: 'old-call', tool: 'alpha', args: { value: 0 } }],
        },
        { role: 'tool', content: '{"ok":true}', toolCallId: 'old-call' },
      ],
      tools: [
        {
          name: 'alpha',
          description: 'First tool.',
          inputSchema: { type: 'object', properties: { value: { type: 'number' } } },
        },
        { name: 'beta', inputSchema: { type: 'object' } },
      ],
      toolUse: 'native',
    };

    await expect(collect(model.stream(request, new AbortController().signal))).resolves.toEqual([
      { kind: 'text', text: 'Using tools. ' },
      { kind: 'tool-call', callId: 'call-a', tool: 'alpha', args: { value: 1 } },
      { kind: 'tool-call', callId: 'call-b', tool: 'beta', args: { value: 2 } },
      { kind: 'usage', usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } },
      { kind: 'finish', reason: 'tool-calls' },
    ] satisfies readonly ModelChunk[]);

    expect(requestedUrl).toBe('http://127.0.0.1:11434/v1/chat/completions');
    const headers = new Headers(requestedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer secret');
    const body = JSON.parse(String(requestedInit?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'demo',
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: 'auto',
    });
    expect(body['tools']).toHaveLength(2);
    expect(body['messages']).toEqual([
      { role: 'user', content: 'Use both tools.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'old-call',
            type: 'function',
            function: { name: 'alpha', arguments: '{"value":0}' },
          },
        ],
      },
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'old-call' },
    ]);
  });

  it('keeps prompted mode free of native tool fields and exposes an injectable estimator', async () => {
    let body: Record<string, unknown> | undefined;
    const model = createModel(
      async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return streamResponse(stopStream());
      },
      {
        capabilities: { maxContext: 4_096 },
        includeUsage: false,
        tokenCounter: (_request, signal) => {
          signal.throwIfAborted();
          return 23;
        },
      },
    );
    const request: ModelRequest = {
      messages: [{ role: 'user', content: 'Use the textual tool protocol.' }],
      tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
      toolUse: 'prompted',
    };

    await expect(model.countTokens(request, new AbortController().signal)).resolves.toBe(23);
    await expect(collect(model.stream(request, new AbortController().signal))).resolves.toEqual([
      { kind: 'text', text: 'done' },
      { kind: 'finish', reason: 'stop' },
    ]);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
    expect(body).not.toHaveProperty('stream_options');
    expect(estimateTokensByCharacters(request, new AbortController().signal)).toBeGreaterThan(0);
  });

  it.each([
    {
      name: 'rate limit',
      response: () =>
        new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow' } }), {
          status: 429,
          headers: { 'retry-after': '1.25' },
        }),
      expected: { kind: 'rate-limit', status: 429, retryable: true, retryAfterMs: 1_250 },
    },
    {
      name: 'service failure',
      response: () =>
        new Response(JSON.stringify({ error: { message: 'unavailable' } }), { status: 503 }),
      expected: { kind: 'service', status: 503, retryable: true },
    },
    {
      name: 'content filter',
      response: () =>
        new Response(JSON.stringify({ error: { code: 'content_filter', message: 'blocked' } }), {
          status: 400,
        }),
      expected: { kind: 'content-filter', status: 400, retryable: false },
    },
  ])('maps HTTP $name errors', async ({ response, expected }) => {
    const model = createModel(async () => response());

    await expect(
      collect(model.stream(noToolsRequest, new AbortController().signal)),
    ).rejects.toMatchObject(expected);
  });

  it('maps internal timeout and passes an aborting signal to fetch', async () => {
    let fetchSignal: AbortSignal | undefined;
    const fetchMock: typeof globalThis.fetch = async (_input, init) => {
      fetchSignal = init?.signal as AbortSignal;
      return await new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener('abort', () => reject(fetchSignal?.reason), { once: true });
      });
    };
    const model = createModel(fetchMock, { timeoutMs: 5 });

    await expect(
      collect(model.stream(noToolsRequest, new AbortController().signal)),
    ).rejects.toMatchObject({ kind: 'timeout', retryable: true });
    expect(fetchSignal?.aborted).toBe(true);
  });

  it('propagates caller cancellation and aborts the in-flight fetch', async () => {
    let fetchSignal: AbortSignal | undefined;
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const fetchMock: typeof globalThis.fetch = async (_input, init) => {
      fetchSignal = init?.signal as AbortSignal;
      markFetchStarted?.();
      return await new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener('abort', () => reject(fetchSignal?.reason), { once: true });
      });
    };
    const model = createModel(fetchMock);
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const pending = collect(model.stream(noToolsRequest, controller.signal));
    await fetchStarted;

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(fetchSignal?.aborted).toBe(true);
    expect(fetchSignal?.reason).toBe(reason);
  });

  it('maps SSE through global fetch and closes a loopback HTTP response on caller abort', async () => {
    let requestNumber = 0;
    let firstRequestBody: Record<string, unknown> | undefined;
    let markHangingResponseClosed: (() => void) | undefined;
    const hangingResponseClosed = new Promise<void>((resolve) => {
      markHangingResponseClosed = resolve;
    });

    await withLoopbackServer(
      async (request, response) => {
        requestNumber += 1;
        const body = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });

        if (requestNumber === 1) {
          firstRequestBody = body;
          response.write(
            `data: ${chunk({
              choices: [
                choice({
                  tool_calls: [toolFragment(0, 'loopback-call', 'echo', '{"text":')],
                }),
              ],
            })}\r\n\r\n`,
          );
          response.write(
            `data: ${chunk({
              choices: [choice({ tool_calls: [toolFragment(0, null, null, '"hello"}')] })],
            })}\n\n`,
          );
          response.write(`data: ${chunk({ choices: [choice({}, 'tool_calls')] })}\n\n`);
          response.write(
            `data: ${chunk({
              choices: [],
              usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
            })}\n\n`,
          );
          response.end('data: [DONE]\n\n');
          return;
        }

        response.once('close', () => markHangingResponseClosed?.());
        response.write(`data: ${chunk({ choices: [choice({ content: 'partial' })] })}\n\n`);
      },
      async (origin) => {
        const model = new OpenAICompatibleModel({
          baseUrl: `${origin}/v1`,
          model: 'loopback-model',
          capabilities: { maxContext: 8_192, toolUse: 'native' },
        });
        const nativeRequest: ModelRequest = {
          messages: [{ role: 'user', content: 'Call echo.' }],
          tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
          toolUse: 'native',
        };

        await expect(
          collect(model.stream(nativeRequest, new AbortController().signal)),
        ).resolves.toEqual([
          {
            kind: 'tool-call',
            callId: 'loopback-call',
            tool: 'echo',
            args: { text: 'hello' },
          },
          { kind: 'usage', usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } },
          { kind: 'finish', reason: 'tool-calls' },
        ]);
        expect(firstRequestBody).toMatchObject({
          model: 'loopback-model',
          stream: true,
          tool_choice: 'auto',
        });

        const controller = new AbortController();
        const stream = model.stream({ ...noToolsRequest, toolUse: 'none' }, controller.signal);
        const iterator = stream[Symbol.asyncIterator]();
        await expect(iterator.next()).resolves.toEqual({
          done: false,
          value: { kind: 'text', text: 'partial' },
        });
        const reason = new Error('abort loopback response');
        controller.abort(reason);

        await expect(iterator.next()).rejects.toBe(reason);
        await expect(withTimeout(hangingResponseClosed, 2_000)).resolves.toBeUndefined();
      },
    );
  });

  it('rejects malformed or incomplete streams as non-retryable protocol errors', async () => {
    const model = createModel(async () =>
      streamResponse(sse([chunk({ choices: [choice({ content: 'partial' })] })])),
    );

    await expect(
      collect(model.stream(noToolsRequest, new AbortController().signal)),
    ).rejects.toMatchObject({
      name: 'ModelPortError',
      kind: 'protocol',
      retryable: false,
    } satisfies Partial<ModelPortError>);
  });
});

interface ModelOverrides {
  readonly capabilities?: ConstructorParameters<typeof OpenAICompatibleModel>[0]['capabilities'];
  readonly apiKey?: string;
  readonly includeUsage?: boolean;
  readonly timeoutMs?: number;
  readonly tokenCounter?: ConstructorParameters<typeof OpenAICompatibleModel>[0]['tokenCounter'];
}

function createModel(
  fetchImplementation: typeof globalThis.fetch,
  overrides: ModelOverrides = {},
): OpenAICompatibleModel {
  return new OpenAICompatibleModel({
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'demo',
    capabilities: overrides.capabilities ?? { maxContext: 8_192 },
    fetch: fetchImplementation,
    ...(overrides.apiKey === undefined ? {} : { apiKey: overrides.apiKey }),
    ...(overrides.includeUsage === undefined ? {} : { includeUsage: overrides.includeUsage }),
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
    ...(overrides.tokenCounter === undefined ? {} : { tokenCounter: overrides.tokenCounter }),
  });
}

function choice(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return { index: 0, delta, finish_reason: finishReason };
}

function toolFragment(
  index: number,
  id: string | null,
  name: string | null,
  argumentsFragment: string,
): Record<string, unknown> {
  return {
    index,
    id,
    type: id === null ? null : 'function',
    function: { name, arguments: argumentsFragment },
  };
}

function chunk(value: unknown): string {
  return JSON.stringify(value);
}

function stopStream(): string {
  return sse([
    chunk({ choices: [choice({ content: 'done' })] }),
    chunk({ choices: [choice({}, 'stop')] }),
    '[DONE]',
  ]);
}

function sse(data: readonly string[]): string {
  return data.map((value) => `data: ${value}\n\n`).join('');
}

function streamResponse(data: string, sizes: readonly number[] = []): Response {
  const encoded = new TextEncoder().encode(data);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        let offset = 0;
        let index = 0;
        while (offset < encoded.length) {
          const size = sizes[index] ?? encoded.length - offset;
          controller.enqueue(encoded.slice(offset, Math.min(offset + size, encoded.length)));
          offset += size;
          index += 1;
        }
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

async function collect<TValue>(values: AsyncIterable<TValue>): Promise<TValue[]> {
  const collected: TValue[] = [];
  for await (const value of values) {
    collected.push(value);
  }
  return collected;
}

async function withLoopbackServer(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    for (const socket of sockets) {
      socket.destroy();
    }
    await closed;
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunkValue of request) {
    chunks.push(Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for loopback response close.`)),
      timeoutMs,
    );
    promise.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
