import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LocalProcessSandbox,
  negotiateSandboxCapabilities,
  SandboxBoundaryError,
  SandboxContractError,
  type SandboxPort,
} from './sandbox.js';

const signal = new AbortController().signal;

describe('LocalProcessSandbox', () => {
  let root: string;
  let outside: string;
  let sandbox: LocalProcessSandbox;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'oac-local-sandbox-'));
    outside = await mkdtemp(join(tmpdir(), 'oac-local-sandbox-outside-'));
    await writeFile(join(root, 'input.txt'), 'before\n', 'utf8');
    await writeFile(join(outside, 'secret.txt'), 'secret\n', 'utf8');
    sandbox = new LocalProcessSandbox({ root });
  });

  afterEach(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });

  it('executes commands and exposes byte-native filesystem operations', async () => {
    const result = await sandbox.exec(
      {
        command: 'node',
        args: ['-e', "process.stdout.write(require('node:fs').readFileSync('input.txt', 'utf8'))"],
        cwd: '/workspace',
      },
      signal,
    );
    await sandbox.fs.writeFile(
      '/workspace/output.txt',
      new TextEncoder().encode('after\n'),
      signal,
    );

    expect(result).toMatchObject({ exitCode: 0, stdout: 'before\n', outputTruncated: false });
    await expect(sandbox.fs.readFile('/workspace/output.txt', signal)).resolves.toEqual(
      new TextEncoder().encode('after\n'),
    );
    await expect(sandbox.fs.realpath('/workspace/output.txt', signal)).resolves.toBe(
      '/workspace/output.txt',
    );
  });

  it('rejects traversal and symlink escapes in the portable namespace', async () => {
    await expect(sandbox.fs.readFile('/workspace/../secret.txt', signal)).rejects.toBeInstanceOf(
      SandboxBoundaryError,
    );
    await symlink(join(outside, 'secret.txt'), join(root, 'linked-secret.txt'));
    await expect(
      sandbox.fs.readFile('/workspace/linked-secret.txt', signal),
    ).rejects.toBeInstanceOf(SandboxBoundaryError);
  });

  it('honors pre-aborted operations', async () => {
    const reason = new Error('cancel sandbox');
    const controller = new AbortController();
    controller.abort(reason);

    await expect(
      sandbox.exec({ command: 'node', args: ['--version'] }, controller.signal),
    ).rejects.toBe(reason);
    await expect(sandbox.fs.readFile('/workspace/input.txt', controller.signal)).rejects.toBe(
      reason,
    );
  });
});

describe('sandbox capability negotiation', () => {
  it('records an explicit downgrade when snapshots are requested but unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oac-local-sandbox-capability-'));
    try {
      const sandbox = new LocalProcessSandbox({ root });
      expect(negotiateSandboxCapabilities(sandbox, { snapshot: true })).toEqual({
        capabilities: { snapshot: false },
        downgrades: ['sandbox-snapshot:requested->unavailable'],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a dishonest snapshot capability declaration', () => {
    const dishonest = {
      capabilities: { snapshot: true },
      workspacePath: '/workspace',
      fs: {},
      exec: async () => {
        throw new Error('not implemented');
      },
    } as unknown as SandboxPort;

    expect(() => negotiateSandboxCapabilities(dishonest, { snapshot: true })).toThrow(
      SandboxContractError,
    );
  });
});
