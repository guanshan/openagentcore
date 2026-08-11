import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PolicyFilePermissionStrategy } from '@openagentcore/kernel';

import { RunCommandTool } from './process.js';
import { RepositoryWorkspace } from './workspace.js';

const signal = new AbortController().signal;

describe('RunCommandTool', () => {
  let root: string;
  let tool: RunCommandTool;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'oac-coding-process-'));
    tool = new RunCommandTool(new RepositoryWorkspace(root));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('maps a non-zero exit code to a failed result instead of throwing', async () => {
    const result = await tool.execute(
      {
        callId: 'call-command',
        attempt: 1,
        args: {
          command:
            "node -e \"process.stdout.write('out'); process.stderr.write('err'); process.exit(7)\"",
        },
      },
      signal,
    );

    expect(result).toEqual({
      outcome: 'failed',
      result: expect.objectContaining({ exitCode: 7, stdout: 'out', stderr: 'err' }),
    });
  });

  it('blocks a dangerous command before creating a process', async () => {
    const result = await tool.execute(
      { callId: 'call-danger', attempt: 1, args: { command: 'rm -rf ./important' } },
      signal,
    );

    expect(result).toEqual({
      outcome: 'failed',
      result: expect.objectContaining({
        error: 'dangerous-command',
        rule: 'recursive-force-delete',
      }),
    });
  });

  it('is governed directly by the kernel policy-file permission strategy', async () => {
    expect(tool.permission).toEqual(
      expect.objectContaining({ kind: 'process-execute', description: expect.any(String) }),
    );
    const permission = new PolicyFilePermissionStrategy();
    await permission.init(
      {
        defaultDecision: 'allow',
        rules: [{ decision: 'deny', permissionKind: 'process-execute' }],
      },
      {},
    );

    await expect(
      permission.apply(
        {
          tool: tool.name,
          groups: ['coding/execute'],
          permission: tool.permission,
          args: { command: 'node --version' },
        },
        {
          signal,
          tenantId: 'tenant-test',
          sessionId: 'session-test',
          turnId: 'turn-test',
          stepId: 'step-test',
        },
      ),
    ).resolves.toEqual({ decision: 'deny', reason: 'policy-rule' });
  });
});
