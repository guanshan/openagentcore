import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { posix } from 'node:path';

import type { JsonObject } from '../events/types.js';

export const SANDBOX_WORKSPACE_PATH = '/workspace';

export interface SandboxCapabilities {
  readonly snapshot: boolean;
}

export interface SandboxCapabilityRequest {
  readonly snapshot?: boolean;
}

export interface SandboxCapabilityNegotiation {
  readonly capabilities: SandboxCapabilities;
  readonly downgrades: readonly string[];
}

export interface SandboxExecRequest {
  /** Executable name when shell is false, full command text when shell is true. */
  readonly command: string;
  readonly args?: readonly string[];
  /** Portable POSIX path below /workspace. */
  readonly cwd?: string;
  readonly shell?: boolean;
  readonly environment?: Readonly<Record<string, string>>;
  readonly maxOutputBytes?: number;
}

export interface SandboxExecResult extends JsonObject {
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly outputTruncated: boolean;
}

export interface SandboxFileSystemPort {
  /** Byte-native read; text encoding is chosen by the caller. */
  readFile(path: string, signal: AbortSignal): Promise<Uint8Array>;
  /** Byte-native write with provider-enforced payload limits. */
  writeFile(path: string, content: Uint8Array, signal: AbortSignal): Promise<void>;
  /** Returns a canonical POSIX path in the sandbox namespace. */
  realpath(path: string, signal: AbortSignal): Promise<string>;
}

export interface SandboxSnapshot {
  readonly id: string;
}

export interface SandboxPort {
  readonly capabilities: SandboxCapabilities;
  readonly workspacePath: typeof SANDBOX_WORKSPACE_PATH;
  readonly fs: SandboxFileSystemPort;
  exec(request: SandboxExecRequest, signal: AbortSignal): Promise<SandboxExecResult>;
  snapshot?(signal: AbortSignal): Promise<SandboxSnapshot>;
  restore?(snapshot: SandboxSnapshot, signal: AbortSignal): Promise<void>;
  /** Releases provider-owned resources. Local implementations may use a no-op. */
  close?(): Promise<void>;
}

export class SandboxContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxContractError';
  }
}

export class SandboxBoundaryError extends Error {
  constructor(path: string) {
    super(`Path is outside the sandbox workspace: ${path}.`);
    this.name = 'SandboxBoundaryError';
  }
}

export function negotiateSandboxCapabilities(
  sandbox: SandboxPort,
  request: SandboxCapabilityRequest = {},
): SandboxCapabilityNegotiation {
  validateSandboxCapabilities(sandbox);
  const downgrades: string[] = [];
  if (request.snapshot === true && !sandbox.capabilities.snapshot) {
    downgrades.push('sandbox-snapshot:requested->unavailable');
  }
  return Object.freeze({
    capabilities: Object.freeze({ ...sandbox.capabilities }),
    downgrades: Object.freeze(downgrades),
  });
}

export function validateSandboxCapabilities(sandbox: SandboxPort): void {
  if (
    sandbox.capabilities.snapshot &&
    (typeof sandbox.snapshot !== 'function' || typeof sandbox.restore !== 'function')
  ) {
    throw new SandboxContractError(
      'Sandbox declares snapshot support but does not implement snapshot and restore.',
    );
  }
}

export interface LocalProcessSandboxOptions {
  readonly root: string;
  readonly maxFileBytes?: number;
  readonly maxOutputBytes?: number;
}

/**
 * Zero-dependency local adapter for development. It satisfies SandboxPort but is not isolation.
 */
export class LocalProcessSandbox implements SandboxPort {
  readonly capabilities = Object.freeze({ snapshot: false });
  readonly workspacePath = SANDBOX_WORKSPACE_PATH;
  readonly fs: SandboxFileSystemPort;
  readonly #root: string;
  readonly #maxFileBytes: number;
  readonly #maxOutputBytes: number;

  constructor(options: LocalProcessSandboxOptions) {
    this.#root = realpathSync(resolve(options.root));
    this.#maxFileBytes = positiveLimit(options.maxFileBytes ?? 8_000_000, 'maxFileBytes');
    this.#maxOutputBytes = positiveLimit(options.maxOutputBytes ?? 1_000_000, 'maxOutputBytes');
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
    const cwd = await this.#hostExisting(request.cwd ?? this.workspacePath);
    const maxOutputBytes = positiveLimit(
      request.maxOutputBytes ?? this.#maxOutputBytes,
      'maxOutputBytes',
    );
    return spawnProcess(
      {
        command: request.command,
        args: request.args ?? [],
        cwd,
        shell: request.shell ?? false,
        environment: request.environment,
        maxOutputBytes,
      },
      signal,
    );
  }

  async close(): Promise<void> {}

  async #readFile(path: string, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    const content = await readFile(await this.#hostExisting(path));
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
    await writeFile(await this.#hostWrite(path), content);
    signal.throwIfAborted();
  }

  async #realpath(path: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const host = await this.#hostExisting(path);
    signal.throwIfAborted();
    const suffix = relative(this.#root, host).split('\\').join('/');
    return suffix.length === 0 ? this.workspacePath : posix.join(this.workspacePath, suffix);
  }

  async #hostExisting(path: string): Promise<string> {
    const candidate = this.#hostCandidate(path);
    const canonical = await realpath(candidate);
    this.#assertHostInside(canonical, path);
    return canonical;
  }

  async #hostWrite(path: string): Promise<string> {
    const candidate = this.#hostCandidate(path);
    try {
      const canonical = await realpath(candidate);
      this.#assertHostInside(canonical, path);
      return canonical;
    } catch (error) {
      if (!isMissingPath(error)) {
        throw error;
      }
    }
    const parent = await realpath(dirname(candidate));
    this.#assertHostInside(parent, path);
    return resolve(parent, basename(candidate));
  }

  #hostCandidate(path: string): string {
    if (!isAbsolute(path)) {
      throw new SandboxBoundaryError(path);
    }
    const normalized = posix.normalize(path.replaceAll('\\', '/'));
    if (normalized !== this.workspacePath && !normalized.startsWith(`${this.workspacePath}/`)) {
      throw new SandboxBoundaryError(path);
    }
    const suffix = posix.relative(this.workspacePath, normalized);
    const candidate = resolve(this.#root, suffix);
    this.#assertHostInside(candidate, path);
    return candidate;
  }

  #assertHostInside(path: string, requested: string): void {
    const fromRoot = relative(this.#root, path);
    if (fromRoot !== '' && (fromRoot.startsWith('..') || isAbsolute(fromRoot))) {
      throw new SandboxBoundaryError(requested);
    }
  }
}

interface SpawnProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly shell: boolean;
  readonly environment: Readonly<Record<string, string>> | undefined;
  readonly maxOutputBytes: number;
}

function spawnProcess(
  options: SpawnProcessOptions,
  signal: AbortSignal,
): Promise<SandboxExecResult> {
  signal.throwIfAborted();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      shell: options.shell,
      env:
        options.environment === undefined
          ? process.env
          : { ...process.env, ...options.environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let outputTruncated = false;
    let settled = false;

    const append = (destination: Buffer[], chunk: Buffer): void => {
      if (outputTruncated) {
        return;
      }
      const remaining = options.maxOutputBytes - outputBytes;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) {
          destination.push(chunk.subarray(0, remaining));
        }
        outputTruncated = true;
        child.kill('SIGTERM');
      } else {
        destination.push(chunk);
        outputBytes += chunk.byteLength;
      }
    };
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));

    const onAbort = (): void => {
      child.kill('SIGTERM');
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (exitCode, childSignal) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) {
        reject(signal.reason ?? new Error('Sandbox command aborted.'));
        return;
      }
      resolvePromise(
        Object.freeze({
          command: [options.command, ...options.args].join(' '),
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode,
          signal: childSignal,
          outputTruncated,
        }),
      );
    });
  });
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SandboxContractError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}
