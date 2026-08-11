import { access, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('./', import.meta.url));
const probePath = fileURLToPath(
  new URL('./packages/kernel/src/boundary-self-test-probe.ts', import.meta.url),
);

describe('dependency-cruiser configuration', () => {
  it('rejects a bare workspace import from kernel', async () => {
    await writeFile(probePath, "import '@openagentcore/replay-demo';\n", { flag: 'wx' });

    try {
      const result = spawnSync('pnpm', ['lint:boundaries'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      });
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status, output).toBe(1);
      expect(output).toContain('kernel-does-not-import-workspace-specifiers');
      expect(output).toContain('@openagentcore/replay-demo');
    } finally {
      await unlink(probePath);
    }

    await expect(access(probePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
