import { inspect } from 'node:util';

import {
  CredentialExpiredError,
  CredentialReleasedError,
  CredentialScopeError,
} from '@openagentcore/kernel';

import type {
  ConformanceCaseResult,
  ConformanceSuiteResult,
  VaultConformanceAdapter,
} from './types.js';

export async function runVaultConformance(
  adapter: VaultConformanceAdapter,
  material: string,
): Promise<ConformanceSuiteResult> {
  const cases: ConformanceCaseResult[] = [];
  const fixture = await adapter.create(material);
  try {
    await runCase(
      cases,
      'credential is opaque and carries finite refresh metadata',
      material,
      async () => {
        const credential = await fixture.vault.issue(fixture.primaryScope);
        const expiresAt = Date.parse(credential.expiresAt);
        const refreshAfter = Date.parse(credential.refreshAfter);
        if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(refreshAfter)) {
          throw new Error('credential timestamps are invalid');
        }
        if (refreshAfter > expiresAt) throw new Error('refreshAfter exceeds expiresAt');
        const reflected = inspect(credential, { showHidden: true, depth: 12 });
        if (reflected.includes(material) || JSON.stringify(credential).includes(material)) {
          throw new Error('credential proxy exposed backing material');
        }
      },
    );

    await runCase(cases, 'scope A cannot authorize scope B', material, async () => {
      const credential = await fixture.vault.issue(fixture.primaryScope);
      await expectRejected(
        credential.request(fixture.otherRequest, signal()),
        CredentialScopeError,
      );
      await credential.request(fixture.primaryRequest, signal());
      if (!fixture.authenticated()) throw new Error('allowed request was not authenticated');
    });

    await runCase(
      cases,
      'expired credentials fail closed and refresh invalidates the old proxy',
      material,
      async () => {
        const credential = await fixture.vault.issue(fixture.primaryScope);
        fixture.advanceClock(86_400_000);
        await expectRejected(
          credential.request(fixture.primaryRequest, signal()),
          CredentialExpiredError,
        );
        const refreshed = await credential.refresh(signal());
        await expectRejected(credential.refresh(signal()), CredentialReleasedError);
        await refreshed.request(fixture.primaryRequest, signal());
      },
    );

    return Object.freeze({
      port: 'vault',
      adapter: adapter.name,
      status: cases.some((entry) => entry.status === 'failed') ? 'failed' : 'passed',
      capabilities: Object.freeze({ shortLived: true, scoped: true, opaqueProxy: true }),
      detail: summarizeCases(cases),
      cases: Object.freeze(cases),
    });
  } finally {
    await fixture.vault.close?.();
    await adapter.dispose?.();
  }
}

async function runCase(
  cases: ConformanceCaseResult[],
  name: string,
  material: string,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
    cases.push({ name, status: 'passed', detail: 'ok' });
  } catch (error) {
    cases.push({ name, status: 'failed', detail: redact(stableError(error), material) });
  }
}

async function expectRejected(
  operation: Promise<unknown>,
  errorType: new (...args: never[]) => Error,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof errorType) return;
    throw new Error(`expected ${errorType.name}, received ${stableError(error)}`);
  }
  throw new Error(`expected ${errorType.name}, operation resolved`);
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

function redact(value: string, material: string): string {
  return material.length === 0 ? value : value.replaceAll(material, '[REDACTED]');
}
