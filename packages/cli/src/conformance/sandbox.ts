import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  negotiateSandboxCapabilities,
  SANDBOX_WORKSPACE_PATH,
  validateSandboxCapabilities,
  type SandboxPort,
} from '@openagentcore/kernel';

import type {
  ConformanceCaseResult,
  ConformanceSuiteResult,
  SandboxConformanceAdapter,
} from './types.js';

export async function runSandboxConformance(
  adapter: SandboxConformanceAdapter,
): Promise<ConformanceSuiteResult> {
  const root = await mkdtemp(join(tmpdir(), 'oac-sandbox-conformance-'));
  const sandbox = adapter.create(root);
  try {
    if (adapter.availability !== undefined) {
      const availability = await adapter.availability(sandbox, signal());
      if (!availability.available) {
        return skipped(adapter.name, sandbox, availability.reason);
      }
    }
    const cases: ConformanceCaseResult[] = [];
    await runCase(cases, 'capability declaration is honest', async () => {
      validateSandboxCapabilities(sandbox);
      if (!sandbox.capabilities.snapshot) {
        const negotiation = negotiateSandboxCapabilities(sandbox, { snapshot: true });
        if (!negotiation.downgrades.includes('sandbox-snapshot:requested->unavailable')) {
          throw new Error('missing snapshot downgrade');
        }
      } else {
        const snapshot = await sandbox.snapshot?.(signal());
        if (snapshot === undefined) {
          throw new Error('snapshot returned no identifier');
        }
        await sandbox.restore?.(snapshot, signal());
      }
    });
    await runCase(
      cases,
      'byte filesystem round-trips and canonicalizes workspace paths',
      async () => {
        await writeFile(join(root, 'seed.txt'), 'seed\n', 'utf8');
        await sandbox.fs.writeFile(
          `${SANDBOX_WORKSPACE_PATH}/roundtrip.bin`,
          new Uint8Array([0, 1, 2, 255]),
          signal(),
        );
        const content = await sandbox.fs.readFile(
          `${SANDBOX_WORKSPACE_PATH}/roundtrip.bin`,
          signal(),
        );
        if (!bytesEqual(content, new Uint8Array([0, 1, 2, 255]))) {
          throw new Error('binary content changed');
        }
        const canonical = await sandbox.fs.realpath(
          `${SANDBOX_WORKSPACE_PATH}/roundtrip.bin`,
          signal(),
        );
        if (canonical !== `${SANDBOX_WORKSPACE_PATH}/roundtrip.bin`) {
          throw new Error(`unexpected canonical path ${canonical}`);
        }
      },
    );
    await runCase(cases, 'exec runs the adapter probe', async () => {
      const probe = adapter.execProbe ?? {
        command: 'node',
        args: ['-e', "process.stdout.write('oac-sandbox-conformance')"],
        cwd: SANDBOX_WORKSPACE_PATH,
      };
      const result = await sandbox.exec(probe, signal());
      if (result.exitCode !== 0 || result.stdout !== 'oac-sandbox-conformance') {
        throw new Error(
          `probe failed with exit ${String(result.exitCode)}: ${result.stderr || result.stdout}`,
        );
      }
    });
    await runCase(
      cases,
      'pre-aborted exec and filesystem calls preserve cancellation',
      async () => {
        const reason = new Error('sandbox conformance cancellation');
        const controller = new AbortController();
        controller.abort(reason);
        await expectRejected(
          sandbox.exec(
            adapter.execProbe ?? { command: 'node', args: ['--version'] },
            controller.signal,
          ),
          reason,
        );
        await expectRejected(
          sandbox.fs.readFile(`${SANDBOX_WORKSPACE_PATH}/seed.txt`, controller.signal),
          reason,
        );
      },
    );

    return Object.freeze({
      port: 'sandbox',
      adapter: adapter.name,
      status: cases.some((entry) => entry.status === 'failed') ? 'failed' : 'passed',
      capabilities: Object.freeze({ ...sandbox.capabilities }),
      detail: summarizeCases(cases),
      cases: Object.freeze(cases),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function skipped(adapter: string, sandbox: SandboxPort, reason: string): ConformanceSuiteResult {
  return Object.freeze({
    port: 'sandbox',
    adapter,
    status: 'skipped',
    capabilities: Object.freeze({ ...sandbox.capabilities }),
    detail: reason,
    cases: Object.freeze([]),
  });
}

async function runCase(
  cases: ConformanceCaseResult[],
  name: string,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
    cases.push({ name, status: 'passed', detail: 'ok' });
  } catch (error) {
    cases.push({ name, status: 'failed', detail: stableError(error) });
  }
}

async function expectRejected(operation: Promise<unknown>, reason: unknown): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (error === reason) {
      return;
    }
    throw new Error(`cancellation changed to ${stableError(error)}`);
  }
  throw new Error('operation resolved after cancellation');
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function summarizeCases(cases: readonly ConformanceCaseResult[]): string {
  const failed = cases.filter((entry) => entry.status === 'failed').length;
  return failed === 0
    ? `${cases.length} cases passed.`
    : `${failed} of ${cases.length} cases failed.`;
}

function stableError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
