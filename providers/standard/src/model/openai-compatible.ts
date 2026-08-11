import {
  ModelPortError,
  type JsonObject,
  type JsonValue,
  type ModelCapabilities,
  type ModelChunk,
  type ModelFinishReason,
  type ModelMessage,
  type ModelPort,
  type ModelRequest,
  type ModelToolDefinition,
  type ModelToolUse,
  type ModelUsage,
  type ToolCallModelChunk,
} from '@openagentcore/kernel';

import { parseServerSentEvents } from './sse.js';
import { MAX_HTTP_TIMEOUT_MS } from './limits.js';
import { authorizationCredential, MODEL_SENSITIVE_KEYS } from './sensitive.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CHAT_COMPLETIONS_PATH = 'chat/completions';
const REDACTED_CREDENTIAL = '[REDACTED]';
const SENSITIVE_HEADER_NAMES = new Set<string>(MODEL_SENSITIVE_KEYS);

export type EstimatedTokenCounter = (
  request: ModelRequest,
  signal: AbortSignal,
) => number | Promise<number>;

export type OpenAICompatibleCapabilities = Pick<ModelCapabilities, 'maxContext'> &
  Partial<Omit<ModelCapabilities, 'maxContext'>>;

export interface OpenAICompatibleModelOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly capabilities: OpenAICompatibleCapabilities;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly includeUsage?: boolean;
  readonly requestBody?: JsonObject;
  readonly tokenCounter?: EstimatedTokenCounter;
  readonly fetch?: typeof globalThis.fetch;
}

export class OpenAICompatibleConfigError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`OpenAICompatibleModel configuration at ${path} ${message}`);
    this.name = 'OpenAICompatibleConfigError';
    this.path = path;
  }
}

/**
 * Dependency-free adapter for the OpenAI-compatible Chat Completions SSE protocol.
 */
export class OpenAICompatibleModel implements ModelPort {
  readonly capabilities: ModelCapabilities;

  readonly #url: URL;
  readonly #model: string;
  readonly #apiKey: string | undefined;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #timeoutMs: number;
  readonly #includeUsage: boolean;
  readonly #requestBody: JsonObject;
  readonly #tokenCounter: EstimatedTokenCounter;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sensitiveValues: readonly string[];

  constructor(options: OpenAICompatibleModelOptions) {
    this.#url = chatCompletionsUrl(options.baseUrl);
    this.#model = requireNonEmptyString(options.model, 'model');
    validateCapabilities(options.capabilities);
    this.capabilities = Object.freeze({
      streaming: true,
      toolUse: 'prompted',
      promptCaching: false,
      structuredOutput: false,
      vision: false,
      ...options.capabilities,
      maxContext: options.capabilities.maxContext,
    });
    this.#apiKey = optionalApiKey(options.apiKey);
    this.#headers = Object.freeze(validateHeaders(options.headers));
    const authorizationName = Object.keys(this.#headers).find(
      (name) => name.toLowerCase() === 'authorization',
    );
    if (this.#apiKey !== undefined && authorizationName !== undefined) {
      throw new OpenAICompatibleConfigError(
        `headers.${authorizationName}`,
        'conflicts with apiKey.',
      );
    }
    this.#sensitiveValues = Object.freeze(configuredSensitiveValues(this.#apiKey, this.#headers));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs <= 0 ||
      this.#timeoutMs > MAX_HTTP_TIMEOUT_MS
    ) {
      throw new OpenAICompatibleConfigError(
        'timeoutMs',
        `must be an integer between 1 and ${MAX_HTTP_TIMEOUT_MS}.`,
      );
    }
    this.#includeUsage = options.includeUsage ?? true;
    this.#requestBody = structuredClone(options.requestBody ?? {});
    this.#tokenCounter = options.tokenCounter ?? estimateTokensByCharacters;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== 'function') {
      throw new OpenAICompatibleConfigError(
        'fetch',
        'must be provided when the runtime has no global fetch implementation.',
      );
    }
  }

  async countTokens(request: ModelRequest, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted();
    const control = createRequestControl(signal, this.#timeoutMs);
    try {
      const count = await raceWithSignal(
        Promise.resolve(this.#tokenCounter(structuredClone(request), control.signal)),
        control.signal,
      );
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new ModelPortError(
          'protocol',
          `Configured token counter returned ${String(count)}; expected a non-negative safe integer.`,
          { retryable: false },
        );
      }
      return count;
    } catch (error) {
      throw mapOperationError(error, signal, control, 'Token counting failed.');
    }
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk> {
    signal.throwIfAborted();
    validateNegotiatedToolUse(request.toolUse, this.capabilities.toolUse);
    const control = createRequestControl(signal, this.#timeoutMs);
    const toolCalls = new Map<number, PendingToolCall>();
    let finishReason: ModelFinishReason | undefined;
    let sawDone = false;

    try {
      const response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: this.#requestHeaders(),
        body: JSON.stringify(this.#requestPayload(request)),
        signal: control.signal,
      });
      if (!response.ok) {
        throw await httpResponseError(response, this.#sensitiveValues);
      }
      const contentType = response.headers.get('content-type');
      if (contentType !== null && !contentType.toLowerCase().includes('text/event-stream')) {
        throw protocolError(
          `Expected a text/event-stream response, received ${JSON.stringify(contentType)}.`,
        );
      }
      if (response.body === null) {
        throw protocolError('Streaming response did not contain a response body.');
      }

      for await (const event of parseServerSentEvents(response.body, control.signal)) {
        if (event.data.trim() === '[DONE]') {
          sawDone = true;
          break;
        }
        const payload = parsePayload(event.data);
        const streamedError = payload['error'];
        if (streamedError !== undefined && streamedError !== null) {
          throw errorPayloadToModelError(
            streamedError,
            undefined,
            undefined,
            this.#sensitiveValues,
          );
        }

        const choices = payload['choices'];
        if (!Array.isArray(choices)) {
          throw protocolError('Streaming payload must contain a choices array.');
        }
        if (choices.length > 1) {
          throw protocolError('Only one streamed completion choice is supported.');
        }
        for (const choice of choices) {
          if (finishReason !== undefined) {
            throw protocolError('Received another completion choice after a finish reason.');
          }
          const parsed = parseChoice(choice);
          if (parsed.text !== undefined && parsed.text.length > 0) {
            yield { kind: 'text', text: parsed.text };
          }
          if (parsed.toolFragments !== undefined) {
            if (request.toolUse !== 'native') {
              throw protocolError(
                `Endpoint emitted native tool calls while the negotiated toolUse is ${request.toolUse}.`,
              );
            }
            acceptToolFragments(toolCalls, parsed.toolFragments);
          }
          if (parsed.finishReason !== undefined) {
            finishReason = parsed.finishReason;
            if (finishReason === 'tool-calls') {
              if (toolCalls.size === 0) {
                throw protocolError(
                  'Model finished with tool_calls without emitting any tool-call fragments.',
                );
              }
              for (const call of completeToolCalls(toolCalls)) {
                yield call;
              }
            } else if (toolCalls.size > 0 && finishReason !== 'content-filter') {
              throw protocolError(
                `Endpoint emitted tool-call fragments but finished with ${finishReason}.`,
              );
            } else {
              toolCalls.clear();
            }
          }
        }

        const usage = parseUsage(payload['usage']);
        if (usage !== undefined) {
          yield { kind: 'usage', usage };
        }
      }

      if (!sawDone) {
        throw protocolError('Model stream ended before the [DONE] sentinel.');
      }
      if (finishReason === undefined) {
        throw protocolError('Model stream ended without a finish reason.');
      }
      if (toolCalls.size > 0) {
        throw protocolError('Model stream ended with incomplete tool-call fragments.');
      }
      yield { kind: 'finish', reason: finishReason };
    } catch (error) {
      throw mapOperationError(error, signal, control, 'Model streaming request failed.');
    }
  }

  #requestHeaders(): Headers {
    const headers = new Headers(this.#headers);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    if (this.#apiKey !== undefined && !headers.has('authorization')) {
      headers.set('authorization', `Bearer ${this.#apiKey}`);
    }
    return headers;
  }

  #requestPayload(request: ModelRequest): JsonObject {
    const payload: Record<string, JsonValue> = {
      ...structuredClone(this.#requestBody),
      model: this.#model,
      messages: request.messages.map(messageToWire),
      stream: true,
    };
    delete payload['tools'];
    delete payload['tool_choice'];
    delete payload['stream_options'];

    if (this.#includeUsage) {
      payload['stream_options'] = { include_usage: true };
    }
    if (request.toolUse === 'native' && request.tools.length > 0) {
      payload['tools'] = request.tools.map(toolToWire);
      payload['tool_choice'] = 'auto';
    }
    return payload;
  }
}

/**
 * A deterministic, dependency-free estimate. It deliberately does not claim tokenizer accuracy.
 */
export function estimateTokensByCharacters(request: ModelRequest, signal: AbortSignal): number {
  signal.throwIfAborted();
  const serialized = JSON.stringify({
    messages: request.messages,
    tools: request.tools,
    toolUse: request.toolUse,
  });
  return Math.ceil([...serialized].length / 4);
}

interface RequestControl {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
}

function createRequestControl(parent: AbortSignal, timeoutMs: number): RequestControl {
  parent.throwIfAborted();
  const timeout = AbortSignal.timeout(timeoutMs);
  return {
    signal: AbortSignal.any([parent, timeout]),
    timedOut: () => timeout.aborted,
  };
}

function mapOperationError(
  error: unknown,
  parent: AbortSignal,
  control: RequestControl,
  fallbackMessage: string,
): unknown {
  if (parent.aborted) {
    return parent.reason;
  }
  if (control.timedOut()) {
    return new ModelPortError('timeout', fallbackMessage, {
      retryable: true,
      cause: error,
    });
  }
  if (error instanceof ModelPortError) {
    return error;
  }
  return new ModelPortError('network', fallbackMessage, {
    retryable: true,
    cause: error,
  });
}

function raceWithSignal<TValue>(promise: Promise<TValue>, signal: AbortSignal): Promise<TValue> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function chatCompletionsUrl(baseUrl: string): URL {
  const value = requireNonEmptyString(baseUrl, 'baseUrl');
  let base: URL;
  try {
    base = new URL(value.endsWith('/') ? value : `${value}/`);
  } catch {
    throw new OpenAICompatibleConfigError('baseUrl', 'must be a valid absolute URL.');
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new OpenAICompatibleConfigError(
      'baseUrl',
      `must use http or https; received ${JSON.stringify(base.protocol)}.`,
    );
  }
  if (base.search.length > 0 || base.hash.length > 0) {
    throw new OpenAICompatibleConfigError('baseUrl', 'must not contain a query or fragment.');
  }
  if (base.username.length > 0 || base.password.length > 0) {
    throw new OpenAICompatibleConfigError('baseUrl', 'must not contain credentials.');
  }
  return new URL(DEFAULT_CHAT_COMPLETIONS_PATH, base);
}

function requireNonEmptyString(value: string, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OpenAICompatibleConfigError(path, 'must be a non-empty string.');
  }
  return value;
}

function optionalNonEmptyString(value: string | undefined, path: string): string | undefined {
  return value === undefined ? undefined : requireNonEmptyString(value, path);
}

function optionalApiKey(value: string | undefined): string | undefined {
  const apiKey = optionalNonEmptyString(value, 'apiKey');
  if (apiKey !== undefined && apiKey !== apiKey.trim()) {
    throw new OpenAICompatibleConfigError('apiKey', 'must not contain leading or trailing space.');
  }
  return apiKey;
}

function validateHeaders(
  candidate: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (candidate === undefined) {
    return {};
  }
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new OpenAICompatibleConfigError('headers', 'must be an object of string values.');
  }
  const headers: Record<string, string> = {};
  const normalizedNames = new Set<string>();
  for (const [name, value] of Object.entries(candidate)) {
    const path = name.length === 0 ? 'headers' : `headers.${name}`;
    if (typeof value !== 'string') {
      throw new OpenAICompatibleConfigError(path, 'must be a string.');
    }
    const normalizedName = name.toLowerCase();
    if (normalizedNames.has(normalizedName)) {
      throw new OpenAICompatibleConfigError(
        path,
        'duplicates another header name when compared case-insensitively.',
      );
    }
    let normalizedValue: string | null;
    try {
      normalizedValue = new Headers([[name, value]]).get(name);
    } catch {
      throw new OpenAICompatibleConfigError(path, 'must be a valid HTTP header.');
    }
    if (normalizedValue === null) {
      throw new OpenAICompatibleConfigError(path, 'must be a valid HTTP header.');
    }
    normalizedNames.add(normalizedName);
    headers[name] = normalizedValue;
  }
  return headers;
}

function validateMaxContext(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new OpenAICompatibleConfigError(
      'capabilities.maxContext',
      'must be a positive safe integer.',
    );
  }
}

function validateCapabilities(
  candidate: unknown,
): asserts candidate is OpenAICompatibleCapabilities {
  if (!isUnknownObject(candidate)) {
    throw new OpenAICompatibleConfigError('capabilities', 'must be an object.');
  }
  const allowed = new Set([
    'streaming',
    'toolUse',
    'promptCaching',
    'structuredOutput',
    'maxContext',
    'vision',
  ]);
  for (const key of Object.keys(candidate)) {
    if (!allowed.has(key)) {
      throw new OpenAICompatibleConfigError(`capabilities.${key}`, 'is not supported.');
    }
  }
  validateMaxContext(candidate['maxContext'] as number);
  if (candidate['streaming'] !== undefined && candidate['streaming'] !== true) {
    throw new OpenAICompatibleConfigError(
      'capabilities.streaming',
      'must be true because this adapter uses the streaming Chat Completions protocol.',
    );
  }
  if (
    candidate['toolUse'] !== undefined &&
    candidate['toolUse'] !== 'native' &&
    candidate['toolUse'] !== 'prompted' &&
    candidate['toolUse'] !== 'none'
  ) {
    throw new OpenAICompatibleConfigError(
      'capabilities.toolUse',
      'must be native, prompted, or none.',
    );
  }
  for (const key of ['promptCaching', 'structuredOutput', 'vision']) {
    if (candidate[key] !== undefined && typeof candidate[key] !== 'boolean') {
      throw new OpenAICompatibleConfigError(`capabilities.${key}`, 'must be a boolean.');
    }
  }
}

function validateNegotiatedToolUse(requested: ModelToolUse, supported: ModelToolUse): void {
  if (requested === 'native' && supported !== 'native') {
    throw new ModelPortError(
      'invalid-request',
      `Request negotiated native tool use, but the endpoint declares ${supported}.`,
      { retryable: false },
    );
  }
  if (requested === 'prompted' && supported === 'none') {
    throw new ModelPortError(
      'invalid-request',
      'Request negotiated prompted tool use, but the endpoint declares no tool use.',
      { retryable: false },
    );
  }
}

function messageToWire(message: ModelMessage): JsonObject {
  const wire: Record<string, JsonValue> = {
    role: message.role,
    content: message.content,
  };
  if (message.name !== undefined) {
    wire['name'] = message.name;
  }
  if (message.role === 'tool' && message.toolCallId !== undefined) {
    wire['tool_call_id'] = message.toolCallId;
  }
  if (message.role === 'assistant' && message.toolCalls !== undefined) {
    wire['tool_calls'] = message.toolCalls.map((call) => ({
      id: call.callId,
      type: 'function',
      function: { name: call.tool, arguments: JSON.stringify(call.args) },
    }));
  }
  return wire;
}

function toolToWire(tool: ModelToolDefinition): JsonObject {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: structuredClone(tool.inputSchema),
    },
  };
}

function parsePayload(data: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw protocolError('SSE data did not contain valid JSON.', error);
  }
  if (!isJsonObject(parsed)) {
    throw protocolError('SSE data must contain a JSON object.');
  }
  return parsed;
}

interface ParsedChoice {
  readonly text?: string;
  readonly toolFragments?: readonly unknown[];
  readonly finishReason?: ModelFinishReason;
}

function parseChoice(value: unknown): ParsedChoice {
  if (!isUnknownObject(value)) {
    throw protocolError('Each streamed choice must be an object.');
  }
  if (value['index'] !== 0) {
    throw protocolError(`Expected streamed choice index 0, received ${String(value['index'])}.`);
  }
  const delta = value['delta'];
  if (!isUnknownObject(delta)) {
    throw protocolError('Each streamed choice must contain a delta object.');
  }
  const content = delta['content'];
  if (content !== undefined && content !== null && typeof content !== 'string') {
    throw protocolError('Streamed delta.content must be a string or null.');
  }
  if (delta['refusal'] !== undefined && delta['refusal'] !== null) {
    throw protocolError('Streamed refusal output is not representable by ModelPort v0.');
  }
  const toolFragments = delta['tool_calls'];
  if (toolFragments !== undefined && toolFragments !== null && !Array.isArray(toolFragments)) {
    throw protocolError('Streamed delta.tool_calls must be an array.');
  }
  const finishReason = parseFinishReason(value['finish_reason']);
  return {
    ...(typeof content === 'string' ? { text: content } : {}),
    ...(Array.isArray(toolFragments) ? { toolFragments } : {}),
    ...(finishReason === undefined ? {} : { finishReason }),
  };
}

function parseFinishReason(value: unknown): ModelFinishReason | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  switch (value) {
    case 'stop':
    case 'length':
    case 'error':
      return value as ModelFinishReason;
    case 'tool_calls':
      return 'tool-calls';
    case 'content_filter':
      return 'content-filter';
    default:
      throw protocolError(`Unsupported finish reason ${JSON.stringify(value)}.`);
  }
}

interface PendingToolCall {
  readonly index: number;
  id?: string;
  name?: string;
  arguments: string;
}

function acceptToolFragments(
  pending: Map<number, PendingToolCall>,
  fragments: readonly unknown[],
): void {
  for (const value of fragments) {
    if (!isUnknownObject(value)) {
      throw protocolError('Each streamed tool-call fragment must be an object.');
    }
    const index = value['index'];
    if (!Number.isSafeInteger(index) || (index as number) < 0) {
      throw protocolError('Each streamed tool-call fragment must contain a non-negative index.');
    }
    const numericIndex = index as number;
    const current = pending.get(numericIndex) ?? { index: numericIndex, arguments: '' };
    const id = value['id'];
    if (id !== undefined && id !== null) {
      if (typeof id !== 'string' || id.length === 0) {
        throw protocolError('Streamed tool-call id must be a non-empty string.');
      }
      if (current.id !== undefined && current.id !== id) {
        throw protocolError(`Tool-call index ${numericIndex} changed id while streaming.`);
      }
      current.id = id;
    }
    const type = value['type'];
    if (type !== undefined && type !== null && type !== 'function') {
      throw protocolError(`Unsupported streamed tool-call type ${JSON.stringify(type)}.`);
    }
    const fn = value['function'];
    if (fn !== undefined && fn !== null) {
      if (!isUnknownObject(fn)) {
        throw protocolError('Streamed tool-call function must be an object.');
      }
      const name = fn['name'];
      if (name !== undefined && name !== null) {
        if (typeof name !== 'string' || name.length === 0) {
          throw protocolError('Streamed tool-call function name must be a non-empty string.');
        }
        if (current.name !== undefined && current.name !== name) {
          throw protocolError(
            `Tool-call index ${numericIndex} changed function name while streaming.`,
          );
        }
        current.name = name;
      }
      const argumentFragment = fn['arguments'];
      if (argumentFragment !== undefined && argumentFragment !== null) {
        if (typeof argumentFragment !== 'string') {
          throw protocolError('Streamed tool-call arguments must be a string.');
        }
        current.arguments += argumentFragment;
      }
    }
    pending.set(numericIndex, current);
  }
}

function completeToolCalls(pending: Map<number, PendingToolCall>): readonly ToolCallModelChunk[] {
  const calls = [...pending.values()]
    .sort((left, right) => left.index - right.index)
    .map((call) => completeToolCall(call));
  const ids = new Set(calls.map((call) => call.callId));
  if (ids.size !== calls.length) {
    throw protocolError('Model stream contained duplicate tool-call ids.');
  }
  pending.clear();
  return calls;
}

function completeToolCall(call: PendingToolCall): ToolCallModelChunk {
  if (call.id === undefined || call.name === undefined) {
    throw protocolError(
      `Tool-call index ${call.index} ended without a complete id and function name.`,
    );
  }
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch (error) {
    throw protocolError(`Tool-call index ${call.index} ended with invalid JSON arguments.`, error);
  }
  return {
    kind: 'tool-call',
    callId: call.id,
    tool: call.name,
    args: args as JsonValue,
  };
}

function parseUsage(value: unknown): ModelUsage | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isUnknownObject(value)) {
    throw protocolError('Streaming usage must be an object or null.');
  }
  const inputTokens = requireTokenCount(value['prompt_tokens'], 'usage.prompt_tokens');
  const outputTokens = requireTokenCount(value['completion_tokens'], 'usage.completion_tokens');
  const providedTotal = value['total_tokens'];
  const totalTokens =
    providedTotal === undefined
      ? inputTokens + outputTokens
      : requireTokenCount(providedTotal, 'usage.total_tokens');
  return { inputTokens, outputTokens, totalTokens };
}

function requireTokenCount(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw protocolError(`${path} must be a non-negative safe integer.`);
  }
  return value as number;
}

async function httpResponseError(
  response: Response,
  sensitiveValues: readonly string[],
): Promise<ModelPortError> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    // Status and headers are sufficient when an error body cannot be read.
  }
  let payload: unknown = text;
  try {
    payload = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    // Plain-text error bodies are used as the message below.
  }
  return errorPayloadToModelError(payload, response.status, response.headers, sensitiveValues);
}

function errorPayloadToModelError(
  payload: unknown,
  status?: number,
  headers?: Headers,
  sensitiveValues: readonly string[] = [],
): ModelPortError {
  const error =
    isUnknownObject(payload) && payload['error'] !== undefined ? payload['error'] : payload;
  const errorObject = isUnknownObject(error) ? error : undefined;
  const rawCode = stringValue(errorObject?.['code']) ?? stringValue(errorObject?.['type']);
  const rawMessage =
    stringValue(errorObject?.['message']) ??
    (typeof error === 'string' && error.length > 0
      ? error.slice(0, 1_000)
      : status === undefined
        ? 'Model stream reported an error.'
        : `Model endpoint returned HTTP ${status}.`);
  const code = rawCode === undefined ? undefined : redactSensitiveValues(rawCode, sensitiveValues);
  const message = redactSensitiveValues(rawMessage, sensitiveValues);
  const normalized = rawCode?.toLowerCase().replaceAll('-', '_') ?? '';
  const options = (retryable: boolean) => ({
    retryable,
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { providerCode: code }),
  });

  if (normalized.includes('content_filter')) {
    return new ModelPortError('content-filter', message, options(false));
  }
  if (status === 429 || normalized.includes('rate_limit') || normalized === 'too_many_requests') {
    const retryAfterMs = parseRetryAfter(headers?.get('retry-after'));
    return new ModelPortError('rate-limit', message, {
      ...options(true),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (
    status === 401 ||
    status === 403 ||
    normalized.includes('authentication') ||
    normalized === 'invalid_api_key'
  ) {
    return new ModelPortError('authentication', message, options(false));
  }
  if (status === 408 || normalized.includes('timeout')) {
    return new ModelPortError('timeout', message, options(true));
  }
  if (
    normalized.includes('invalid_request') ||
    normalized.includes('bad_request') ||
    normalized.includes('context_length')
  ) {
    return new ModelPortError('invalid-request', message, options(false));
  }
  if (status === undefined || status >= 500 || normalized.includes('server_error')) {
    const retryAfterMs = parseRetryAfter(headers?.get('retry-after'));
    return new ModelPortError('service', message, {
      ...options(true),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  return new ModelPortError('invalid-request', message, options(false));
}

function configuredSensitiveValues(
  apiKey: string | undefined,
  headers: Readonly<Record<string, string>>,
): string[] {
  const values = new Set<string>();
  if (apiKey !== undefined) {
    values.add(apiKey);
  }
  for (const [name, value] of Object.entries(headers)) {
    if (!SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) || value.length === 0) {
      continue;
    }
    values.add(value);
    if (name.toLowerCase().includes('authorization')) {
      const credential = authorizationCredential(value);
      if (credential !== undefined && credential.length > 0) {
        values.add(credential);
      }
    }
  }
  return [...values]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
}

function redactSensitiveValues(value: string, sensitiveValues: readonly string[]): string {
  let redacted = value;
  for (const sensitive of sensitiveValues) {
    redacted = redacted.split(sensitive).join(REDACTED_CREDENTIAL);
  }
  return redacted;
}

function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const milliseconds = Math.ceil(seconds * 1_000);
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }
  return Math.max(0, timestamp - Date.now());
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function protocolError(message: string, cause?: unknown): ModelPortError {
  return new ModelPortError('protocol', message, {
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}

function isUnknownObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return isUnknownObject(value);
}
