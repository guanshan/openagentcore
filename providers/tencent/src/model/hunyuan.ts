import type {
  JsonObject,
  ModelCapabilities,
  ModelChunk,
  ModelPort,
  ModelRequest,
} from '@openagentcore/kernel';
import { OpenAICompatibleModel, type EstimatedTokenCounter } from '@openagentcore/standard/model';

export const TENCENT_TOKENHUB_BASE_URL = 'https://tokenhub.tencentmaas.com/v1';
export const TENCENT_HY3_MODEL = 'hy3';

export const TENCENT_HY3_CAPABILITIES: ModelCapabilities = Object.freeze({
  streaming: true,
  toolUse: 'native',
  promptCaching: true,
  structuredOutput: true,
  maxContext: 262_144,
  vision: false,
});

export interface TencentHunyuanModelOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
  /** Required for model IDs other than the documented hy3 default. */
  readonly capabilities?: ModelCapabilities;
  readonly timeoutMs?: number;
  readonly includeUsage?: boolean;
  readonly requestBody?: JsonObject;
  readonly tokenCounter?: EstimatedTokenCounter;
  readonly fetch?: typeof globalThis.fetch;
}

export class TencentModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TencentModelConfigError';
  }
}

/** Tencent TokenHub's OpenAI-compatible Hunyuan adapter. */
export class TencentHunyuanModel implements ModelPort {
  readonly capabilities: ModelCapabilities;
  readonly #delegate: OpenAICompatibleModel;

  constructor(options: TencentHunyuanModelOptions = {}) {
    const model = options.model ?? TENCENT_HY3_MODEL;
    const capabilities = modelCapabilities(model, options.capabilities);
    this.#delegate = new OpenAICompatibleModel({
      baseUrl: options.baseUrl ?? TENCENT_TOKENHUB_BASE_URL,
      model,
      capabilities,
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.includeUsage === undefined ? {} : { includeUsage: options.includeUsage }),
      ...(options.requestBody === undefined
        ? {}
        : { requestBody: structuredClone(options.requestBody) }),
      ...(options.tokenCounter === undefined ? {} : { tokenCounter: options.tokenCounter }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    this.capabilities = this.#delegate.capabilities;
  }

  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk> {
    return this.#delegate.stream(request, signal);
  }

  countTokens(request: ModelRequest, signal: AbortSignal): Promise<number> {
    return this.#delegate.countTokens(request, signal);
  }
}

function modelCapabilities(
  model: string,
  configured: ModelCapabilities | undefined,
): ModelCapabilities {
  if (model === TENCENT_HY3_MODEL) {
    if (configured !== undefined) {
      throw new TencentModelConfigError(
        'hy3 capabilities are provider-owned; omit capabilities or choose another model ID.',
      );
    }
    return TENCENT_HY3_CAPABILITIES;
  }
  if (configured === undefined) {
    throw new TencentModelConfigError(
      'capabilities are required for model IDs other than hy3; the adapter will not guess provider support.',
    );
  }
  return Object.freeze({ ...configured });
}
