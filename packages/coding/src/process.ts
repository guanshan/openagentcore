import { spawn } from 'node:child_process';

import type {
  JsonObject,
  Tool,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolPermissionDescriptor,
} from '@openagentcore/kernel';

import { failed, inputObject, optionalStringInput, stringInput, succeeded } from './contract.js';
import type { RepositoryWorkspace } from './workspace.js';

export interface ProcessRunOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly shell?: boolean;
  readonly maxOutputBytes?: number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface ProcessResult extends JsonObject {
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

const executePermission: ToolPermissionDescriptor = Object.freeze({
  kind: 'process-execute',
  description:
    'Executes a local command inside the repository after fixed dangerous-command guards.',
});

export class DangerousCommandError extends Error {
  readonly rule: string;

  constructor(rule: string) {
    super(`Command blocked by safety rule: ${rule}.`);
    this.name = 'DangerousCommandError';
    this.rule = rule;
  }
}

export class RunCommandTool implements Tool {
  readonly name = 'coding.run-command';
  readonly inputSchema: JsonObject = Object.freeze({
    type: 'object',
    required: ['command'],
    properties: {
      command: { type: 'string', minLength: 1 },
      cwd: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  });
  readonly permission = executePermission;
  readonly #workspace: RepositoryWorkspace;
  readonly #maxOutputBytes: number;

  constructor(workspace: RepositoryWorkspace, options: { readonly maxOutputBytes?: number } = {}) {
    this.#workspace = workspace;
    this.#maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
  }

  async execute(request: ToolExecutionRequest, signal: AbortSignal): Promise<ToolExecutionResult> {
    signal.throwIfAborted();
    const args = inputObject(this.name, request.args);
    const command = stringInput(this.name, args, 'command');
    const rule = dangerousCommandRule(command);
    if (rule !== undefined) {
      const error = new DangerousCommandError(rule);
      return failed({ error: 'dangerous-command', rule, message: error.message });
    }
    const requestedCwd = optionalStringInput(this.name, args, 'cwd');
    const cwd =
      requestedCwd === undefined
        ? this.#workspace.root
        : await this.#workspace.resolveExisting(requestedCwd);
    const result = await runProcess(
      {
        command,
        cwd,
        shell: true,
        maxOutputBytes: this.#maxOutputBytes,
      },
      signal,
    );
    return result.exitCode === 0 ? succeeded(result) : failed(result);
  }
}

export function dangerousCommandRule(command: string): string | undefined {
  const normalized = command.trim().replace(/\s+/g, ' ').toLowerCase();
  const rules: readonly [string, RegExp][] = [
    ['recursive-force-delete', /(?:^|[;&|]\s*)rm\s+(?:-[a-z]*[rf][a-z]*\s+)+/],
    ['git-reset-hard', /(?:^|[;&|]\s*)git\s+reset\s+--hard(?:\s|$)/],
    ['git-clean-force', /(?:^|[;&|]\s*)git\s+clean\s+-[a-z]*f/],
    ['filesystem-format', /(?:^|[;&|]\s*)(?:mkfs(?:\.[a-z0-9]+)?|fdisk|parted)(?:\s|$)/],
    ['raw-device-write', /(?:^|[;&|]\s*)dd\s+[^;&|]*(?:of=\/dev\/|if=\/dev\/)/],
    ['host-power-control', /(?:^|[;&|]\s*)(?:shutdown|reboot|poweroff|halt)(?:\s|$)/],
    ['fork-bomb', /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/],
  ];
  return rules.find(([, pattern]) => pattern.test(normalized))?.[0];
}

export function runProcess(
  options: ProcessRunOptions,
  signal: AbortSignal,
): Promise<ProcessResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      shell: options.shell ?? false,
      env:
        options.environment === undefined
          ? process.env
          : { ...process.env, ...options.environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
    let stdout = '';
    let stderr = '';
    let settled = false;

    const append = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      const value = chunk.toString('utf8');
      if (stream === 'stdout') {
        stdout += value;
      } else {
        stderr += value;
      }
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxOutputBytes) {
        child.kill('SIGTERM');
      }
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));

    const onAbort = (): void => {
      child.kill('SIGTERM');
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.once('error', (error) => {
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (exitCode, childSignal) => {
      if (settled) {
        return;
      }
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) {
        reject(signal.reason ?? new Error('Command aborted.'));
        return;
      }
      resolve({
        command: [options.command, ...(options.args ?? [])].join(' '),
        stdout,
        stderr,
        exitCode,
        signal: childSignal,
      });
    });
  });
}
