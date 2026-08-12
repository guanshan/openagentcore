import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalProcessSandbox, type SandboxPort } from '@openagentcore/kernel';
import { DockerSandbox } from '@openagentcore/standard';
import { afterEach, describe, expect, it } from 'vitest';

import { createCodingToolset } from './index.js';

const signal = new AbortController().signal;
const probe = new DockerSandbox({ root: process.cwd() });
const dockerAvailability = await probe.availability(signal);
if (!dockerAvailability.available) {
  console.warn(`[docker conformance skipped] ${dockerAvailability.reason}`);
}

runSandboxCodingCases('LocalProcessSandbox', (root) => new LocalProcessSandbox({ root }));

describe.skipIf(!dockerAvailability.available)('coding through DockerSandbox', () => {
  runSandboxCodingCases('DockerSandbox', (root) => new DockerSandbox({ root }));
});

function runSandboxCodingCases(name: string, createSandbox: (root: string) => SandboxPort): void {
  describe(`coding through ${name}`, () => {
    const fixtures: string[] = [];

    afterEach(async () => {
      await Promise.all(
        fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })),
      );
    });

    it('runs the same command tool contract without adapter-specific coding branches', async () => {
      const root = await mkdtemp(join(tmpdir(), 'oac-coding-sandbox-'));
      fixtures.push(root);
      const sandbox = createSandbox(root);
      const toolset = createCodingToolset({ root, sandbox });
      const command = toolset.registry.require('coding.run-command');

      const result = await command.execute(
        {
          callId: `call-${name}`,
          attempt: 1,
          args: { command: 'node -e "process.stdout.write(\'sandbox passed\')"' },
        },
        signal,
      );

      expect(toolset.sandbox).toBe(sandbox);
      expect(result).toEqual({
        outcome: 'succeeded',
        result: expect.objectContaining({ stdout: 'sandbox passed', exitCode: 0 }),
      });
    });
  });
}
