import { ToolRegistry } from '@openagentcore/kernel';

import { ApplyPatchTool, ExactReplaceTool, GlobTool, GrepTool, ReadFileTool } from './files.js';
import { GitCommitTool, GitCreateBranchTool, GitDiffTool } from './git.js';
import { RunCommandTool } from './process.js';
import { RepositoryWorkspace } from './workspace.js';

export * from './contract.js';
export * from './files.js';
export * from './git.js';
export * from './process.js';
export * from './verifier.js';
export * from './workspace.js';

export interface CodingToolsetOptions {
  readonly root: string;
  readonly maxOutputBytes?: number;
}

export interface CodingToolset {
  readonly workspace: RepositoryWorkspace;
  readonly registry: ToolRegistry;
}

export function createCodingToolset(options: CodingToolsetOptions): CodingToolset {
  const workspace = new RepositoryWorkspace(options.root);
  const registry = new ToolRegistry()
    .register(new ReadFileTool(workspace), { groups: ['coding/read'] })
    .register(new GlobTool(workspace), { groups: ['coding/read'] })
    .register(new GrepTool(workspace), { groups: ['coding/read'] })
    .register(new ExactReplaceTool(workspace), { groups: ['coding/write'] })
    .register(new ApplyPatchTool(workspace), { groups: ['coding/write'] })
    .register(
      new RunCommandTool(
        workspace,
        options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes },
      ),
      { groups: ['coding/execute'] },
    )
    .register(new GitCreateBranchTool(workspace), { groups: ['coding/git'] })
    .register(new GitDiffTool(workspace), { groups: ['coding/git'] })
    .register(new GitCommitTool(workspace), { groups: ['coding/git'] });
  return Object.freeze({ workspace, registry });
}
