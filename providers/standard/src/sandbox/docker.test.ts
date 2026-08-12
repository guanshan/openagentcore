import type { SandboxExecRequest, SandboxExecResult, SandboxPort } from '@openagentcore/kernel';
import { describe, expect, it } from 'vitest';

import { DockerSandbox } from './docker.js';

const signal = new AbortController().signal;

describe('DockerSandbox', () => {
  it('maps the portable request to a Docker CLI invocation without provider branches in callers', async () => {
    const runner = new RecordingRunner([
      result({ stdout: '24.0.0\n' }),
      result({ stdout: '[{}]\n' }),
      result({ stdout: 'passed\n' }),
    ]);
    const sandbox = new DockerSandbox({
      root: process.cwd(),
      image: 'oac-test:local',
      runner,
    });

    await expect(sandbox.availability(signal)).resolves.toEqual({
      available: true,
      reason: 'Docker Engine 24.0.0 with local image oac-test:local.',
    });
    await expect(
      sandbox.exec(
        {
          command: 'npm test',
          cwd: '/workspace/src',
          shell: true,
          environment: { CI: '1' },
        },
        signal,
      ),
    ).resolves.toMatchObject({ command: 'npm test', stdout: 'passed\n', exitCode: 0 });

    expect(runner.requests[2]).toEqual({
      command: 'docker',
      args: [
        'run',
        '--rm',
        '--network',
        'none',
        '--volume',
        `${process.cwd()}:/workspace`,
        '--workdir',
        '/workspace/src',
        '--env',
        'CI=1',
        'oac-test:local',
        'sh',
        '-lc',
        'npm test',
      ],
      cwd: '/workspace',
    });
  });

  it('reports unavailable Docker and missing local images explicitly', async () => {
    const engineDown = new DockerSandbox({
      root: process.cwd(),
      runner: new RecordingRunner([result({ exitCode: 1, stderr: 'daemon unavailable' })]),
    });
    await expect(engineDown.availability(signal)).resolves.toEqual({
      available: false,
      reason: 'Docker Engine unavailable: daemon unavailable',
    });

    const imageMissing = new DockerSandbox({
      root: process.cwd(),
      image: 'missing:local',
      runner: new RecordingRunner([result({ stdout: '24\n' }), result({ exitCode: 1 })]),
    });
    await expect(imageMissing.availability(signal)).resolves.toEqual({
      available: false,
      reason:
        'Docker image missing:local is not installed; conformance never pulls from the network.',
    });
  });
});

class RecordingRunner implements SandboxPort {
  readonly capabilities = { snapshot: false } as const;
  readonly workspacePath = '/workspace' as const;
  readonly fs = {} as SandboxPort['fs'];
  readonly requests: SandboxExecRequest[] = [];
  readonly #results: SandboxExecResult[];

  constructor(results: readonly SandboxExecResult[]) {
    this.#results = [...results];
  }

  async exec(request: SandboxExecRequest): Promise<SandboxExecResult> {
    this.requests.push(structuredClone(request));
    const next = this.#results.shift();
    if (next === undefined) {
      throw new Error('No scripted Docker runner result.');
    }
    return next;
  }
}

function result(overrides: Partial<SandboxExecResult> = {}): SandboxExecResult {
  return {
    command: 'docker',
    stdout: '',
    stderr: '',
    exitCode: 0,
    signal: null,
    outputTruncated: false,
    ...overrides,
  };
}
