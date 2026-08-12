import { readFile } from 'node:fs/promises';

import {
  AgentLoop,
  AgentLoopCrashError,
  ScriptedModelPort,
  ToolRegistry,
  type ModelChunk,
  type Tool,
  type ToolExecutionRequest,
  type ToolExecutionResult,
} from '@openagentcore/kernel';
import { SqliteStore } from '@openagentcore/standard';
import { describe, expect, it } from 'vitest';

import { inputObject } from './contract.js';
import { createCodingToolset } from './index.js';

const isWorker = process.env['OAC_SQLITE_CRASH_WORKER'] === '1';

describe.skipIf(!isWorker)('SQLite crash worker', () => {
  it('persists the incomplete tool call and terminates after a real side effect', async () => {
    const databasePath = requiredEnvironment('OAC_SQLITE_CRASH_DATABASE');
    const repositoryRoot = requiredEnvironment('OAC_SQLITE_CRASH_REPOSITORY');
    const scriptPath = requiredEnvironment('OAC_SQLITE_CRASH_SCRIPT');
    const script = JSON.parse(
      await readFile(scriptPath, 'utf8'),
    ) as readonly (readonly ModelChunk[])[];
    const store = new SqliteStore({ filename: databasePath });
    try {
      const toolset = createCodingToolset({
        root: repositoryRoot,
        gitEnvironment: {
          GIT_AUTHOR_DATE: '2026-08-11T00:00:00Z',
          GIT_COMMITTER_DATE: '2026-08-11T00:00:00Z',
        },
      });
      const command = toolset.registry.require('coding.run-command');
      const tools = replaceTool(toolset.registry, new CrashAfterVerification(command));
      const loop = new AgentLoop({
        eventLog: store.eventLog.open({
          tenantId: 'tenant-coding',
          sessionId: 'session-coding-process-recovery',
        }),
        model: new ScriptedModelPort(script),
        tools,
        strategies: {
          stop: { use: 'max-steps', config: { maxSteps: 12 } },
          permission: {
            use: 'policy-file',
            config: {
              defaultDecision: 'deny',
              rules: [
                { decision: 'allow', group: 'coding/read' },
                { decision: 'allow', group: 'coding/write' },
                { decision: 'allow', group: 'coding/execute' },
                { decision: 'allow', group: 'coding/git' },
              ],
            },
          },
          retry: {
            use: 'exponential-backoff',
            config: { maxAttempts: 2, initialDelayMs: 0 },
          },
        },
        now: () => '2026-08-11T00:00:00Z',
        sleep: async (_delayMs, signal) => signal.throwIfAborted(),
      });

      await expect(
        loop.runTurn({ content: 'Fix add(), verify the change, and commit it.' }),
      ).rejects.toBeInstanceOf(AgentLoopCrashError);
    } finally {
      await store.close();
    }
  });
});

class CrashAfterVerification implements Tool {
  readonly name: string;
  readonly inputSchema: Tool['inputSchema'];
  readonly permission: Tool['permission'];
  readonly #inner: Tool;

  constructor(inner: Tool) {
    this.#inner = inner;
    this.name = inner.name;
    this.inputSchema = inner.inputSchema;
    this.permission = inner.permission;
  }

  async describeAction(args: ToolExecutionRequest['args'], signal: AbortSignal) {
    const describe = this.#inner.describeAction;
    if (describe === undefined) throw new Error(`${this.name} has no action descriptor.`);
    return describe.call(this.#inner, args, signal);
  }

  async execute(request: ToolExecutionRequest, signal: AbortSignal): Promise<ToolExecutionResult> {
    const result = await this.#inner.execute(request, signal);
    const command = inputObject(this.name, request.args)['command'];
    if (command === 'node verify.mjs') {
      throw new AgentLoopCrashError('worker process lost after verification completed');
    }
    return result;
  }
}

function replaceTool(registry: ToolRegistry, replacement: Tool): ToolRegistry {
  const replaced = new ToolRegistry();
  for (const tool of registry.list()) {
    replaced.register(tool.name === replacement.name ? replacement : tool, {
      groups: registry.groupsFor(tool.name),
    });
  }
  return replaced;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}
