import type { JsonObject, JsonValue, ModelUsage } from '../events/types.js';

export type ModelToolUse = 'native' | 'prompted' | 'none';

export interface ModelCapabilities {
  readonly streaming: boolean;
  readonly toolUse: ModelToolUse;
  readonly promptCaching: boolean;
  readonly structuredOutput: boolean;
  readonly maxContext: number;
  readonly vision: boolean;
}

export type ModelMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ModelMessage {
  readonly role: ModelMessageRole;
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
}

export interface ModelToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
}

export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  /** The negotiated mode used for this request, after capability degradation. */
  readonly toolUse: ModelToolUse;
  readonly metadata?: JsonObject;
}

export interface TextModelChunk {
  readonly kind: 'text';
  readonly text: string;
}

export interface ToolCallModelChunk {
  readonly kind: 'tool-call';
  readonly callId: string;
  readonly tool: string;
  readonly args: JsonValue;
}

export interface UsageModelChunk {
  readonly kind: 'usage';
  readonly usage: ModelUsage;
}

export type ModelFinishReason = 'stop' | 'tool-calls' | 'length' | 'content-filter' | 'error';

export interface FinishModelChunk {
  readonly kind: 'finish';
  readonly reason: ModelFinishReason;
}

export type ModelChunk = TextModelChunk | ToolCallModelChunk | UsageModelChunk | FinishModelChunk;

export interface ModelPort {
  readonly capabilities: ModelCapabilities;
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk>;
  countTokens(request: ModelRequest, signal: AbortSignal): Promise<number>;
}

export interface ScriptedModelResponse {
  readonly chunks: readonly ModelChunk[];
  /** Raised after all chunks have been yielded, allowing deterministic interrupted-stream tests. */
  readonly error?: unknown;
}

export type ScriptedModelStep = readonly ModelChunk[] | ScriptedModelResponse | Error;

export interface ScriptedModelPortOptions {
  readonly capabilities?: Partial<ModelCapabilities>;
  /** Optional per-call token counts. Missing entries use the deterministic default counter. */
  readonly tokenCounts?: readonly (number | Error)[];
}

const defaultCapabilities: ModelCapabilities = {
  streaming: true,
  toolUse: 'native',
  promptCaching: false,
  structuredOutput: false,
  maxContext: 128_000,
  vision: false,
};

export class ScriptedModelExhaustedError extends Error {
  constructor(operation: 'stream' | 'countTokens') {
    super(`ScriptedModelPort has no remaining ${operation} script.`);
    this.name = 'ScriptedModelExhaustedError';
  }
}

/**
 * Deterministic ModelPort test double. It performs no network or filesystem IO.
 */
export class ScriptedModelPort implements ModelPort {
  readonly capabilities: ModelCapabilities;

  readonly #steps: readonly ScriptedModelStep[];
  readonly #tokenCounts: readonly (number | Error)[] | undefined;
  readonly #requests: ModelRequest[] = [];
  readonly #tokenCountRequests: ModelRequest[] = [];
  #nextStep = 0;
  #nextTokenCount = 0;

  constructor(steps: readonly ScriptedModelStep[], options: ScriptedModelPortOptions = {}) {
    this.#steps = steps.map((step) => cloneScriptedStep(step));
    this.#tokenCounts =
      options.tokenCounts === undefined ? undefined : structuredClone(options.tokenCounts);
    this.capabilities = Object.freeze({
      ...defaultCapabilities,
      ...options.capabilities,
    });
  }

  get requests(): readonly ModelRequest[] {
    return structuredClone(this.#requests);
  }

  get tokenCountRequests(): readonly ModelRequest[] {
    return structuredClone(this.#tokenCountRequests);
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk> {
    signal.throwIfAborted();
    const step = this.#steps[this.#nextStep];
    if (step === undefined) {
      throw new ScriptedModelExhaustedError('stream');
    }
    this.#nextStep += 1;
    this.#requests.push(structuredClone(request));

    if (step instanceof Error) {
      throw step;
    }

    const response: ScriptedModelResponse = isModelChunkArray(step) ? { chunks: step } : step;
    for (const chunk of response.chunks) {
      signal.throwIfAborted();
      yield structuredClone(chunk);
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    if (response.error !== undefined) {
      throw response.error;
    }
  }

  async countTokens(request: ModelRequest, signal: AbortSignal): Promise<number> {
    signal.throwIfAborted();
    this.#tokenCountRequests.push(structuredClone(request));
    const scripted = this.#tokenCounts?.[this.#nextTokenCount];
    this.#nextTokenCount += 1;
    signal.throwIfAborted();

    if (scripted !== undefined) {
      if (scripted instanceof Error) {
        throw scripted;
      }
      return scripted;
    }
    if (this.#tokenCounts !== undefined) {
      throw new ScriptedModelExhaustedError('countTokens');
    }

    return request.messages.reduce((total, message) => total + [...message.content].length, 0);
  }
}

function isModelChunkArray(step: ScriptedModelStep): step is readonly ModelChunk[] {
  return Array.isArray(step);
}

function cloneScriptedStep(step: ScriptedModelStep): ScriptedModelStep {
  if (step instanceof Error) {
    return step;
  }
  if (isModelChunkArray(step)) {
    return structuredClone(step);
  }
  return {
    chunks: structuredClone(step.chunks),
    ...(step.error === undefined ? {} : { error: step.error }),
  };
}
