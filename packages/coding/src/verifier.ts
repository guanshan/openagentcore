import type { JsonObject } from '@openagentcore/kernel';

import { dangerousCommandRule, runProcess } from './process.js';
import type { RepositoryWorkspace } from './workspace.js';

export type VerificationOutcome = 'passed' | 'failed';

export interface VerificationResult extends JsonObject {
  readonly name: string;
  readonly outcome: VerificationOutcome;
  readonly command: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface Verifier {
  readonly name: string;
  verify(signal: AbortSignal): Promise<VerificationResult>;
}

export class CommandVerifier implements Verifier {
  readonly name: string;
  readonly #command: string;
  readonly #workspace: RepositoryWorkspace;
  readonly #now: () => number;

  constructor(options: {
    readonly name: string;
    readonly command: string;
    readonly workspace: RepositoryWorkspace;
    readonly now?: () => number;
  }) {
    this.name = options.name;
    this.#command = options.command;
    this.#workspace = options.workspace;
    this.#now = options.now ?? (() => Date.now());
  }

  async verify(signal: AbortSignal): Promise<VerificationResult> {
    const rule = dangerousCommandRule(this.#command);
    if (rule !== undefined) {
      throw new Error(`Verifier command blocked by safety rule: ${rule}.`);
    }
    const startedAt = this.#now();
    const result = await runProcess(
      { command: this.#command, cwd: this.#workspace.root, shell: true },
      signal,
    );
    return Object.freeze({
      name: this.name,
      outcome: result.exitCode === 0 ? 'passed' : 'failed',
      command: this.#command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Math.max(0, this.#now() - startedAt),
    });
  }
}

export async function runVerifiers(
  verifiers: readonly Verifier[],
  signal: AbortSignal,
): Promise<readonly VerificationResult[]> {
  const results: VerificationResult[] = [];
  for (const verifier of verifiers) {
    signal.throwIfAborted();
    results.push(await verifier.verify(signal));
  }
  return Object.freeze(results);
}
