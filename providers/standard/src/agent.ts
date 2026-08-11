import {
  AgentLoop,
  InMemoryEventLog,
  ToolRegistry,
  createDefaultPromptRegistry,
  createDefaultStrategyRegistry,
} from '@openagentcore/kernel';
import type {
  AgentLoopStrategySelections,
  EventLog,
  Middleware,
  MiddlewareContextMap,
  MiddlewareKind,
  ModelCapabilities,
  ModelPort,
  PromptOverrideMode,
  StrategyRegistry,
  StrategySelection,
  Tool,
  ToolRegistrationOptions,
} from '@openagentcore/kernel';

import {
  OpenAICompatibleConfigError,
  OpenAICompatibleModel,
  estimateTokensByCharacters,
} from './model/openai-compatible.js';
import { MAX_HTTP_TIMEOUT_MS } from './model/limits.js';

export type AgentPreset = 'oss-local';

export type AgentConfigurationLayer =
  'builtin' | 'preset' | 'config-file' | 'environment' | 'explicit-code';

export type AgentEnvironment = Readonly<Record<string, string | undefined>>;

export interface AgentIdentityConfigInput {
  readonly tenantId?: string;
  readonly sessionId?: string;
}

export interface AgentModelConfigInput {
  readonly baseUrl?: string;
  readonly name?: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly capabilities?: Partial<ModelCapabilities>;
}

export interface AgentConfigInput {
  readonly identity?: AgentIdentityConfigInput;
  readonly model?: AgentModelConfigInput;
}

export interface CreateAgentOptions extends AgentConfigInput {
  readonly preset?: AgentPreset;
  /** A JSON/YAML value already parsed by the caller. This package performs no file IO. */
  readonly configFile?: unknown;
  /** Defaults to process.env when it exists; pass an empty object to disable environment config. */
  readonly environment?: AgentEnvironment;
  /** A concrete Port is an explicit-code override and bypasses standard model construction. */
  readonly modelPort?: ModelPort;
  readonly eventLog?: EventLog;
}

export interface PromptOverrideOptions {
  readonly mode?: PromptOverrideMode;
  readonly version?: string;
}

export class AgentConfigurationError extends Error {
  readonly layer: AgentConfigurationLayer;
  readonly keyPath: string;

  constructor(
    layer: AgentConfigurationLayer,
    keyPath: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(
      `Invalid agent configuration in layer "${layer}" at key path "${keyPath}": ${detail}`,
      options,
    );
    this.name = 'AgentConfigurationError';
    this.layer = layer;
    this.keyPath = keyPath;
  }
}

type AgentStrategyKind = keyof AgentLoopStrategySelections;
type ConfigRecord = Record<string, unknown>;

interface ToolRegistration {
  readonly tool: Tool;
  readonly options: ToolRegistrationOptions;
}

interface PromptOverrideRegistration {
  readonly id: string;
  readonly content: string;
  readonly mode: PromptOverrideMode;
  readonly version: string;
}

interface ResolvedIdentityConfig {
  readonly tenantId: string;
  readonly sessionId: string;
}

interface ResolvedModelConfig {
  readonly baseUrl: string;
  readonly name: string;
  readonly apiKey: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly capabilities: ModelCapabilities;
}

interface LayeredConfigResult {
  readonly config: ConfigRecord;
  readonly provenance: ReadonlyMap<string, AgentConfigurationLayer>;
}

const BUILTIN_CONFIG: ConfigRecord = {
  identity: {
    tenantId: 'local',
    sessionId: 'default',
  },
  model: {
    timeoutMs: 60_000,
    capabilities: {
      streaming: true,
      promptCaching: false,
      structuredOutput: false,
      vision: false,
    },
  },
};

const OSS_LOCAL_CONFIG: ConfigRecord = {
  model: {
    baseUrl: 'http://127.0.0.1:11434/v1',
    capabilities: {
      toolUse: 'prompted',
    },
  },
};

const CONFIG_ROOT_KEYS = new Set(['identity', 'model']);
const IDENTITY_KEYS = new Set(['tenantId', 'sessionId']);
const MODEL_KEYS = new Set(['baseUrl', 'name', 'apiKey', 'headers', 'timeoutMs', 'capabilities']);
const CAPABILITY_KEYS = new Set([
  'streaming',
  'toolUse',
  'promptCaching',
  'structuredOutput',
  'maxContext',
  'vision',
]);
const CREATE_AGENT_KEYS = new Set([
  'preset',
  'configFile',
  'environment',
  'modelPort',
  'eventLog',
  'identity',
  'model',
]);
const STRATEGY_KINDS = [
  'stop',
  'compaction',
  'permission',
  'retry',
  'checkpoint',
] as const satisfies readonly AgentStrategyKind[];

/**
 * The composition root for the dependency-free kernel and the standard local model adapter.
 * Configuration is resolved only by build(), after all five layers have been collected.
 */
export class AgentBuilder {
  readonly #preset: AgentPreset;
  readonly #configFileInputs: unknown[] = [];
  readonly #environmentInputs: unknown[] = [];
  readonly #explicitInputs: unknown[] = [];
  readonly #tools: ToolRegistration[] = [];
  readonly #strategySelections: Partial<Record<AgentStrategyKind, StrategySelection>> = {};
  readonly #middlewareInstallers: Array<(loop: AgentLoop) => void> = [];
  readonly #promptOverrides: PromptOverrideRegistration[] = [];

  #modelPort: ModelPort | undefined;
  #eventLog: EventLog | undefined;
  #strategyRegistry: StrategyRegistry | undefined;

  private constructor(preset: AgentPreset) {
    this.#preset = preset;
  }

  static fromPreset(preset: AgentPreset): AgentBuilder {
    if (preset !== 'oss-local') {
      throw new AgentConfigurationError(
        'preset',
        'preset',
        `unsupported preset ${String(preset)}; expected "oss-local".`,
      );
    }
    return new AgentBuilder(preset);
  }

  /** Adds an already parsed declarative configuration object. */
  configFile(config: unknown): this {
    this.#configFileInputs.push(config);
    return this;
  }

  environment(environment: AgentEnvironment): this {
    this.#environmentInputs.push(environment);
    return this;
  }

  /** Adds the highest-priority serializable configuration layer. */
  configure(config: AgentConfigInput): this {
    this.#explicitInputs.push(config);
    return this;
  }

  model(model: ModelPort): this {
    this.#modelPort = model;
    return this;
  }

  eventLog(eventLog: EventLog): this {
    this.#eventLog = eventLog;
    return this;
  }

  tool(tool: Tool, options: ToolRegistrationOptions = {}): this {
    this.#tools.push({ tool, options });
    return this;
  }

  strategyRegistry(registry: StrategyRegistry): this {
    this.#strategyRegistry = registry;
    return this;
  }

  strategy(kind: AgentStrategyKind, use: string, config?: unknown): this {
    if (!STRATEGY_KINDS.includes(kind)) {
      throw new AgentConfigurationError(
        'explicit-code',
        `strategies.${String(kind)}`,
        'unsupported strategy kind.',
      );
    }
    if (typeof use !== 'string' || use.length === 0) {
      throw new AgentConfigurationError(
        'explicit-code',
        `strategies.${kind}.use`,
        'expected a non-empty string.',
      );
    }
    this.#strategySelections[kind] = config === undefined ? { use } : { use, config };
    return this;
  }

  use<TKind extends MiddlewareKind>(
    kind: TKind,
    middleware: Middleware<MiddlewareContextMap[TKind]>,
  ): this {
    this.#middlewareInstallers.push((loop) => {
      loop.use(kind, middleware);
    });
    return this;
  }

  promptOverride(id: string, content: string, options: PromptOverrideOptions = {}): this {
    if (typeof id !== 'string' || id.length === 0) {
      throw configurationError('explicit-code', 'prompts.id', 'expected a non-empty string.');
    }
    if (typeof content !== 'string') {
      throw configurationError('explicit-code', `prompts.${id}.content`, 'expected a string.');
    }
    if (options.mode !== undefined && options.mode !== 'replace' && options.mode !== 'append') {
      throw configurationError(
        'explicit-code',
        `prompts.${id}.mode`,
        'expected "replace" or "append".',
      );
    }
    if (
      options.version !== undefined &&
      (typeof options.version !== 'string' || options.version.length === 0)
    ) {
      throw configurationError(
        'explicit-code',
        `prompts.${id}.version`,
        'expected a non-empty string.',
      );
    }
    this.#promptOverrides.push({
      id,
      content,
      mode: options.mode ?? 'replace',
      version: options.version ?? 'explicit-code',
    });
    return this;
  }

  build(): AgentLoop {
    const layered = this.#resolveConfig();
    const identity = resolveIdentityConfig(layered);
    const eventLog = this.#eventLog ?? new InMemoryEventLog(identity);
    validateEventLog(eventLog);

    const model = this.#modelPort ?? createConfiguredModel(resolveModelConfig(layered), layered);
    validateModelPort(model);

    const tools = new ToolRegistry();
    for (const [index, registration] of this.#tools.entries()) {
      if (typeof registration.tool.name !== 'string' || registration.tool.name.length === 0) {
        throw configurationError(
          'explicit-code',
          `tools[${index}].name`,
          'expected a non-empty string.',
        );
      }
      const groups = registration.options.groups;
      if (
        groups !== undefined &&
        (!Array.isArray(groups) ||
          groups.some((group) => typeof group !== 'string' || group.length === 0))
      ) {
        throw configurationError(
          'explicit-code',
          `tools[${index}].groups`,
          'expected non-empty string group names.',
        );
      }
      try {
        tools.register(registration.tool, registration.options);
      } catch (error) {
        throw new AgentConfigurationError(
          'explicit-code',
          `tools[${index}].name`,
          errorMessage(error),
          { cause: error },
        );
      }
    }

    const prompts = createDefaultPromptRegistry();
    for (const override of this.#promptOverrides) {
      try {
        if (override.mode === 'append') {
          prompts.append(override.id, override.content, override.version);
        } else {
          prompts.replace(override.id, override.content, override.version);
        }
      } catch (error) {
        throw new AgentConfigurationError(
          'explicit-code',
          `prompts.${override.id}`,
          errorMessage(error),
          { cause: error },
        );
      }
    }

    const strategyRegistry = this.#strategyRegistry ?? createDefaultStrategyRegistry();
    for (const kind of STRATEGY_KINDS) {
      const selection = this.#strategySelections[kind];
      if (selection === undefined) {
        continue;
      }
      try {
        strategyRegistry.resolve(kind, selection.use);
      } catch (error) {
        throw new AgentConfigurationError(
          'explicit-code',
          `strategies.${kind}.use`,
          errorMessage(error),
          { cause: error },
        );
      }
    }

    const loop = new AgentLoop({
      eventLog,
      model,
      tools,
      prompts,
      strategies: { ...this.#strategySelections },
      strategyRegistry,
    });
    for (const install of this.#middlewareInstallers) {
      install(loop);
    }
    return loop;
  }

  #resolveConfig(): LayeredConfigResult {
    const provenance = new Map<string, AgentConfigurationLayer>();
    let config: ConfigRecord = {};

    config = mergeConfigurationLayer(config, BUILTIN_CONFIG, 'builtin', provenance);
    if (this.#preset === 'oss-local') {
      config = mergeConfigurationLayer(config, OSS_LOCAL_CONFIG, 'preset', provenance);
    }
    for (const input of this.#configFileInputs) {
      config = mergeConfigurationLayer(config, input, 'config-file', provenance);
    }
    for (const input of this.#environmentInputs) {
      config = mergeConfigurationLayer(
        config,
        configurationFromEnvironment(input),
        'environment',
        provenance,
      );
    }
    for (const input of this.#explicitInputs) {
      config = mergeConfigurationLayer(config, input, 'explicit-code', provenance);
    }

    return { config, provenance };
  }
}

/** A compact facade over AgentBuilder; use the Builder for tools and extension points. */
export function createAgent(options: CreateAgentOptions = {}): AgentLoop {
  validateCreateAgentOptions(options);
  const builder = AgentBuilder.fromPreset(options.preset ?? 'oss-local');

  if (options.configFile !== undefined) {
    builder.configFile(options.configFile);
  }
  builder.environment(options.environment ?? runtimeEnvironment());

  const explicitConfig: AgentConfigInput = {
    ...(options.identity === undefined ? {} : { identity: options.identity }),
    ...(options.model === undefined ? {} : { model: options.model }),
  };
  builder.configure(explicitConfig);

  if (options.modelPort !== undefined) {
    builder.model(options.modelPort);
  }
  if (options.eventLog !== undefined) {
    builder.eventLog(options.eventLog);
  }
  return builder.build();
}

function mergeConfigurationLayer(
  current: ConfigRecord,
  input: unknown,
  layer: AgentConfigurationLayer,
  provenance: Map<string, AgentConfigurationLayer>,
): ConfigRecord {
  validatePartialConfiguration(input, layer);
  return deepMerge(current, input, layer, provenance);
}

function validatePartialConfiguration(
  input: unknown,
  layer: AgentConfigurationLayer,
): asserts input is ConfigRecord {
  const root = requireRecord(input, layer, '$');
  rejectUnknownKeys(root, CONFIG_ROOT_KEYS, layer, '');

  const identityValue = root['identity'];
  if (identityValue !== undefined) {
    const identity = requireRecord(identityValue, layer, 'identity');
    rejectUnknownKeys(identity, IDENTITY_KEYS, layer, 'identity');
    validateOptionalNonEmptyString(identity['tenantId'], layer, 'identity.tenantId');
    validateOptionalNonEmptyString(identity['sessionId'], layer, 'identity.sessionId');
  }

  const modelValue = root['model'];
  if (modelValue === undefined) {
    return;
  }
  const model = requireRecord(modelValue, layer, 'model');
  rejectUnknownKeys(model, MODEL_KEYS, layer, 'model');
  validateOptionalUrl(model['baseUrl'], layer, 'model.baseUrl');
  validateOptionalNonEmptyString(model['name'], layer, 'model.name');
  validateOptionalApiKey(model['apiKey'], layer, 'model.apiKey');
  validateOptionalTimeout(model['timeoutMs'], layer, 'model.timeoutMs');

  const headersValue = model['headers'];
  if (headersValue !== undefined) {
    const headers = requireRecord(headersValue, layer, 'model.headers');
    const normalizedNames = new Set<string>();
    for (const [name, value] of Object.entries(headers)) {
      if (name.length === 0) {
        throw configurationError(layer, 'model.headers', 'header names must be non-empty.');
      }
      if (typeof value !== 'string') {
        throw configurationError(layer, `model.headers.${name}`, 'expected a string.');
      }
      const normalizedName = name.toLowerCase();
      if (normalizedNames.has(normalizedName)) {
        throw configurationError(
          layer,
          `model.headers.${name}`,
          'duplicates another header name when compared case-insensitively.',
        );
      }
      normalizedNames.add(normalizedName);
      try {
        new Headers([[name, value]]);
      } catch {
        throw configurationError(
          layer,
          `model.headers.${name}`,
          'expected a valid HTTP header name and value.',
        );
      }
    }
  }

  const capabilitiesValue = model['capabilities'];
  if (capabilitiesValue !== undefined) {
    validatePartialCapabilities(capabilitiesValue, layer, 'model.capabilities');
  }
}

function validatePartialCapabilities(
  input: unknown,
  layer: AgentConfigurationLayer,
  keyPath: string,
): void {
  const capabilities = requireRecord(input, layer, keyPath);
  rejectUnknownKeys(capabilities, CAPABILITY_KEYS, layer, keyPath);
  validateOptionalBoolean(capabilities['streaming'], layer, `${keyPath}.streaming`);
  validateOptionalToolUse(capabilities['toolUse'], layer, `${keyPath}.toolUse`);
  validateOptionalBoolean(capabilities['promptCaching'], layer, `${keyPath}.promptCaching`);
  validateOptionalBoolean(capabilities['structuredOutput'], layer, `${keyPath}.structuredOutput`);
  validateOptionalPositiveInteger(capabilities['maxContext'], layer, `${keyPath}.maxContext`);
  validateOptionalBoolean(capabilities['vision'], layer, `${keyPath}.vision`);
}

function deepMerge(
  current: ConfigRecord,
  input: ConfigRecord,
  layer: AgentConfigurationLayer,
  provenance: Map<string, AgentConfigurationLayer>,
  prefix = '',
): ConfigRecord {
  const merged = Object.fromEntries(
    Object.entries(current).map(([key, value]) => [key, structuredClone(value)]),
  );

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) {
      continue;
    }
    const keyPath = prefix.length === 0 ? key : `${prefix}.${key}`;
    provenance.set(keyPath, layer);
    const existing = merged[key];
    if (keyPath === 'model.headers' && isRecord(value)) {
      merged[key] = mergeHeaders(isRecord(existing) ? existing : {}, value, layer, provenance);
    } else if (isRecord(existing) && isRecord(value)) {
      merged[key] = deepMerge(existing, value, layer, provenance, keyPath);
    } else {
      merged[key] = structuredClone(value);
    }
  }
  return merged;
}

function mergeHeaders(
  current: ConfigRecord,
  input: ConfigRecord,
  layer: AgentConfigurationLayer,
  provenance: Map<string, AgentConfigurationLayer>,
): ConfigRecord {
  let merged = Object.fromEntries(
    Object.entries(current).map(([name, value]) => [name, structuredClone(value)]),
  );
  for (const [name, value] of Object.entries(input)) {
    const matchingName = Object.keys(merged).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    if (matchingName !== undefined) {
      merged = Object.fromEntries(
        Object.entries(merged).filter(([candidate]) => candidate !== matchingName),
      );
    }
    merged[name] = structuredClone(value);
    provenance.set(`model.headers.${name}`, layer);
  }
  return merged;
}

function resolveIdentityConfig(layered: LayeredConfigResult): ResolvedIdentityConfig {
  const identity = mergedRecord(layered, 'identity');
  return {
    tenantId: mergedString(layered, identity, 'identity.tenantId'),
    sessionId: mergedString(layered, identity, 'identity.sessionId'),
  };
}

function resolveModelConfig(layered: LayeredConfigResult): ResolvedModelConfig {
  const model = mergedRecord(layered, 'model');
  const capabilities = mergedRecord(layered, 'model.capabilities');
  const headersValue = valueAtPath(layered.config, 'model.headers');
  const headers = headersValue === undefined ? {} : mergedRecord(layered, 'model.headers');
  const apiKeyValue = model['apiKey'];

  const streaming = mergedBoolean(layered, capabilities, 'model.capabilities.streaming');
  if (!streaming) {
    throw requiredConfigurationError(
      layered,
      'model.capabilities.streaming',
      'must be true for the streaming OpenAI-compatible adapter.',
    );
  }

  let resolvedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, String(value)]),
  );
  let apiKey = typeof apiKeyValue === 'string' && apiKeyValue.length > 0 ? apiKeyValue : undefined;
  const authorizationName = Object.keys(resolvedHeaders).find(
    (name) => name.toLowerCase() === 'authorization',
  );
  if (apiKey !== undefined && authorizationName !== undefined) {
    const apiKeyLayer = effectiveLayer(layered, 'model.apiKey');
    const authorizationLayer = effectiveLayer(layered, `model.headers.${authorizationName}`);
    const apiKeyPriority = layerPriority(apiKeyLayer);
    const authorizationPriority = layerPriority(authorizationLayer);
    if (apiKeyPriority === authorizationPriority) {
      throw configurationError(
        authorizationLayer,
        `model.headers.${authorizationName}`,
        'conflicts with model.apiKey in the same configuration layer.',
      );
    }
    if (apiKeyPriority > authorizationPriority) {
      resolvedHeaders = Object.fromEntries(
        Object.entries(resolvedHeaders).filter(([name]) => name !== authorizationName),
      );
    } else {
      apiKey = undefined;
    }
  }

  return {
    baseUrl: mergedString(layered, model, 'model.baseUrl'),
    name: mergedString(layered, model, 'model.name'),
    apiKey,
    headers: resolvedHeaders,
    timeoutMs: mergedPositiveInteger(layered, model, 'model.timeoutMs'),
    capabilities: {
      streaming,
      toolUse: mergedToolUse(layered, capabilities, 'model.capabilities.toolUse'),
      promptCaching: mergedBoolean(layered, capabilities, 'model.capabilities.promptCaching'),
      structuredOutput: mergedBoolean(layered, capabilities, 'model.capabilities.structuredOutput'),
      maxContext: mergedPositiveInteger(layered, capabilities, 'model.capabilities.maxContext'),
      vision: mergedBoolean(layered, capabilities, 'model.capabilities.vision'),
    },
  };
}

function createConfiguredModel(
  config: ResolvedModelConfig,
  layered: LayeredConfigResult,
): ModelPort {
  try {
    return new OpenAICompatibleModel({
      baseUrl: config.baseUrl,
      model: config.name,
      timeoutMs: config.timeoutMs,
      capabilities: config.capabilities,
      tokenCounter: estimateTokensByCharacters,
      ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
      ...(Object.keys(config.headers).length === 0 ? {} : { headers: config.headers }),
    });
  } catch (error) {
    if (error instanceof OpenAICompatibleConfigError) {
      const keyPath = providerConfigPath(error.path);
      throw new AgentConfigurationError(effectiveLayer(layered, keyPath), keyPath, error.message, {
        cause: error,
      });
    }
    throw error;
  }
}

function providerConfigPath(path: string): string {
  if (path === 'model') {
    return 'model.name';
  }
  return `model.${path}`;
}

function layerPriority(layer: AgentConfigurationLayer): number {
  const priorities: Readonly<Record<AgentConfigurationLayer, number>> = {
    builtin: 0,
    preset: 1,
    'config-file': 2,
    environment: 3,
    'explicit-code': 4,
  };
  return priorities[layer];
}

function configurationFromEnvironment(environment: unknown): ConfigRecord {
  if (!isObjectRecord(environment)) {
    throw configurationError('environment', '$', 'expected an environment object.');
  }
  const config: ConfigRecord = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || !name.startsWith('OAC_')) {
      continue;
    }
    if (typeof value !== 'string') {
      throw configurationError('environment', name, 'expected a string value.');
    }
    switch (name) {
      case 'OAC_TENANT_ID':
        setConfigValue(config, ['identity', 'tenantId'], value);
        break;
      case 'OAC_SESSION_ID':
        setConfigValue(config, ['identity', 'sessionId'], value);
        break;
      case 'OAC_MODEL_BASE_URL':
        setConfigValue(config, ['model', 'baseUrl'], value);
        break;
      case 'OAC_MODEL_NAME':
        setConfigValue(config, ['model', 'name'], value);
        break;
      case 'OAC_MODEL_API_KEY':
        setConfigValue(config, ['model', 'apiKey'], value);
        break;
      case 'OAC_MODEL_TIMEOUT_MS':
        setConfigValue(config, ['model', 'timeoutMs'], environmentTimeout(value, name));
        break;
      case 'OAC_MODEL_STREAMING':
        setConfigValue(
          config,
          ['model', 'capabilities', 'streaming'],
          environmentBoolean(value, name),
        );
        break;
      case 'OAC_MODEL_TOOL_USE':
        setConfigValue(
          config,
          ['model', 'capabilities', 'toolUse'],
          environmentToolUse(value, name),
        );
        break;
      case 'OAC_MODEL_PROMPT_CACHING':
        setConfigValue(
          config,
          ['model', 'capabilities', 'promptCaching'],
          environmentBoolean(value, name),
        );
        break;
      case 'OAC_MODEL_STRUCTURED_OUTPUT':
        setConfigValue(
          config,
          ['model', 'capabilities', 'structuredOutput'],
          environmentBoolean(value, name),
        );
        break;
      case 'OAC_MODEL_MAX_CONTEXT':
        setConfigValue(
          config,
          ['model', 'capabilities', 'maxContext'],
          environmentPositiveInteger(value, name),
        );
        break;
      case 'OAC_MODEL_VISION':
        setConfigValue(
          config,
          ['model', 'capabilities', 'vision'],
          environmentBoolean(value, name),
        );
        break;
      default:
        throw configurationError('environment', name, 'unknown OAC environment variable.');
    }
  }
  return config;
}

function environmentPositiveInteger(value: string, variable: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw configurationError(
      'environment',
      environmentKeyPath(variable),
      `expected ${variable} to contain a positive integer.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw configurationError(
      'environment',
      environmentKeyPath(variable),
      `expected ${variable} to contain a safe positive integer.`,
    );
  }
  return parsed;
}

function environmentTimeout(value: string, variable: string): number {
  const parsed = environmentPositiveInteger(value, variable);
  if (parsed > MAX_HTTP_TIMEOUT_MS) {
    throw configurationError(
      'environment',
      environmentKeyPath(variable),
      `expected ${variable} to be at most ${MAX_HTTP_TIMEOUT_MS}.`,
    );
  }
  return parsed;
}

function environmentBoolean(value: string, variable: string): boolean {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw configurationError(
    'environment',
    environmentKeyPath(variable),
    `expected ${variable} to contain "true" or "false".`,
  );
}

function environmentToolUse(value: string, variable: string): ModelCapabilities['toolUse'] {
  if (value === 'native' || value === 'prompted' || value === 'none') {
    return value;
  }
  throw configurationError(
    'environment',
    environmentKeyPath(variable),
    `expected ${variable} to contain "native", "prompted", or "none".`,
  );
}

function environmentKeyPath(variable: string): string {
  const paths: Readonly<Record<string, string>> = {
    OAC_MODEL_TIMEOUT_MS: 'model.timeoutMs',
    OAC_MODEL_STREAMING: 'model.capabilities.streaming',
    OAC_MODEL_TOOL_USE: 'model.capabilities.toolUse',
    OAC_MODEL_PROMPT_CACHING: 'model.capabilities.promptCaching',
    OAC_MODEL_STRUCTURED_OUTPUT: 'model.capabilities.structuredOutput',
    OAC_MODEL_MAX_CONTEXT: 'model.capabilities.maxContext',
    OAC_MODEL_VISION: 'model.capabilities.vision',
  };
  return paths[variable] ?? variable;
}

function setConfigValue(config: ConfigRecord, path: readonly string[], value: unknown): void {
  let current = config;
  path.forEach((segment, index) => {
    if (index === path.length - 1) {
      current[segment] = value;
      return;
    }
    const existing = current[segment];
    if (isRecord(existing)) {
      current = existing;
      return;
    }
    const nested: ConfigRecord = {};
    current[segment] = nested;
    current = nested;
  });
}

function validateCreateAgentOptions(options: unknown): asserts options is CreateAgentOptions {
  const record = requireRecord(options, 'explicit-code', '$');
  rejectUnknownKeys(record, CREATE_AGENT_KEYS, 'explicit-code', '');
}

function validateModelPort(model: ModelPort): void {
  if (!isObjectRecord(model)) {
    throw configurationError('explicit-code', 'modelPort', 'expected a ModelPort object.');
  }
  if (typeof model['stream'] !== 'function') {
    throw configurationError('explicit-code', 'modelPort.stream', 'expected a function.');
  }
  if (typeof model['countTokens'] !== 'function') {
    throw configurationError('explicit-code', 'modelPort.countTokens', 'expected a function.');
  }
  validateCompleteCapabilities(model['capabilities'], 'explicit-code', 'modelPort.capabilities');
}

function validateCompleteCapabilities(
  input: unknown,
  layer: AgentConfigurationLayer,
  keyPath: string,
): void {
  validatePartialCapabilities(input, layer, keyPath);
  const capabilities = requireRecord(input, layer, keyPath);
  mergedBooleanValue(capabilities, 'streaming', layer, `${keyPath}.streaming`);
  mergedToolUseValue(capabilities, 'toolUse', layer, `${keyPath}.toolUse`);
  mergedBooleanValue(capabilities, 'promptCaching', layer, `${keyPath}.promptCaching`);
  mergedBooleanValue(capabilities, 'structuredOutput', layer, `${keyPath}.structuredOutput`);
  mergedPositiveIntegerValue(capabilities, 'maxContext', layer, `${keyPath}.maxContext`);
  mergedBooleanValue(capabilities, 'vision', layer, `${keyPath}.vision`);
}

function validateEventLog(eventLog: EventLog): void {
  if (!isObjectRecord(eventLog)) {
    throw configurationError('explicit-code', 'eventLog', 'expected an EventLog object.');
  }
  validateOptionalNonEmptyString(eventLog['tenantId'], 'explicit-code', 'eventLog.tenantId');
  validateOptionalNonEmptyString(eventLog['sessionId'], 'explicit-code', 'eventLog.sessionId');
  if (typeof eventLog['tenantId'] !== 'string') {
    throw configurationError('explicit-code', 'eventLog.tenantId', 'expected a non-empty string.');
  }
  if (typeof eventLog['sessionId'] !== 'string') {
    throw configurationError('explicit-code', 'eventLog.sessionId', 'expected a non-empty string.');
  }
  for (const method of ['append', 'read', 'subscribe'] as const) {
    if (typeof eventLog[method] !== 'function') {
      throw configurationError('explicit-code', `eventLog.${method}`, 'expected a function.');
    }
  }
}

function rejectUnknownKeys(
  value: ConfigRecord,
  allowed: ReadonlySet<string>,
  layer: AgentConfigurationLayer,
  prefix: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw configurationError(
        layer,
        prefix.length === 0 ? key : `${prefix}.${key}`,
        'unknown configuration key.',
      );
    }
  }
}

function validateOptionalNonEmptyString(
  value: unknown,
  layer: AgentConfigurationLayer,
  keyPath: string,
): void {
  if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
    throw configurationError(layer, keyPath, 'expected a non-empty string.');
  }
}

function validateOptionalApiKey(
  value: unknown,
  layer: AgentConfigurationLayer,
  keyPath: string,
): void {
  if (
    value !== undefined &&
    (typeof value !== 'string' ||
      (value.length > 0 && (value.trim().length === 0 || value !== value.trim())))
  ) {
    throw configurationError(
      layer,
      keyPath,
      'expected a string without leading or trailing space.',
    );
  }
}

function validateOptionalTimeout(
  value: unknown,
  layer: AgentConfigurationLayer,
  keyPath: string,
): void {
  if (
    value !== undefined &&
    (typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > MAX_HTTP_TIMEOUT_MS)
  ) {
    throw configurationError(
      layer,
      keyPath,
      `expected an integer between 1 and ${MAX_HTTP_TIMEOUT_MS}.`,
    );
  }
}

function validateOptionalPositiveInteger(
  value: unknown,
  layer: AgentConfigurationLayer,
  keyPath: string,
): void {
  if (
    value !== undefined &&
    (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
  ) {
    throw configurationError(layer, keyPath, 'expected a safe positive integer.');
  }
}

function validateOptionalBoolean(
  value: unknown,
  layer: AgentConfigurationLayer,
  keyPath: string,
): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw configurationError(layer, keyPath, 'expected a boolean.');
  }
}

function validateOptionalToolUse(
  value: unknown,
  layer: AgentConfigurationLayer,
  keyPath: string,
): void {
  if (value !== undefined && value !== 'native' && value !== 'prompted' && value !== 'none') {
    throw configurationError(layer, keyPath, 'expected "native", "prompted", or "none".');
  }
}

function validateOptionalUrl(
  value: unknown,
  layer: AgentConfigurationLayer,
  keyPath: string,
): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'string') {
    throw configurationError(layer, keyPath, 'expected an absolute HTTP(S) URL.');
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
    if (parsed.search.length > 0 || parsed.hash.length > 0) {
      throw new Error('query or fragment');
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      throw new Error('credentials');
    }
  } catch {
    throw configurationError(layer, keyPath, 'expected an absolute HTTP(S) URL.');
  }
}

function requireRecord(
  value: unknown,
  layer: AgentConfigurationLayer,
  keyPath: string,
): ConfigRecord {
  if (!isRecord(value)) {
    throw configurationError(layer, keyPath, 'expected an object.');
  }
  return value;
}

function isRecord(value: unknown): value is ConfigRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isObjectRecord(value: unknown): value is ConfigRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergedRecord(layered: LayeredConfigResult, keyPath: string): ConfigRecord {
  const value = valueAtPath(layered.config, keyPath);
  if (!isRecord(value)) {
    throw requiredConfigurationError(layered, keyPath, 'expected an object.');
  }
  return value;
}

function mergedString(layered: LayeredConfigResult, parent: ConfigRecord, keyPath: string): string {
  const key = finalPathSegment(keyPath);
  const value = parent[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw requiredConfigurationError(layered, keyPath, 'a non-empty value is required.');
  }
  return value;
}

function mergedBoolean(
  layered: LayeredConfigResult,
  parent: ConfigRecord,
  keyPath: string,
): boolean {
  return mergedBooleanValue(
    parent,
    finalPathSegment(keyPath),
    effectiveLayer(layered, keyPath),
    keyPath,
  );
}

function mergedToolUse(
  layered: LayeredConfigResult,
  parent: ConfigRecord,
  keyPath: string,
): ModelCapabilities['toolUse'] {
  return mergedToolUseValue(
    parent,
    finalPathSegment(keyPath),
    effectiveLayer(layered, keyPath),
    keyPath,
  );
}

function mergedPositiveInteger(
  layered: LayeredConfigResult,
  parent: ConfigRecord,
  keyPath: string,
): number {
  return mergedPositiveIntegerValue(
    parent,
    finalPathSegment(keyPath),
    effectiveLayer(layered, keyPath),
    keyPath,
  );
}

function mergedBooleanValue(
  parent: ConfigRecord,
  key: string,
  layer: AgentConfigurationLayer,
  keyPath: string,
): boolean {
  const value = parent[key];
  if (typeof value !== 'boolean') {
    throw configurationError(layer, keyPath, 'a boolean value is required.');
  }
  return value;
}

function mergedToolUseValue(
  parent: ConfigRecord,
  key: string,
  layer: AgentConfigurationLayer,
  keyPath: string,
): ModelCapabilities['toolUse'] {
  const value = parent[key];
  if (value !== 'native' && value !== 'prompted' && value !== 'none') {
    throw configurationError(layer, keyPath, 'a tool-use declaration is required.');
  }
  return value;
}

function mergedPositiveIntegerValue(
  parent: ConfigRecord,
  key: string,
  layer: AgentConfigurationLayer,
  keyPath: string,
): number {
  const value = parent[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw configurationError(layer, keyPath, 'a safe positive integer is required.');
  }
  return value;
}

function requiredConfigurationError(
  layered: LayeredConfigResult,
  keyPath: string,
  detail: string,
): AgentConfigurationError {
  return configurationError(effectiveLayer(layered, keyPath), keyPath, detail);
}

function effectiveLayer(layered: LayeredConfigResult, keyPath: string): AgentConfigurationLayer {
  let candidate = keyPath;
  while (candidate.length > 0) {
    const layer = layered.provenance.get(candidate);
    if (layer !== undefined) {
      return layer;
    }
    const separator = candidate.lastIndexOf('.');
    candidate = separator < 0 ? '' : candidate.slice(0, separator);
  }
  return 'preset';
}

function valueAtPath(config: ConfigRecord, keyPath: string): unknown {
  let value: unknown = config;
  for (const segment of keyPath.split('.')) {
    if (!isRecord(value)) {
      return undefined;
    }
    value = value[segment];
  }
  return value;
}

function finalPathSegment(keyPath: string): string {
  return keyPath.slice(keyPath.lastIndexOf('.') + 1);
}

function configurationError(
  layer: AgentConfigurationLayer,
  keyPath: string,
  detail: string,
): AgentConfigurationError {
  return new AgentConfigurationError(layer, keyPath, detail);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runtimeEnvironment(): AgentEnvironment {
  const processValue = (globalThis as { readonly process?: unknown }).process;
  if (!isObjectRecord(processValue)) {
    return {};
  }
  const environment = processValue['env'];
  return isObjectRecord(environment) ? (environment as AgentEnvironment) : {};
}
