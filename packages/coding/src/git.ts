import type {
  JsonObject,
  JsonValue,
  Tool,
  ToolActionDetails,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolPermissionDescriptor,
} from '@openagentcore/kernel';

import { inputObject, stringArrayInput, stringInput, succeeded } from './contract.js';
import { runProcess } from './process.js';
import type { RepositoryWorkspace } from './workspace.js';

const gitReadPermission: ToolPermissionDescriptor = Object.freeze({
  kind: 'repository-read',
  description: 'Reads Git metadata and diffs from the repository.',
});

const gitWritePermission: ToolPermissionDescriptor = Object.freeze({
  kind: 'repository-write',
  description: 'Changes Git branch or commit state inside the repository.',
});

export interface GitToolOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

abstract class GitTool implements Tool {
  abstract readonly name: string;
  abstract readonly inputSchema: JsonObject;
  abstract readonly permission: ToolPermissionDescriptor;
  protected readonly workspace: RepositoryWorkspace;
  readonly #environment: Readonly<Record<string, string | undefined>> | undefined;

  constructor(workspace: RepositoryWorkspace, options: GitToolOptions = {}) {
    this.workspace = workspace;
    this.#environment = options.environment;
  }

  abstract execute(
    request: ToolExecutionRequest,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult>;

  protected async git(args: readonly string[], signal: AbortSignal) {
    return runProcess(
      {
        command: 'git',
        args,
        cwd: this.workspace.root,
        ...(this.#environment === undefined ? {} : { environment: this.#environment }),
      },
      signal,
    );
  }
}

export class GitCreateBranchTool extends GitTool {
  readonly name = 'coding.git-create-branch';
  readonly inputSchema: JsonObject = Object.freeze({
    type: 'object',
    required: ['branch'],
    properties: { branch: { type: 'string', minLength: 1 } },
    additionalProperties: false,
  });
  readonly permission = gitWritePermission;

  async describeAction(): Promise<ToolActionDetails> {
    return {
      paths: { root: this.workspace.root, read: [], write: [this.workspace.root] },
    };
  }

  async execute(request: ToolExecutionRequest, signal: AbortSignal): Promise<ToolExecutionResult> {
    const args = inputObject(this.name, request.args);
    const branch = stringInput(this.name, args, 'branch');
    if (branch.startsWith('-') || /[\s~^:?*[\\]/.test(branch)) {
      return { outcome: 'failed', result: { error: 'invalid-branch', branch } };
    }
    const result = await this.git(['switch', '-c', branch], signal);
    return result.exitCode === 0 ? succeeded(result) : { outcome: 'failed', result };
  }
}

export class GitDiffTool extends GitTool {
  readonly name = 'coding.git-diff';
  readonly inputSchema: JsonObject = Object.freeze({
    type: 'object',
    properties: { staged: { type: 'boolean' } },
    additionalProperties: false,
  });
  readonly permission = gitReadPermission;

  async describeAction(): Promise<ToolActionDetails> {
    return {
      paths: { root: this.workspace.root, read: [this.workspace.root], write: [] },
    };
  }

  async execute(request: ToolExecutionRequest, signal: AbortSignal): Promise<ToolExecutionResult> {
    const args = inputObject(this.name, request.args);
    const staged = args['staged'];
    if (staged !== undefined && typeof staged !== 'boolean') {
      return { outcome: 'failed', result: { error: 'staged-must-be-boolean' } };
    }
    const result = await this.git(staged === true ? ['diff', '--cached'] : ['diff'], signal);
    return result.exitCode === 0 ? succeeded(result) : { outcome: 'failed', result };
  }
}

export class GitCommitTool extends GitTool {
  readonly name = 'coding.git-commit';
  readonly inputSchema: JsonObject = Object.freeze({
    type: 'object',
    required: ['message', 'paths'],
    properties: {
      message: { type: 'string', minLength: 1 },
      paths: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    },
    additionalProperties: false,
  });
  readonly permission = gitWritePermission;

  async describeAction(argsValue: JsonValue): Promise<ToolActionDetails> {
    const args = inputObject(this.name, argsValue);
    const paths = stringArrayInput(this.name, args, 'paths');
    return {
      paths: {
        root: this.workspace.root,
        read: [],
        write: await Promise.all(paths.map((path) => this.workspace.resolveWrite(path))),
      },
    };
  }

  async execute(request: ToolExecutionRequest, signal: AbortSignal): Promise<ToolExecutionResult> {
    const args = inputObject(this.name, request.args);
    const message = stringInput(this.name, args, 'message');
    const paths = stringArrayInput(this.name, args, 'paths');
    for (const path of paths) {
      await this.workspace.resolveExisting(path);
    }
    const add = await this.git(['add', '--', ...paths], signal);
    if (add.exitCode !== 0) {
      return { outcome: 'failed', result: { phase: 'add', ...add } };
    }
    const commit = await this.git(['commit', '-m', message], signal);
    return commit.exitCode === 0
      ? succeeded({ phase: 'commit', ...commit })
      : { outcome: 'failed', result: { phase: 'commit', ...commit } };
  }
}

export interface WorktreeIsolationRequest {
  readonly branch: string;
  readonly path: string;
}

export interface WorktreeIsolation {
  create(
    request: WorktreeIsolationRequest,
    signal: AbortSignal,
  ): Promise<{ readonly path: string }>;
  remove(path: string, signal: AbortSignal): Promise<void>;
}
