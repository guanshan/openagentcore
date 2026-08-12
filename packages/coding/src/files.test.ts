import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApplyPatchTool, ExactReplaceTool, GlobTool, GrepTool, ReadFileTool } from './files.js';
import { RepositoryBoundaryError, RepositoryWorkspace } from './workspace.js';

const signal = new AbortController().signal;

describe('coding file tools', () => {
  let root: string;
  let workspace: RepositoryWorkspace;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'oac-coding-files-'));
    workspace = new RepositoryWorkspace(root);
    await writeFile(join(root, 'example.txt'), 'one\ntwo\n', 'utf8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('rejects an edit when the file changed after reading and reports the conflict position', async () => {
    const read = new ReadFileTool(workspace);
    const replace = new ExactReplaceTool(workspace);
    await read.execute(request({ path: 'example.txt' }), signal);
    await writeFile(join(root, 'example.txt'), 'one\nchanged\n', 'utf8');

    const result = await replace.execute(
      request({ path: 'example.txt', oldText: 'two', newText: 'three' }),
      signal,
    );

    expect(result).toEqual({
      outcome: 'failed',
      result: expect.objectContaining({
        error: 'conflict',
        path: 'example.txt',
        line: 2,
        column: 1,
      }),
    });
  });

  it('applies exact replacement and unified patch against the latest read snapshot', async () => {
    await new ReadFileTool(workspace).execute(request({ path: 'example.txt' }), signal);
    const replaced = await new ExactReplaceTool(workspace).execute(
      request({ path: 'example.txt', oldText: 'one', newText: 'first' }),
      signal,
    );
    const patched = await new ApplyPatchTool(workspace).execute(
      request({
        path: 'example.txt',
        patch: '@@ -1,2 +1,2 @@\n first\n-two\n+second',
      }),
      signal,
    );
    const final = await workspace.read('example.txt');

    expect(replaced.outcome).toBe('succeeded');
    expect(patched.outcome).toBe('succeeded');
    expect(final.content).toBe('first\nsecond\n');
  });

  it('globs and greps repository files without traversing .git', async () => {
    await writeFile(join(root, 'match.ts'), 'const marker = "needle";\n', 'utf8');
    const glob = await new GlobTool(workspace).execute(request({ pattern: '**/*.ts' }), signal);
    const grep = await new GrepTool(workspace).execute(
      request({ pattern: 'needle', glob: '**/*.ts' }),
      signal,
    );

    expect(glob).toEqual({ outcome: 'succeeded', result: { paths: ['match.ts'] } });
    expect(await new GlobTool(workspace).execute(request({ pattern: '*.ts' }), signal)).toEqual({
      outcome: 'succeeded',
      result: { paths: ['match.ts'] },
    });
    expect(grep).toEqual({
      outcome: 'succeeded',
      result: { matches: [{ path: 'match.ts', line: 1, text: 'const marker = "needle";' }] },
    });
  });

  it('rejects writes outside the repository boundary', async () => {
    await expect(workspace.resolveWrite('../outside.txt')).rejects.toBeInstanceOf(
      RepositoryBoundaryError,
    );
  });
});

function request(args: Record<string, string>) {
  return { callId: 'call-file', args, attempt: 1 } as const;
}
