import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, posix, relative, resolve } from 'node:path';

import { SANDBOX_WORKSPACE_PATH } from '@openagentcore/kernel';

export interface FileSnapshot {
  readonly path: string;
  readonly content: string;
  readonly revision: string;
}

export class RepositoryBoundaryError extends Error {
  constructor(path: string) {
    super(`Path is outside the repository boundary: ${path}.`);
    this.name = 'RepositoryBoundaryError';
  }
}

export class RepositoryConflictError extends Error {
  readonly path: string;
  readonly line: number;
  readonly column: number;

  constructor(path: string, line: number, column: number) {
    super(`File changed after it was read: ${path} at line ${line}, column ${column}.`);
    this.name = 'RepositoryConflictError';
    this.path = path;
    this.line = line;
    this.column = column;
  }
}

export class RepositoryWorkspace {
  readonly root: string;
  readonly #snapshots = new Map<string, FileSnapshot>();

  constructor(root: string) {
    this.root = realpathSync(resolve(root));
  }

  async read(path: string): Promise<FileSnapshot> {
    const absolute = await this.resolveExisting(path);
    const content = await readFile(absolute, 'utf8');
    const snapshot = freezeSnapshot(this.root, absolute, content);
    this.#snapshots.set(absolute, snapshot);
    return snapshot;
  }

  async edit(path: string, transform: (content: string) => string): Promise<FileSnapshot> {
    const absolute = await this.resolveExisting(path);
    const expected = this.#snapshots.get(absolute);
    if (expected === undefined) {
      throw new RepositoryConflictError(relative(this.root, absolute), 1, 1);
    }
    const current = await readFile(absolute, 'utf8');
    if (revision(current) !== expected.revision) {
      const conflict = firstDifference(expected.content, current);
      throw new RepositoryConflictError(
        relative(this.root, absolute),
        conflict.line,
        conflict.column,
      );
    }
    const next = transform(current);
    await writeFile(absolute, next, 'utf8');
    const snapshot = freezeSnapshot(this.root, absolute, next);
    this.#snapshots.set(absolute, snapshot);
    return snapshot;
  }

  async resolveExisting(path: string): Promise<string> {
    const candidate = isAbsolute(path) ? resolve(path) : resolve(this.root, path);
    this.assertInside(candidate, path);
    const canonical = await realpath(candidate);
    this.assertInside(canonical, path);
    return canonical;
  }

  async resolveWrite(path: string): Promise<string> {
    const candidate = isAbsolute(path) ? resolve(path) : resolve(this.root, path);
    this.assertInside(candidate, path);
    try {
      const canonical = await realpath(candidate);
      this.assertInside(canonical, path);
      return canonical;
    } catch (error) {
      if (!isMissingPath(error)) {
        throw error;
      }
    }
    const canonicalParent = await realpath(dirname(candidate));
    this.assertInside(canonicalParent, path);
    return resolve(canonicalParent, basename(candidate));
  }

  async sandboxPath(path: string): Promise<string> {
    const absolute = await this.resolveExisting(path);
    const suffix = relative(this.root, absolute).replaceAll('\\', '/');
    return suffix.length === 0
      ? SANDBOX_WORKSPACE_PATH
      : posix.join(SANDBOX_WORKSPACE_PATH, suffix);
  }

  #assertRelative(path: string): boolean {
    const fromRoot = relative(this.root, path);
    return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
  }

  private assertInside(path: string, requested: string): void {
    if (!this.#assertRelative(path)) {
      throw new RepositoryBoundaryError(requested);
    }
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}

function freezeSnapshot(root: string, absolute: string, content: string): FileSnapshot {
  return Object.freeze({
    path: relative(root, absolute),
    content,
    revision: revision(content),
  });
}

function revision(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function firstDifference(
  expected: string,
  actual: string,
): { readonly line: number; readonly column: number } {
  const limit = Math.min(expected.length, actual.length);
  let index = 0;
  while (index < limit && expected[index] === actual[index]) {
    index += 1;
  }
  const prefix = expected.slice(0, index);
  const lines = prefix.split('\n');
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}
