import {
  LocalProcessSandbox,
  ScriptedModelPort,
  type ModelPort,
  type SandboxPort,
} from '@openagentcore/kernel';
import { describe, expect, it } from 'vitest';

import { runModelConformance } from './model.js';
import { createConformanceReport, formatCapabilityMatrix, formatHumanReport } from './report.js';
import { runSandboxConformance } from './sandbox.js';

describe('Port conformance suites', () => {
  it('passes honest model and local sandbox adapters', async () => {
    const model = await runModelConformance({
      name: 'honest-model',
      create: () =>
        new ScriptedModelPort([
          [
            { kind: 'text', text: 'ok' },
            { kind: 'finish', reason: 'stop' },
          ],
        ]),
    });
    const sandbox = await runSandboxConformance({
      name: 'honest-sandbox',
      create: (root) => new LocalProcessSandbox({ root }),
    });

    expect(model.status).toBe('passed');
    expect(sandbox.status).toBe('passed');
  });

  it('marks a deliberately dishonest model adapter red', async () => {
    const dishonest: ModelPort = {
      capabilities: {
        streaming: true,
        toolUse: 'none',
        promptCaching: false,
        structuredOutput: false,
        maxContext: 1,
        vision: false,
      },
      countTokens: async () => 1,
      stream: async function* () {
        throw new Error('streaming is not actually supported');
      },
    };

    const result = await runModelConformance({ name: 'dishonest-model', create: () => dishonest });

    expect(result.status).toBe('failed');
    expect(result.cases).toContainEqual(
      expect.objectContaining({
        name: 'declared stream mode produces exactly one terminal finish',
        status: 'failed',
      }),
    );
  });

  it('marks a dishonest snapshot declaration red and keeps unavailable adapters skipped', async () => {
    const dishonest = await runSandboxConformance({
      name: 'dishonest-sandbox',
      create: (root) => {
        const local = new LocalProcessSandbox({ root });
        return {
          ...local,
          capabilities: { snapshot: true },
          workspacePath: local.workspacePath,
          fs: local.fs,
          exec: (request, signal) => local.exec(request, signal),
        } as SandboxPort;
      },
    });
    const unavailable = await runSandboxConformance({
      name: 'optional-sandbox',
      create: (root) => new LocalProcessSandbox({ root }),
      availability: async () => ({ available: false, reason: 'optional daemon missing' }),
    });

    expect(dishonest.status).toBe('failed');
    expect(unavailable).toMatchObject({ status: 'skipped', detail: 'optional daemon missing' });
  });

  it('formats human, JSON-backed matrix, and overall failure consistently', () => {
    const report = createConformanceReport([
      {
        port: 'sandbox',
        adapter: 'optional',
        status: 'skipped',
        capabilities: { snapshot: false },
        detail: 'not installed',
        cases: [],
      },
      {
        port: 'model',
        adapter: 'broken',
        status: 'failed',
        capabilities: { streaming: true },
        detail: '1 of 1 cases failed.',
        cases: [{ name: 'stream', status: 'failed', detail: 'broken' }],
      },
    ]);

    expect(report.status).toBe('failed');
    expect(formatHumanReport(report)).toContain('sandbox/optional: SKIPPED - not installed');
    expect(formatCapabilityMatrix(report)).toContain('| sandbox | optional | skipped |');
  });
});
