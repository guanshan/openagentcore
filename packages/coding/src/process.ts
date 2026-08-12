import { spawn } from 'node:child_process';

import type {
  JsonObject,
  JsonValue,
  Tool,
  ToolActionDetails,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolPermissionDescriptor,
} from '@openagentcore/kernel';

import {
  CodingToolInputError,
  failed,
  inputObject,
  optionalStringInput,
  stringInput,
  succeeded,
} from './contract.js';
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

  async describeAction(argsValue: JsonValue): Promise<ToolActionDetails> {
    const args = inputObject(this.name, argsValue);
    const command = stringInput(this.name, args, 'command');
    const requestedCwd = optionalStringInput(this.name, args, 'cwd');
    const cwd =
      requestedCwd === undefined
        ? this.#workspace.root
        : await this.#workspace.resolveExisting(requestedCwd);
    return {
      paths: {
        root: this.#workspace.root,
        read: [cwd],
        write: [cwd],
      },
      command: { text: command, executable: commandExecutable(command) },
    };
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

export function commandExecutable(command: string): string {
  const words = shellWords(command);
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) {
    index += 1;
  }
  if (words[index] === 'env') {
    index += 1;
    while (
      index < words.length &&
      ((words[index] ?? '').startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? ''))
    ) {
      index += 1;
    }
  }
  const executable = words[index];
  if (executable === undefined || executable.length === 0) {
    throw new CodingToolInputError('coding.run-command', 'command must contain an executable.');
  }
  return executable.split(/[\\/]/).at(-1) ?? executable;
}

function shellWords(command: string): readonly string[] {
  const words: string[] = [];
  let word = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const push = (): void => {
    if (word.length > 0) {
      words.push(word);
      word = '';
    }
  };
  for (const character of command.trim()) {
    if (escaped) {
      word += character;
      escaped = false;
    } else if (character === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        word += character;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      push();
    } else if (';&|'.includes(character)) {
      push();
      break;
    } else {
      word += character;
    }
  }
  if (escaped || quote !== undefined) {
    throw new CodingToolInputError('coding.run-command', 'command contains an unfinished quote.');
  }
  push();
  return words;
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
