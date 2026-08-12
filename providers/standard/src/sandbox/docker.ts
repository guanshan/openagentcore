import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  LocalProcessSandbox,
  SANDBOX_WORKSPACE_PATH,
  SandboxContractError,
  type SandboxExecRequest,
  type SandboxExecResult,
  type SandboxFileSystemPort,
  type SandboxPort,
} from '@openagentcore/kernel';

export interface DockerAvailability {
  readonly available: boolean;
  readonly reason: string;
}

export interface DockerSandboxOptions {
  readonly root: string;
  readonly image?: string;
  readonly dockerCommand?: string;
  readonly network?: string;
  readonly runner?: SandboxPort;
}

/**
 * Docker CLI adapter. The repository is bind-mounted at the portable /workspace path.
 * Docker Engine and the configured image are explicit host prerequisites, never CI assumptions.
 */
export class DockerSandbox implements SandboxPort {
  readonly capabilities = Object.freeze({ snapshot: false });
  readonly workspacePath = SANDBOX_WORKSPACE_PATH;
  readonly fs: SandboxFileSystemPort;
  readonly image: string;
  readonly #root: string;
  readonly #dockerCommand: string;
  readonly #network: string;
  readonly #runner: SandboxPort;

  constructor(options: DockerSandboxOptions) {
    this.#root = realpathSync(resolve(options.root));
    this.image = options.image ?? 'node:22-bookworm-slim';
    this.#dockerCommand = options.dockerCommand ?? 'docker';
    this.#network = options.network ?? 'none';
    if (this.image.trim().length === 0) {
      throw new SandboxContractError('Docker image must be non-empty.');
    }
    this.#runner = options.runner ?? new LocalProcessSandbox({ root: this.#root });
    // A bind mount intentionally gives both implementations the same byte-native FS contract.
    this.fs = this.#runner.fs;
  }

  async availability(signal: AbortSignal): Promise<DockerAvailability> {
    signal.throwIfAborted();
    let engine: SandboxExecResult;
    try {
      engine = await this.#runner.exec(
        {
          command: this.#dockerCommand,
          args: ['info', '--format', '{{.ServerVersion}}'],
          cwd: this.workspacePath,
          maxOutputBytes: 32_000,
        },
        signal,
      );
    } catch (error) {
      return Object.freeze({ available: false, reason: stableError(error) });
    }
    if (engine.exitCode !== 0) {
      return Object.freeze({
        available: false,
        reason: `Docker Engine unavailable: ${summarizeFailure(engine)}`,
      });
    }
    const image = await this.#runner.exec(
      {
        command: this.#dockerCommand,
        args: ['image', 'inspect', this.image],
        cwd: this.workspacePath,
        maxOutputBytes: 32_000,
      },
      signal,
    );
    if (image.exitCode !== 0) {
      return Object.freeze({
        available: false,
        reason: `Docker image ${this.image} is not installed; conformance never pulls from the network.`,
      });
    }
    return Object.freeze({
      available: true,
      reason: `Docker Engine ${engine.stdout.trim()} with local image ${this.image}.`,
    });
  }

  async exec(request: SandboxExecRequest, signal: AbortSignal): Promise<SandboxExecResult> {
    signal.throwIfAborted();
    const cwd = request.cwd ?? this.workspacePath;
    if (cwd !== this.workspacePath && !cwd.startsWith(`${this.workspacePath}/`)) {
      throw new SandboxContractError(`Docker cwd must be below ${this.workspacePath}.`);
    }
    if (request.shell === true && request.args !== undefined && request.args.length > 0) {
      throw new SandboxContractError('Docker shell commands must not also provide args.');
    }
    const environment = Object.entries(request.environment ?? {}).flatMap(([key, value]) => [
      '--env',
      `${key}=${value}`,
    ]);
    const inner =
      request.shell === true
        ? ['sh', '-lc', request.command]
        : [request.command, ...(request.args ?? [])];
    const result = await this.#runner.exec(
      {
        command: this.#dockerCommand,
        args: [
          'run',
          '--rm',
          '--network',
          this.#network,
          '--volume',
          `${this.#root}:${this.workspacePath}`,
          '--workdir',
          cwd,
          ...environment,
          this.image,
          ...inner,
        ],
        cwd: this.workspacePath,
        ...(request.maxOutputBytes === undefined ? {} : { maxOutputBytes: request.maxOutputBytes }),
      },
      signal,
    );
    return Object.freeze({
      ...result,
      command: [request.command, ...(request.args ?? [])].join(' '),
    });
  }

  async close(): Promise<void> {}
}

function summarizeFailure(result: SandboxExecResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail.length === 0 ? `exit code ${String(result.exitCode)}` : detail.slice(0, 500);
}

function stableError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
