import { SandboxBoundaryError, type SandboxPort } from '@openagentcore/kernel';
import { describe, expect, it } from 'vitest';

import {
  TencentAgentRuntimeSandbox,
  type TencentSandboxClient,
  type TencentSandboxClientFactory,
} from './agent-runtime.js';

describe('TencentAgentRuntimeSandbox', () => {
  it('keeps workspace ACLs and degrades snapshot capability honestly', async () => {
    const client = new MemoryTencentClient();
    const sandbox = new TencentAgentRuntimeSandbox({
      clientFactory: fixedFactory(client),
      maxOutputBytes: 5,
    });
    const signal = new AbortController().signal;

    expect(sandbox.capabilities).toEqual({ snapshot: false });
    expect((sandbox as SandboxPort).snapshot).toBeUndefined();
    await sandbox.fs.writeFile('/workspace/note.bin', new Uint8Array([1, 2, 3]), signal);
    expect(await sandbox.fs.readFile('/workspace/note.bin', signal)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    await expect(sandbox.fs.readFile('/outside/note.bin', signal)).rejects.toBeInstanceOf(
      SandboxBoundaryError,
    );

    const result = await sandbox.exec({ command: 'emit' }, signal);
    expect(result.outputTruncated).toBe(true);
    expect(new TextEncoder().encode(result.stdout + result.stderr).byteLength).toBeLessThanOrEqual(
      5,
    );

    await sandbox.close();
    expect(client.closed).toBe(true);
  });
});

function fixedFactory(client: TencentSandboxClient): TencentSandboxClientFactory {
  return { create: async () => client };
}

class MemoryTencentClient implements TencentSandboxClient {
  readonly #files = new Map<string, Uint8Array>();
  readonly #directories = new Set(['/workspace']);
  closed = false;

  async makeDir(path: string): Promise<void> {
    this.#directories.add(path);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const content = this.#files.get(path);
    if (content === undefined) throw new Error('missing file');
    return new Uint8Array(content);
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    this.#files.set(path, new Uint8Array(content));
  }

  async run(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (command.startsWith('realpath -- ')) {
      const path = parseQuotedArgument(command);
      return this.#directories.has(path) || this.#files.has(path)
        ? { stdout: `${path}\n`, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'missing', exitCode: 1 };
    }
    return { stdout: 'abcdef', stderr: 'gh', exitCode: 0 };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function parseQuotedArgument(command: string): string {
  const start = command.indexOf("'");
  const end = command.lastIndexOf("'");
  return command.slice(start + 1, end);
}
