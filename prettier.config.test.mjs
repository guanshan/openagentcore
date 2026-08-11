import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('./', import.meta.url));
const packageJsonPath = fileURLToPath(new URL('./package.json', import.meta.url));
const prettierIgnorePath = fileURLToPath(new URL('./.prettierignore', import.meta.url));

describe('Prettier configuration', () => {
  it('checks files discovered from the repository root', async () => {
    const repositoryPackage = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    const prettierIgnore = await readFile(prettierIgnorePath, 'utf8');
    const formatCheck = repositoryPackage.scripts?.['format:check'];
    expect(formatCheck).toBe('prettier --check .');

    const temporaryRoot = await mkdtemp(join(tmpdir(), 'openagentcore-prettier-'));
    const probePath = join(temporaryRoot, 'format-self-test-probe.json');
    await writeFile(
      join(temporaryRoot, 'package.json'),
      `${JSON.stringify({ private: true, scripts: { 'format:check': formatCheck } }, null, 2)}\n`,
    );
    await writeFile(join(temporaryRoot, '.prettierignore'), prettierIgnore);
    await writeFile(probePath, '{"probe":[1,2]}\n', { flag: 'wx' });

    try {
      const result = spawnSync('pnpm', ['format:check'], {
        cwd: temporaryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${join(repositoryRoot, 'node_modules/.bin')}${delimiter}${process.env.PATH ?? ''}`,
        },
      });
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status, output).toBe(1);
      expect(output).toContain('format-self-test-probe.json');
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }

    await expect(access(probePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
