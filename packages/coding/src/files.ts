import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type {
  JsonObject,
  Tool,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolPermissionDescriptor,
} from '@openagentcore/kernel';

import { failed, inputObject, optionalStringInput, stringInput, succeeded } from './contract.js';
import { RepositoryConflictError } from './workspace.js';
import type { RepositoryWorkspace } from './workspace.js';

const readPermission: ToolPermissionDescriptor = Object.freeze({
  kind: 'filesystem-read',
  description: 'Reads repository files without modifying them.',
});

const writePermission: ToolPermissionDescriptor = Object.freeze({
  kind: 'filesystem-write',
  description: 'Writes a repository file after optimistic conflict detection.',
});

const pathSchema: JsonObject = Object.freeze({
  type: 'object',
  required: ['path'],
  properties: { path: { type: 'string', minLength: 1 } },
  additionalProperties: false,
});

abstract class WorkspaceTool implements Tool {
  abstract readonly name: string;
  abstract readonly inputSchema: JsonObject;
  abstract readonly permission: ToolPermissionDescriptor;
  protected readonly workspace: RepositoryWorkspace;

  constructor(workspace: RepositoryWorkspace) {
    this.workspace = workspace;
  }

  abstract execute(
    request: ToolExecutionRequest,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult>;
}

export class ReadFileTool extends WorkspaceTool {
  readonly name = 'coding.read-file';
  readonly inputSchema = pathSchema;
  readonly permission = readPermission;

  async execute(request: ToolExecutionRequest, signal: AbortSignal): Promise<ToolExecutionResult> {
    signal.throwIfAborted();
    const args = inputObject(this.name, request.args);
    const snapshot = await this.workspace.read(stringInput(this.name, args, 'path'));
    signal.throwIfAborted();
    return succeeded({
      path: snapshot.path,
      content: snapshot.content,
      revision: snapshot.revision,
    });
  }
}

export class ExactReplaceTool extends WorkspaceTool {
  readonly name = 'coding.replace';
  readonly inputSchema: JsonObject = Object.freeze({
    type: 'object',
    required: ['path', 'oldText', 'newText'],
    properties: {
      path: { type: 'string', minLength: 1 },
      oldText: { type: 'string', minLength: 1 },
      newText: { type: 'string' },
    },
    additionalProperties: false,
  });
  readonly permission = writePermission;

  async execute(request: ToolExecutionRequest, signal: AbortSignal): Promise<ToolExecutionResult> {
    signal.throwIfAborted();
    const args = inputObject(this.name, request.args);
    const path = stringInput(this.name, args, 'path');
    const oldText = stringInput(this.name, args, 'oldText');
    const newText = stringInput(this.name, args, 'newText', { allowEmpty: true });
    try {
      const snapshot = await this.workspace.edit(path, (content) => {
        const first = content.indexOf(oldText);
        const second = first < 0 ? -1 : content.indexOf(oldText, first + oldText.length);
        if (first < 0 || second >= 0) {
          throw new ExactReplaceError(path, first < 0 ? 0 : 2);
        }
        return `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
      });
      signal.throwIfAborted();
      return succeeded({ path: snapshot.path, revision: snapshot.revision });
    } catch (error) {
      return predictableEditFailure(error);
    }
  }
}

export class ApplyPatchTool extends WorkspaceTool {
  readonly name = 'coding.apply-patch';
  readonly inputSchema: JsonObject = Object.freeze({
    type: 'object',
    required: ['path', 'patch'],
    properties: {
      path: { type: 'string', minLength: 1 },
      patch: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  });
  readonly permission = writePermission;

  async execute(request: ToolExecutionRequest, signal: AbortSignal): Promise<ToolExecutionResult> {
    signal.throwIfAborted();
    const args = inputObject(this.name, request.args);
    const path = stringInput(this.name, args, 'path');
    const patch = stringInput(this.name, args, 'patch');
    try {
      const snapshot = await this.workspace.edit(path, (content) =>
        applyUnifiedPatch(path, content, patch),
      );
      signal.throwIfAborted();
      return succeeded({ path: snapshot.path, revision: snapshot.revision });
    } catch (error) {
      return predictableEditFailure(error);
    }
  }
}

export class GlobTool extends WorkspaceTool {
  readonly name = 'coding.glob';
  readonly inputSchema: JsonObject = Object.freeze({
    type: 'object',
    required: ['pattern'],
    properties: { pattern: { type: 'string', minLength: 1 } },
    additionalProperties: false,
  });
  readonly permission = readPermission;

  async execute(request: ToolExecutionRequest, signal: AbortSignal): Promise<ToolExecutionResult> {
    signal.throwIfAborted();
    const args = inputObject(this.name, request.args);
    const pattern = stringInput(this.name, args, 'pattern');
    const paths = await repositoryFiles(this.workspace.root, signal);
    const matcher = globMatcher(pattern);
    return succeeded({ paths: paths.filter((path) => matcher.test(path)) });
  }
}

export class GrepTool extends WorkspaceTool {
  readonly name = 'coding.grep';
  readonly inputSchema: JsonObject = Object.freeze({
    type: 'object',
    required: ['pattern'],
    properties: {
      pattern: { type: 'string', minLength: 1 },
      glob: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  });
  readonly permission = readPermission;

  async execute(request: ToolExecutionRequest, signal: AbortSignal): Promise<ToolExecutionResult> {
    signal.throwIfAborted();
    const args = inputObject(this.name, request.args);
    const pattern = stringInput(this.name, args, 'pattern');
    const glob = optionalStringInput(this.name, args, 'glob') ?? '**/*';
    const matcher = globMatcher(glob);
    const matches: JsonObject[] = [];
    for (const path of (await repositoryFiles(this.workspace.root, signal)).filter((candidate) =>
      matcher.test(candidate),
    )) {
      signal.throwIfAborted();
      const content = await readFile(join(this.workspace.root, path), 'utf8').catch(
        () => undefined,
      );
      if (content === undefined) {
        continue;
      }
      content.split('\n').forEach((line, index) => {
        if (line.includes(pattern)) {
          matches.push({ path, line: index + 1, text: line });
        }
      });
    }
    return succeeded({ matches });
  }
}

class ExactReplaceError extends Error {
  readonly path: string;
  readonly occurrences: number;

  constructor(path: string, occurrences: number) {
    super(
      `Expected exactly one match in ${path}; found ${occurrences === 2 ? 'multiple' : 'none'}.`,
    );
    this.name = 'ExactReplaceError';
    this.path = path;
    this.occurrences = occurrences;
  }
}

class PatchConflictError extends Error {
  readonly path: string;
  readonly line: number;

  constructor(path: string, line: number, detail: string) {
    super(`Patch conflict in ${path} at line ${line}: ${detail}.`);
    this.name = 'PatchConflictError';
    this.path = path;
    this.line = line;
  }
}

function predictableEditFailure(error: unknown): ToolExecutionResult {
  if (error instanceof RepositoryConflictError) {
    return failed({
      error: 'conflict',
      message: error.message,
      path: error.path,
      line: error.line,
      column: error.column,
    });
  }
  if (error instanceof ExactReplaceError) {
    return failed({ error: 'match-count', message: error.message, path: error.path });
  }
  if (error instanceof PatchConflictError) {
    return failed({
      error: 'patch-conflict',
      message: error.message,
      path: error.path,
      line: error.line,
    });
  }
  throw error;
}

function applyUnifiedPatch(path: string, content: string, patch: string): string {
  const source = content.split('\n');
  const patchLines = patch.split('\n');
  const output: string[] = [];
  let sourceIndex = 0;
  let patchIndex = patchLines.findIndex((line) => line.startsWith('@@ '));
  if (patchIndex < 0) {
    throw new PatchConflictError(path, 1, 'missing unified diff hunk header');
  }

  while (patchIndex < patchLines.length) {
    const header = patchLines[patchIndex];
    if (header === undefined || !header.startsWith('@@ ')) {
      patchIndex += 1;
      continue;
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
    if (match === null) {
      throw new PatchConflictError(path, sourceIndex + 1, 'invalid hunk header');
    }
    const oldStart = Number(match[1]) - 1;
    if (oldStart < sourceIndex || oldStart > source.length) {
      throw new PatchConflictError(path, oldStart + 1, 'hunk starts outside the remaining file');
    }
    output.push(...source.slice(sourceIndex, oldStart));
    sourceIndex = oldStart;
    patchIndex += 1;

    while (patchIndex < patchLines.length && !patchLines[patchIndex]?.startsWith('@@ ')) {
      const line = patchLines[patchIndex];
      patchIndex += 1;
      if (line === undefined || (line === '' && patchIndex === patchLines.length)) {
        continue;
      }
      const marker = line[0];
      const value = line.slice(1);
      if (marker === ' ') {
        if (source[sourceIndex] !== value) {
          throw new PatchConflictError(path, sourceIndex + 1, 'context does not match');
        }
        output.push(value);
        sourceIndex += 1;
      } else if (marker === '-') {
        if (source[sourceIndex] !== value) {
          throw new PatchConflictError(path, sourceIndex + 1, 'removed line does not match');
        }
        sourceIndex += 1;
      } else if (marker === '+') {
        output.push(value);
      } else if (line !== '\\ No newline at end of file') {
        throw new PatchConflictError(path, sourceIndex + 1, 'invalid hunk line');
      }
    }
  }
  output.push(...source.slice(sourceIndex));
  return output.join('\n');
}

async function repositoryFiles(root: string, signal: AbortSignal): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal.throwIfAborted();
      if (entry.name === '.git') {
        continue;
      }
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        files.push(relative(root, absolute).split(sep).join('/'));
      }
    }
  };
  await visit(root);
  return files.sort();
}

function globMatcher(pattern: string): RegExp {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const next = pattern[index + 1];
    if (character === '*' && next === '*' && pattern[index + 2] === '/') {
      expression += '(?:.*/)?';
      index += 2;
    } else if (character === '*' && next === '*') {
      expression += '.*';
      index += 1;
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') ?? '';
    }
  }
  return new RegExp(`${expression}$`);
}
