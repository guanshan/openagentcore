import { spawnSync } from 'node:child_process';
import { access, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('./', import.meta.url));
const probePath = fileURLToPath(new URL('./format-self-test-probe.json', import.meta.url));

describe('Prettier configuration', () => {
  it('checks files discovered from the repository root', async () => {
    await writeFile(probePath, '{"probe":[1,2]}\n', { flag: 'wx' });

    try {
      const result = spawnSync('pnpm', ['format:check'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      });
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status, output).toBe(1);
      expect(output).toContain('format-self-test-probe.json');
    } finally {
      await unlink(probePath);
    }

    await expect(access(probePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
