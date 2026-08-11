import { spawnSync } from 'node:child_process';
import { access, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { dependencyCruiserBaseExcludePath } from './dependency-cruiser.config.mjs';

const repositoryRoot = fileURLToPath(new URL('./', import.meta.url));
const packageJsonPath = fileURLToPath(new URL('./package.json', import.meta.url));
const probeRelativePath = 'packages/kernel/src/boundary-self-test-probe.ts';
const probePath = fileURLToPath(new URL(`./${probeRelativePath}`, import.meta.url));
const probeLockPath = join(tmpdir(), 'openagentcore-boundary-self-test.lock');

describe('dependency-cruiser configuration', () => {
  it('rejects a bare workspace import from kernel', async () => {
    const repositoryPackage = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    expect(repositoryPackage.scripts?.['lint:boundaries']).toBe(
      'depcruise --config dependency-cruiser.config.mjs packages/kernel examples providers',
    );

    const releaseProbeLock = await acquireProbeLock();

    try {
      await rm(probePath, { force: true });
      await writeFile(
        probePath,
        "// eslint-disable-next-line no-restricted-imports -- Intentional dependency-cruiser violation.\nimport '@openagentcore/replay-demo';\n",
        { flag: 'wx' },
      );

      const result = spawnSync(
        'pnpm',
        [
          'exec',
          'depcruise',
          '--config',
          'dependency-cruiser.config.mjs',
          '--exclude',
          dependencyCruiserBaseExcludePath,
          probeRelativePath,
        ],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
        },
      );
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status, output).toBe(1);
      expect(output).toContain('kernel-does-not-import-workspace-specifiers');
      expect(output).toContain('@openagentcore/replay-demo');
    } finally {
      await rm(probePath, { force: true });
      await releaseProbeLock();
    }

    await expect(access(probePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function acquireProbeLock() {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      const handle = await open(probeLockPath, 'wx');
      await handle.writeFile(`${process.pid}\n`);
      return async () => {
        await handle.close();
        await rm(probeLockPath, { force: true });
      };
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) {
        throw error;
      }
      if (await lockOwnerIsAlive()) {
        await delay(25);
      } else {
        await rm(probeLockPath, { force: true });
      }
    }
  }

  throw new Error(`Timed out waiting for boundary self-test lock: ${probeLockPath}`);
}

async function lockOwnerIsAlive() {
  let owner;
  try {
    owner = Number.parseInt(await readFile(probeLockPath, 'utf8'), 10);
  } catch (error) {
    return !hasErrorCode(error, 'ENOENT');
  }
  if (!Number.isInteger(owner) || owner <= 0) {
    return false;
  }

  try {
    process.kill(owner, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, 'EPERM');
  }
}

function hasErrorCode(error, code) {
  return typeof error === 'object' && error !== null && error.code === code;
}
