import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  describeToolAction,
  PolicyFilePermissionStrategy,
  type PermissionStrategyInput,
  type Tool,
} from '@openagentcore/kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ExactReplaceTool, ReadFileTool } from './files.js';
import { RunCommandTool } from './process.js';
import { RepositoryBoundaryError, RepositoryWorkspace } from './workspace.js';

const signal = new AbortController().signal;
const context = {
  signal,
  tenantId: 'tenant-permission',
  sessionId: 'session-permission',
  turnId: 'turn-permission',
  stepId: 'step-permission',
} as const;

describe('coding permission action descriptors', () => {
  let root: string;
  let outside: string;
  let workspace: RepositoryWorkspace;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'oac-coding-permission-'));
    outside = await mkdtemp(join(tmpdir(), 'oac-coding-outside-'));
    await mkdir(join(root, 'src'));
    await mkdir(join(root, '.github', 'workflows'), { recursive: true });
    await writeFile(join(root, 'src', 'index.ts'), 'export {}\n', 'utf8');
    await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'name: CI\n', 'utf8');
    await writeFile(join(outside, 'secret.txt'), 'secret\n', 'utf8');
    workspace = new RepositoryWorkspace(root);
  });

  afterEach(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });

  it('allows src reads, denies .github writes, allows npm test, and denies rm', async () => {
    const policy = new PolicyFilePermissionStrategy();
    await policy.init(
      {
        defaultDecision: 'deny',
        rules: [
          { decision: 'deny', path: '.github/**', pathAccess: 'write' },
          { decision: 'allow', path: 'src/**', pathAccess: 'read' },
          { decision: 'deny', executable: 'rm' },
          { decision: 'allow', command: 'npm test' },
        ],
      },
      {},
    );

    await expect(
      decide(policy, new ReadFileTool(workspace), { path: 'src/index.ts' }),
    ).resolves.toBe('allow');
    await expect(
      decide(policy, new ExactReplaceTool(workspace), {
        path: '.github/workflows/ci.yml',
        oldText: 'CI',
        newText: 'checks',
      }),
    ).resolves.toBe('deny');
    const command = new RunCommandTool(workspace);
    await expect(decide(policy, command, { command: 'npm test' })).resolves.toBe('allow');
    await expect(decide(policy, command, { command: 'rm README.md' })).resolves.toBe('deny');
  });

  it('uses ordered first-match rules', async () => {
    const policy = new PolicyFilePermissionStrategy();
    await policy.init(
      {
        defaultDecision: 'deny',
        rules: [
          { decision: 'allow', command: 'npm *' },
          { decision: 'deny', executable: 'npm' },
        ],
      },
      {},
    );

    await expect(
      decide(policy, new RunCommandTool(workspace), { command: 'npm test' }),
    ).resolves.toBe('allow');
  });

  it('rejects traversal and symlink escapes before policy evaluation', async () => {
    const read = new ReadFileTool(workspace);
    await expect(
      describeToolAction(read, { path: '../outside.txt' }, signal),
    ).rejects.toBeInstanceOf(RepositoryBoundaryError);
    await symlink(join(outside, 'secret.txt'), join(root, 'src', 'linked-secret.txt'));
    await expect(
      describeToolAction(read, { path: 'src/linked-secret.txt' }, signal),
    ).rejects.toBeInstanceOf(RepositoryBoundaryError);
    await expect(
      describeToolAction(
        new ExactReplaceTool(workspace),
        { path: 'src/linked-secret.txt', oldText: 'secret', newText: 'changed' },
        signal,
      ),
    ).rejects.toBeInstanceOf(RepositoryBoundaryError);
  });
});

async function decide(
  policy: PolicyFilePermissionStrategy,
  tool: Tool,
  args: PermissionStrategyInput['args'],
): Promise<'allow' | 'deny'> {
  const action = await describeToolAction(tool, args, signal);
  const result = await policy.apply(
    { tool: tool.name, groups: [], permission: tool.permission, args, action },
    context,
  );
  return result.decision;
}
