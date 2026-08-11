import type { JsonObject, JsonValue } from '../events/types.js';

export interface ToolPermissionDescriptor extends JsonObject {
  readonly kind: string;
  readonly description?: string;
}

export interface ToolExecutionRequest {
  /** Stable across recovery and available to adapters as an idempotency key. */
  readonly callId: string;
  readonly args: JsonValue;
  readonly attempt: number;
}

export interface ToolPort {
  readonly name: string;
  readonly inputSchema: JsonObject;
  readonly permission: ToolPermissionDescriptor;
  execute(request: ToolExecutionRequest, signal: AbortSignal): Promise<JsonValue>;
}

export type Tool = ToolPort;

export interface ToolRegistrationOptions {
  readonly groups?: readonly string[];
}

export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRegistryError';
  }
}

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();
  readonly #groups = new Map<string, Set<string>>();

  register(tool: Tool, options: ToolRegistrationOptions = {}): this {
    if (tool.name.length === 0) {
      throw new ToolRegistryError('Tool name must be non-empty.');
    }
    if (this.#tools.has(tool.name)) {
      throw new ToolRegistryError(`Tool already registered: ${tool.name}.`);
    }

    const groups = options.groups ?? [];
    for (const group of groups) {
      if (group.length === 0) {
        throw new ToolRegistryError('Tool group names must be non-empty.');
      }
    }

    this.#tools.set(tool.name, tool);
    for (const group of new Set(groups)) {
      const members = this.#groups.get(group) ?? new Set<string>();
      members.add(tool.name);
      this.#groups.set(group, members);
    }
    return this;
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  require(name: string): Tool {
    const tool = this.get(name);
    if (tool === undefined) {
      throw new ToolRegistryError(`Tool not registered: ${name}.`);
    }
    return tool;
  }

  list(group?: string): readonly Tool[] {
    if (group === undefined) {
      return [...this.#tools.values()];
    }
    const members = this.#groups.get(group);
    if (members === undefined) {
      return [];
    }
    return [...members].map((name) => this.require(name));
  }

  groups(): readonly string[] {
    return [...this.#groups.keys()];
  }

  groupsFor(name: string): readonly string[] {
    this.require(name);
    return [...this.#groups].filter(([, members]) => members.has(name)).map(([group]) => group);
  }
}

const unconstrainedObjectSchema: JsonObject = Object.freeze({
  type: 'object',
  additionalProperties: true,
});

const noPermission: ToolPermissionDescriptor = Object.freeze({
  kind: 'none',
  description: 'No privileged action.',
});

abstract class RecordingTool implements Tool {
  abstract readonly name: string;
  readonly inputSchema = unconstrainedObjectSchema;
  readonly permission = noPermission;
  readonly #requests: ToolExecutionRequest[] = [];

  get requests(): readonly ToolExecutionRequest[] {
    return structuredClone(this.#requests);
  }

  async execute(request: ToolExecutionRequest, signal: AbortSignal): Promise<JsonValue> {
    signal.throwIfAborted();
    this.#requests.push(structuredClone(request));
    const result = await this.executeRecorded(request, signal);
    signal.throwIfAborted();
    return structuredClone(result);
  }

  protected abstract executeRecorded(
    request: ToolExecutionRequest,
    signal: AbortSignal,
  ): Promise<JsonValue>;
}

export class EchoTool extends RecordingTool {
  readonly name = 'echo';

  protected async executeRecorded(request: ToolExecutionRequest): Promise<JsonValue> {
    return structuredClone(request.args);
  }
}

export class FailingTool extends RecordingTool {
  readonly name = 'failing';
  readonly #error: unknown;

  constructor(error: unknown = new Error('Scripted tool failure.')) {
    super();
    this.#error = error;
  }

  protected async executeRecorded(): Promise<never> {
    throw this.#error;
  }
}

export class SlowTool extends RecordingTool {
  readonly name = 'slow';
  readonly #delayMs: number;

  constructor(delayMs: number) {
    super();
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new ToolRegistryError(`SlowTool delay must be non-negative; received ${delayMs}.`);
    }
    this.#delayMs = delayMs;
  }

  protected async executeRecorded(
    request: ToolExecutionRequest,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    await abortableDelay(this.#delayMs, signal);
    return structuredClone(request.args);
  }
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
