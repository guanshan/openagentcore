import { posix } from 'node:path';

import {
  SANDBOX_WORKSPACE_PATH,
  SandboxBoundaryError,
  SandboxContractError,
  type SandboxExecRequest,
  type SandboxExecResult,
  type SandboxFileSystemPort,
  type SandboxPort,
} from '@openagentcore/kernel';

const OPTIONAL_E2B_MODULE = '@e2b/code-interpreter';
const DEFAULT_TEMPLATE = 'code-interpreter-v1';
const DEFAULT_MAX_FILE_BYTES = 8_000_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

export interface TencentSandboxCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Provider-local seam used by tests and by the optional SDK bridge. */
export interface TencentSandboxClient {
  makeDir(path: string, signal: AbortSignal): Promise<void>;
  readFile(path: string, signal: AbortSignal): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array, signal: AbortSignal): Promise<void>;
  run(
    command: string,
    options: {
      readonly cwd: string;
      readonly environment?: Readonly<Record<string, string>>;
      readonly signal: AbortSignal;
    },
  ): Promise<TencentSandboxCommandResult>;
  close(): Promise<void>;
}

export interface TencentSandboxClientOptions {
  readonly apiKey?: string;
  readonly domain?: string;
  readonly template: string;
  readonly timeoutMs?: number;
  readonly allowInternetAccess: boolean;
}

export interface TencentSandboxClientFactory {
  create(options: TencentSandboxClientOptions, signal: AbortSignal): Promise<TencentSandboxClient>;
}

export interface TencentAgentRuntimeSandboxOptions {
  readonly apiKey?: string;
  readonly domain?: string;
  readonly template?: string;
  readonly timeoutMs?: number;
  readonly allowInternetAccess?: boolean;
  readonly maxFileBytes?: number;
  readonly maxOutputBytes?: number;
  readonly clientFactory?: TencentSandboxClientFactory;
}

/**
 * Tencent Agent Runtime sandbox adapter using its documented E2B-compatible endpoint.
 * Snapshot remains false until the Tencent-hosted capability is verified and recorded.
 */
export class TencentAgentRuntimeSandbox implements SandboxPort {
  readonly capabilities = Object.freeze({ snapshot: false });
  readonly workspacePath = SANDBOX_WORKSPACE_PATH;
  readonly fs: SandboxFileSystemPort;

  readonly #options: TencentSandboxClientOptions;
  readonly #factory: TencentSandboxClientFactory;
  readonly #maxFileBytes: number;
  readonly #maxOutputBytes: number;
  #client: Promise<TencentSandboxClient> | undefined;
  #closed = false;

  constructor(options: TencentAgentRuntimeSandboxOptions = {}) {
    this.#options = Object.freeze({
      template: nonEmpty(options.template ?? DEFAULT_TEMPLATE, 'template'),
      allowInternetAccess: options.allowInternetAccess ?? false,
      ...(options.apiKey === undefined ? {} : { apiKey: nonEmpty(options.apiKey, 'apiKey') }),
      ...(options.domain === undefined ? {} : { domain: nonEmpty(options.domain, 'domain') }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: positiveLimit(options.timeoutMs, 'timeoutMs') }),
    });
    this.#factory = options.clientFactory ?? new E2bTencentSandboxClientFactory();
    this.#maxFileBytes = positiveLimit(
      options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      'maxFileBytes',
    );
    this.#maxOutputBytes = positiveLimit(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      'maxOutputBytes',
    );
    this.fs = Object.freeze({
      readFile: (path: string, signal: AbortSignal) => this.#readFile(path, signal),
      writeFile: (path: string, content: Uint8Array, signal: AbortSignal) =>
        this.#writeFile(path, content, signal),
      realpath: (path: string, signal: AbortSignal) => this.#realpath(path, signal),
    });
  }

  async exec(request: SandboxExecRequest, signal: AbortSignal): Promise<SandboxExecResult> {
    signal.throwIfAborted();
    if (request.command.length === 0) {
      throw new SandboxContractError('Sandbox exec command must be non-empty.');
    }
    if (request.shell === true && request.args !== undefined && request.args.length > 0) {
      throw new SandboxContractError('Sandbox shell commands must not also provide args.');
    }
    const cwd = await this.#realpath(request.cwd ?? this.workspacePath, signal);
    const command =
      request.shell === true
        ? request.command
        : [request.command, ...(request.args ?? [])].map(shellQuote).join(' ');
    const result = await (
      await this.#getClient(signal)
    ).run(command, {
      cwd,
      ...(request.environment === undefined ? {} : { environment: request.environment }),
      signal,
    });
    signal.throwIfAborted();
    const maxOutputBytes = positiveLimit(
      request.maxOutputBytes ?? this.#maxOutputBytes,
      'maxOutputBytes',
    );
    const truncated = truncateOutput(result.stdout, result.stderr, maxOutputBytes);
    return Object.freeze({
      command: [request.command, ...(request.args ?? [])].join(' '),
      stdout: truncated.stdout,
      stderr: truncated.stderr,
      exitCode: result.exitCode,
      signal: null,
      outputTruncated: truncated.outputTruncated,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const client = this.#client === undefined ? undefined : await this.#client;
    await client?.close();
  }

  async #readFile(path: string, signal: AbortSignal): Promise<Uint8Array> {
    const canonical = await this.#realpath(path, signal);
    const content = await (await this.#getClient(signal)).readFile(canonical, signal);
    signal.throwIfAborted();
    if (content.byteLength > this.#maxFileBytes) {
      throw new SandboxContractError(
        `Sandbox file exceeds maxFileBytes (${content.byteLength} > ${this.#maxFileBytes}).`,
      );
    }
    return new Uint8Array(content);
  }

  async #writeFile(path: string, content: Uint8Array, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (content.byteLength > this.#maxFileBytes) {
      throw new SandboxContractError(
        `Sandbox file exceeds maxFileBytes (${content.byteLength} > ${this.#maxFileBytes}).`,
      );
    }
    const normalized = workspacePath(path);
    const parent = await this.#realpath(posix.dirname(normalized), signal);
    const target = posix.join(parent, posix.basename(normalized));
    workspacePath(target);
    await (await this.#getClient(signal)).writeFile(target, new Uint8Array(content), signal);
    signal.throwIfAborted();
  }

  async #realpath(path: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const normalized = workspacePath(path);
    const result = await (
      await this.#getClient(signal)
    ).run(`realpath -- ${shellQuote(normalized)}`, {
      cwd: this.workspacePath,
      signal,
    });
    signal.throwIfAborted();
    if (result.exitCode !== 0) {
      throw new SandboxContractError(`Sandbox path does not exist: ${normalized}.`);
    }
    const canonical = result.stdout.trim();
    if (canonical.length === 0) {
      throw new SandboxContractError(`Sandbox realpath returned no path for ${normalized}.`);
    }
    return workspacePath(canonical);
  }

  async #getClient(signal: AbortSignal): Promise<TencentSandboxClient> {
    signal.throwIfAborted();
    if (this.#closed) {
      throw new SandboxContractError('Sandbox is closed.');
    }
    this.#client ??= this.#factory.create(this.#options, signal).then(async (client) => {
      await client.makeDir(this.workspacePath, signal);
      return client;
    });
    return this.#client;
  }
}

class E2bTencentSandboxClientFactory implements TencentSandboxClientFactory {
  async create(
    options: TencentSandboxClientOptions,
    signal: AbortSignal,
  ): Promise<TencentSandboxClient> {
    signal.throwIfAborted();
    let loaded: unknown;
    try {
      loaded = await import(OPTIONAL_E2B_MODULE);
    } catch {
      throw new SandboxContractError(
        `Tencent sandbox requires the optional ${OPTIONAL_E2B_MODULE} peer dependency.`,
      );
    }
    const Sandbox = moduleSandbox(loaded);
    const sandbox = await Sandbox.create(options.template, {
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.domain === undefined ? {} : { domain: options.domain }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      allowInternetAccess: options.allowInternetAccess,
      signal,
    });
    return {
      makeDir: async (path, operationSignal) => {
        await sandbox.files.makeDir(path, { signal: operationSignal });
      },
      readFile: async (path, operationSignal) =>
        new Uint8Array(
          await sandbox.files.read(path, { format: 'bytes', signal: operationSignal }),
        ),
      writeFile: async (path, content, operationSignal) => {
        await sandbox.files.write(path, content, { signal: operationSignal });
      },
      run: async (command, runOptions) => {
        const result = await sandbox.commands.run(command, {
          cwd: runOptions.cwd,
          ...(runOptions.environment === undefined ? {} : { envs: runOptions.environment }),
          signal: runOptions.signal,
        });
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        };
      },
      close: async () => {
        await sandbox.kill();
      },
    };
  }
}

interface E2bSandboxModule {
  readonly Sandbox: {
    create(
      template: string,
      options: Readonly<Record<string, unknown>>,
    ): Promise<{
      readonly files: {
        makeDir(path: string, options: Readonly<Record<string, unknown>>): Promise<void>;
        read(path: string, options: Readonly<Record<string, unknown>>): Promise<Uint8Array>;
        write(
          path: string,
          content: Uint8Array,
          options: Readonly<Record<string, unknown>>,
        ): Promise<void>;
      };
      readonly commands: {
        run(
          command: string,
          options: Readonly<Record<string, unknown>>,
        ): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;
      };
      kill(): Promise<void>;
    }>;
  };
}

function moduleSandbox(module: unknown): E2bSandboxModule['Sandbox'] {
  if (
    typeof module !== 'object' ||
    module === null ||
    !('Sandbox' in module) ||
    typeof (module as E2bSandboxModule).Sandbox?.create !== 'function'
  ) {
    throw new SandboxContractError(`${OPTIONAL_E2B_MODULE} did not export Sandbox.create().`);
  }
  return (module as E2bSandboxModule).Sandbox;
}

function workspacePath(path: string): string {
  if (!posix.isAbsolute(path)) {
    throw new SandboxBoundaryError(path);
  }
  const normalized = posix.normalize(path.replaceAll('\\', '/'));
  if (
    normalized !== SANDBOX_WORKSPACE_PATH &&
    !normalized.startsWith(`${SANDBOX_WORKSPACE_PATH}/`)
  ) {
    throw new SandboxBoundaryError(path);
  }
  return normalized;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function truncateOutput(
  stdout: string,
  stderr: string,
  maxBytes: number,
): { readonly stdout: string; readonly stderr: string; readonly outputTruncated: boolean } {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const stdoutBytes = encoder.encode(stdout);
  const stderrBytes = encoder.encode(stderr);
  if (stdoutBytes.byteLength + stderrBytes.byteLength <= maxBytes) {
    return { stdout, stderr, outputTruncated: false };
  }
  const keptStdout = stdoutBytes.subarray(0, Math.min(stdoutBytes.byteLength, maxBytes));
  const remaining = Math.max(0, maxBytes - keptStdout.byteLength);
  return {
    stdout: decoder.decode(keptStdout),
    stderr: decoder.decode(stderrBytes.subarray(0, remaining)),
    outputTruncated: true,
  };
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SandboxContractError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function nonEmpty(value: string, name: string): string {
  if (value.length === 0) {
    throw new SandboxContractError(`${name} must be non-empty.`);
  }
  return value;
}
