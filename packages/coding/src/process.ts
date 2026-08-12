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
  LocalProcessSandbox,
  SANDBOX_WORKSPACE_PATH,
  type SandboxPort,
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
  readonly outputTruncated: boolean;
}

const executePermission: ToolPermissionDescriptor = Object.freeze({
  kind: 'process-execute',
  description:
    'Executes a sandbox command inside the repository after fixed dangerous-command guards.',
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
  readonly #sandbox: SandboxPort;
  readonly #maxOutputBytes: number;

  constructor(
    workspace: RepositoryWorkspace,
    options: { readonly maxOutputBytes?: number; readonly sandbox?: SandboxPort } = {},
  ) {
    this.#workspace = workspace;
    this.#maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
    this.#sandbox = options.sandbox ?? new LocalProcessSandbox({ root: workspace.root });
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
        ? SANDBOX_WORKSPACE_PATH
        : await this.#workspace.sandboxPath(requestedCwd);
    const result = await this.#sandbox.exec(
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
  const sandbox = new LocalProcessSandbox({
    root: options.cwd,
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
  });
  return sandbox.exec(
    {
      command: options.command,
      ...(options.args === undefined ? {} : { args: options.args }),
      cwd: SANDBOX_WORKSPACE_PATH,
      ...(options.shell === undefined ? {} : { shell: options.shell }),
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
      ...(options.environment === undefined
        ? {}
        : { environment: definedEnvironment(options.environment) }),
    },
    signal,
  );
}

export function definedEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
