import type {
  ActionCommandDescriptor,
  ActionDescriptor,
  ActionPathDescriptor,
  JsonObject,
  JsonValue,
} from '../events/types.js';
import type { CredentialScope, ShortLivedCredential, VaultPort } from '../ports/vault.js';
import { UnavailableVault, VaultUnavailableError, defineCredentialScope } from '../ports/vault.js';

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

export type ToolExecutionResult =
  | { readonly outcome: 'succeeded'; readonly result: JsonValue }
  | { readonly outcome: 'failed'; readonly result: JsonValue };

export interface ToolPort {
  readonly name: string;
  readonly inputSchema: JsonObject;
  readonly permission: ToolPermissionDescriptor;
  /** Resolves resource-specific permission material before policy evaluation. */
  describeAction?(args: JsonValue, signal: AbortSignal): Promise<ToolActionDetails>;
  execute(request: ToolExecutionRequest, signal: AbortSignal): Promise<ToolExecutionResult>;
}

export interface ToolActionDetails extends JsonObject {
  readonly paths?: ActionPathDescriptor;
  readonly command?: ActionCommandDescriptor;
}

export type Tool = ToolPort;

/** Tool shape accepted by withCredential(). The decorator turns it into a regular ToolPort. */
export interface CredentialToolPort {
  readonly name: string;
  readonly inputSchema: JsonObject;
  readonly permission: ToolPermissionDescriptor;
  describeAction?(args: JsonValue, signal: AbortSignal): Promise<ToolActionDetails>;
  execute(
    request: ToolExecutionRequest,
    credential: ShortLivedCredential,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult>;
}

export interface CredentialUseAudit {
  readonly scope: CredentialScope;
  readonly tool: string;
  readonly callId: string;
  readonly attempt: number;
  readonly expiresAt: string;
}

export interface ToolExecutionContext {
  readonly vault?: VaultPort;
  onCredentialUsed?(usage: CredentialUseAudit, signal: AbortSignal): Promise<void>;
}

export interface ToolRegistrationOptions {
  readonly groups?: readonly string[];
}

export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRegistryError';
  }
}

export class ToolContractError extends Error {
  readonly tool: string;

  constructor(tool: string, detail: string) {
    super(`Tool "${tool}" must return { outcome, result }, received ${detail}.`);
    this.name = 'ToolContractError';
    this.tool = tool;
  }
}

interface CredentialToolBinding {
  readonly scope: CredentialScope;
  readonly tool: CredentialToolPort;
}

const credentialBindings = new WeakMap<Tool, CredentialToolBinding>();

/**
 * Decorates a credential-aware tool without retaining Vault or secret material on the tool
 * object. The binding lives in a module-private WeakMap and is resolved only during execution.
 */
export function withCredential(scope: CredentialScope): (tool: CredentialToolPort) => Tool {
  const safeScope = defineCredentialScope(scope.id, {
    targets: scope.targets,
    header: scope.header,
    prefix: scope.prefix,
  });
  return (tool) => {
    const decorated: Tool = Object.freeze({
      name: tool.name,
      inputSchema: structuredClone(tool.inputSchema),
      permission: structuredClone(tool.permission),
      ...(tool.describeAction === undefined
        ? {}
        : {
            describeAction: (args: JsonValue, signal: AbortSignal) =>
              tool.describeAction?.call(tool, args, signal) ?? Promise.resolve({}),
          }),
      execute: async () => {
        throw new VaultUnavailableError(safeScope);
      },
    });
    credentialBindings.set(decorated, { scope: safeScope, tool });
    return decorated;
  };
}

/** Kernel execution seam used by AgentLoop so the public ToolPort contract stays serializable. */
export async function executeToolPort(
  tool: Tool,
  request: ToolExecutionRequest,
  signal: AbortSignal,
  context: ToolExecutionContext = {},
): Promise<ToolExecutionResult> {
  const binding = credentialBindings.get(tool);
  if (binding === undefined) {
    return tool.execute(request, signal);
  }

  signal.throwIfAborted();
  const credential = await (context.vault ?? new UnavailableVault()).issue(binding.scope);
  try {
    signal.throwIfAborted();
    await context.onCredentialUsed?.(
      {
        scope: binding.scope,
        tool: tool.name,
        callId: request.callId,
        attempt: request.attempt,
        expiresAt: credential.expiresAt,
      },
      signal,
    );
    signal.throwIfAborted();
    return await binding.tool.execute(request, credential, signal);
  } finally {
    credential.release();
  }
}

const reservedActionFields = new Set(['tool', 'args', 'permission']);

export async function describeToolAction(
  tool: Tool,
  args: JsonValue,
  signal: AbortSignal,
): Promise<ActionDescriptor> {
  signal.throwIfAborted();
  const details = tool.describeAction === undefined ? {} : await tool.describeAction(args, signal);
  signal.throwIfAborted();
  for (const field of reservedActionFields) {
    if (field in details) {
      throw new ToolContractError(tool.name, `describeAction must not override ${field}`);
    }
  }
  return Object.freeze({
    tool: tool.name,
    args: structuredClone(args),
    permission: structuredClone(tool.permission),
    ...structuredClone(details),
  });
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

  async execute(request: ToolExecutionRequest, signal: AbortSignal): Promise<ToolExecutionResult> {
    signal.throwIfAborted();
    this.#requests.push(structuredClone(request));
    const result = await this.executeRecorded(request, signal);
    signal.throwIfAborted();
    return structuredClone(result);
  }

  protected abstract executeRecorded(
    request: ToolExecutionRequest,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult>;
}

export class EchoTool extends RecordingTool {
  readonly name = 'echo';

  protected async executeRecorded(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    return { outcome: 'succeeded', result: structuredClone(request.args) };
  }
}

export class ResultFailingTool extends RecordingTool {
  readonly name = 'result-failing';
  readonly #result: JsonValue;

  constructor(result: JsonValue = { error: 'Scripted tool result failure.' }) {
    super();
    this.#result = structuredClone(result);
  }

  protected async executeRecorded(): Promise<ToolExecutionResult> {
    return { outcome: 'failed', result: structuredClone(this.#result) };
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
  ): Promise<ToolExecutionResult> {
    await abortableDelay(this.#delayMs, signal);
    return { outcome: 'succeeded', result: structuredClone(request.args) };
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
