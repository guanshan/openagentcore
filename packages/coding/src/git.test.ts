import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GitCommitTool, GitCreateBranchTool, GitDiffTool } from './git.js';
import { runProcess } from './process.js';
import { RepositoryWorkspace } from './workspace.js';

const signal = new AbortController().signal;

describe('coding Git tools', () => {
  let root: string;
  let workspace: RepositoryWorkspace;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'oac-coding-git-'));
    workspace = new RepositoryWorkspace(root);
    await git(['init', '-b', 'main'], root);
    await git(['config', 'user.name', 'OpenAgentCore Test'], root);
    await git(['config', 'user.email', 'test@openagentcore.dev'], root);
    await writeFile(join(root, 'value.txt'), 'before\n', 'utf8');
    await git(['add', 'value.txt'], root);
    await git(['commit', '-m', 'initial'], root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates a branch, reads the diff, and commits explicit paths', async () => {
    const branch = await new GitCreateBranchTool(workspace).execute(
      request({ branch: 'agent/fix-value' }),
      signal,
    );
    await writeFile(join(root, 'value.txt'), 'after\n', 'utf8');
    const diff = await new GitDiffTool(workspace).execute(request({}), signal);
    const commit = await new GitCommitTool(workspace).execute(
      request({ message: 'fix value', paths: ['value.txt'] }),
      signal,
    );
    const log = await git(['log', '-1', '--pretty=%s'], root);

    expect(branch.outcome).toBe('succeeded');
    expect(diff).toEqual({
      outcome: 'succeeded',
      result: expect.objectContaining({ stdout: expect.stringContaining('+after') }),
    });
    expect(commit.outcome).toBe('succeeded');
    expect(log.stdout.trim()).toBe('fix value');
  });
});

async function git(args: readonly string[], cwd: string) {
  const result = await runProcess({ command: 'git', args, cwd }, signal);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr);
  }
  return result;
}

function request(args: Record<string, string | readonly string[]>) {
  return { callId: 'call-git', args, attempt: 1 } as const;
}
