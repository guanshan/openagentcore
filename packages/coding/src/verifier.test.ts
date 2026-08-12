import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CommandVerifier, runVerifiers } from './verifier.js';
import { RepositoryWorkspace } from './workspace.js';

describe('Verifier', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'oac-coding-verifier-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('normalizes command failure for a programmable verification loop', async () => {
    const times = [10, 25];
    const verifier = new CommandVerifier({
      name: 'unit',
      command: 'node -e "process.exit(3)"',
      workspace: new RepositoryWorkspace(root),
      now: () => times.shift() ?? 25,
    });

    const results = await runVerifiers([verifier], new AbortController().signal);

    expect(results).toEqual([
      expect.objectContaining({
        name: 'unit',
        outcome: 'failed',
        exitCode: 3,
        durationMs: 15,
      }),
    ]);
  });
});
