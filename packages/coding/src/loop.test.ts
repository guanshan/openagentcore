import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AgentLoop,
  AgentLoopCrashError,
  InMemoryEventLog,
  ScriptedModelPort,
  ToolRegistry,
  type ModelChunk,
  type ModelPort,
  type EventLog,
  type Tool,
  type ToolExecutionRequest,
  type ToolExecutionResult,
} from '@openagentcore/kernel';
import { SqliteStore } from '@openagentcore/standard';
import { RecordingModelPort, ReplayModelPort } from '@openagentcore/standard/model';
import { afterEach, describe, expect, it } from 'vitest';

import { createCodingToolset } from './index.js';
import { inputObject } from './contract.js';
import { runProcess } from './process.js';

const timestamp = '2026-08-11T00:00:00Z';
const task = 'Fix add(), verify the change, and commit it.';
const gitEnvironment = Object.freeze({
  GIT_AUTHOR_DATE: timestamp,
  GIT_COMMITTER_DATE: timestamp,
});
const signal = new AbortController().signal;

describe('recorded coding loop', () => {
  const fixtures: string[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('replays a real fixture-repository loop and resumes after interruption during verification', async () => {
    const recordingRoot = await createFixtureRepository(fixtures);
    const recorder = new RecordingModelPort(new ScriptedModelPort(codingScript()));
    const recorded = await createLoop(recordingRoot, recorder).runTurn({ content: task });
    const recording = recorder.snapshot();

    expect(recorded.stopReason).toBe('completed');
    await expectRepositoryCompleted(recordingRoot);

    const replayRoot = await createFixtureRepository(fixtures);
    const replay = new ReplayModelPort(recording);
    const normalTools = createCodingToolset({ root: replayRoot, gitEnvironment });
    const crashingTools = replaceTool(
      normalTools.registry,
      new CrashAfterFirstVerification(normalTools.registry.require('coding.run-command')),
    );
    const log = new InMemoryEventLog({
      tenantId: 'tenant-coding',
      sessionId: 'session-coding-recovery',
    });
    const crashing = createLoop(replayRoot, replay, { eventLog: log, tools: crashingTools });

    await expect(crashing.runTurn({ content: task })).rejects.toBeInstanceOf(AgentLoopCrashError);
    expect(await git(['status', '--porcelain'], replayRoot)).toContain('src/add.mjs');

    const resumed = createLoop(replayRoot, replay, { eventLog: log, tools: crashingTools });
    const result = await resumed.resumeTurn();

    expect(result.stopReason).toBe('completed');
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'tool.result',
        callId: 'call-verify-failed',
        outcome: 'failed',
        attempts: 2,
      }),
    );
    expect(
      result.events.filter(
        (event) => event.type === 'tool.call' && event.callId === 'call-verify-failed',
      ),
    ).toHaveLength(1);
    replay.assertExhausted();
    await expectRepositoryCompleted(replayRoot);
  }, 15_000);

  it('reopens SQLite and resumes the coding loop after the worker process really exits', async () => {
    const repositoryRoot = await createFixtureRepository(fixtures);
    const durableRoot = await mkdtemp(join(tmpdir(), 'oac-coding-durable-'));
    fixtures.push(durableRoot);
    const databasePath = join(durableRoot, 'coding.sqlite');
    const scriptPath = join(durableRoot, 'model-script.json');
    await writeFile(scriptPath, `${JSON.stringify(codingScript())}\n`, 'utf8');

    const workerPath = fileURLToPath(new URL('./sqlite-crash-worker.test.ts', import.meta.url));
    const worker = await runProcess(
      {
        command: 'pnpm',
        args: ['exec', 'vitest', 'run', workerPath],
        cwd: process.cwd(),
        environment: {
          OAC_SQLITE_CRASH_WORKER: '1',
          OAC_SQLITE_CRASH_DATABASE: databasePath,
          OAC_SQLITE_CRASH_REPOSITORY: repositoryRoot,
          OAC_SQLITE_CRASH_SCRIPT: scriptPath,
        },
        maxOutputBytes: 1_000_000,
      },
      signal,
    );
    expect(worker.exitCode, worker.stderr || worker.stdout).toBe(0);
    expect(await git(['status', '--porcelain'], repositoryRoot)).toContain('src/add.mjs');

    const store = new SqliteStore({ filename: databasePath });
    try {
      const resumed = createLoop(repositoryRoot, new ScriptedModelPort(processRecoveryScript()), {
        eventLog: store.eventLog.open({
          tenantId: 'tenant-coding',
          sessionId: 'session-coding-process-recovery',
        }),
      });
      const result = await resumed.resumeTurn();

      expect(result.stopReason).toBe('completed');
      expect(result.events).toContainEqual(
        expect.objectContaining({
          type: 'tool.result',
          callId: 'call-verify-failed',
          outcome: 'failed',
          attempts: 2,
        }),
      );
      expect(
        result.events.filter(
          (event) => event.type === 'tool.call' && event.callId === 'call-verify-failed',
        ),
      ).toHaveLength(1);
    } finally {
      await store.close();
    }
    await expectRepositoryCompleted(repositoryRoot);
  }, 30_000);
});

function codingScript(): readonly (readonly ModelChunk[])[] {
  return [
    [toolCall('call-branch', 'coding.git-create-branch', { branch: 'agent/fix-add' })],
    [toolCall('call-read', 'coding.read-file', { path: 'src/add.mjs' })],
    [
      toolCall('call-edit-wrong', 'coding.replace', {
        path: 'src/add.mjs',
        oldText: 'return a - b;',
        newText: 'return a * b;',
      }),
    ],
    [
      toolCall('call-verify-failed', 'coding.run-command', {
        command: 'node verify.mjs',
      }),
    ],
    [
      toolCall('call-edit-correct', 'coding.replace', {
        path: 'src/add.mjs',
        oldText: 'return a * b;',
        newText: 'return a + b;',
      }),
    ],
    [
      toolCall('call-verify-passed', 'coding.run-command', {
        command: 'node verify.mjs',
      }),
    ],
    [toolCall('call-diff', 'coding.git-diff', {})],
    [
      toolCall('call-commit', 'coding.git-commit', {
        message: 'fix add implementation',
        paths: ['src/add.mjs'],
      }),
    ],
    [
      { kind: 'text', text: 'The implementation is fixed, verified, and committed.' },
      { kind: 'finish', reason: 'stop' },
    ],
  ];
}

function processRecoveryScript(): readonly (readonly ModelChunk[])[] {
  return [
    [toolCall('call-read-after-restart', 'coding.read-file', { path: 'src/add.mjs' })],
    [
      toolCall('call-edit-correct', 'coding.replace', {
        path: 'src/add.mjs',
        oldText: 'return a * b;',
        newText: 'return a + b;',
      }),
    ],
    [
      toolCall('call-verify-passed', 'coding.run-command', {
        command: 'node verify.mjs',
      }),
    ],
    [toolCall('call-diff', 'coding.git-diff', {})],
    [
      toolCall('call-commit', 'coding.git-commit', {
        message: 'fix add implementation',
        paths: ['src/add.mjs'],
      }),
    ],
    [
      { kind: 'text', text: 'The implementation is fixed, verified, and committed.' },
      { kind: 'finish', reason: 'stop' },
    ],
  ];
}

function toolCall(callId: string, tool: string, args: ToolExecutionRequest['args']): ModelChunk {
  return { kind: 'tool-call', callId, tool, args };
}

function createLoop(
  root: string,
  model: ModelPort,
  overrides: { readonly eventLog?: EventLog; readonly tools?: ToolRegistry } = {},
): AgentLoop {
  const toolset = createCodingToolset({ root, gitEnvironment });
  return new AgentLoop({
    eventLog:
      overrides.eventLog ??
      new InMemoryEventLog({ tenantId: 'tenant-coding', sessionId: 'session-coding-recording' }),
    model,
    tools: overrides.tools ?? toolset.registry,
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
    now: () => timestamp,
    sleep: async (_delayMs, sleepSignal) => sleepSignal.throwIfAborted(),
  });
}

class CrashAfterFirstVerification implements Tool {
  readonly name: string;
  readonly inputSchema: Tool['inputSchema'];
  readonly permission: Tool['permission'];
  readonly #inner: Tool;
  #crash = true;

  constructor(inner: Tool) {
    this.#inner = inner;
    this.name = inner.name;
    this.inputSchema = inner.inputSchema;
    this.permission = inner.permission;
  }

  async execute(
    request: ToolExecutionRequest,
    executeSignal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const result = await this.#inner.execute(request, executeSignal);
    const command = inputObject(this.name, request.args)['command'];
    if (this.#crash && command === 'node verify.mjs') {
      this.#crash = false;
      throw new AgentLoopCrashError('process lost after verification completed');
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

async function createFixtureRepository(fixtures: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'oac-coding-loop-'));
  fixtures.push(root);
  await runGit(['init', '-b', 'main'], root);
  await runGit(['config', 'user.name', 'OpenAgentCore Test'], root);
  await runGit(['config', 'user.email', 'test@openagentcore.dev'], root);
  await writeFile(
    join(root, 'package.json'),
    '{"name":"coding-loop-fixture","private":true,"type":"module"}\n',
    'utf8',
  );
  await writeFile(
    join(root, 'verify.mjs'),
    [
      "import { add } from './src/add.mjs';",
      'const actual = add(2, 3);',
      'if (actual !== 5) {',
      '  process.stderr.write(`expected 5, received ${actual}\\n`);',
      '  process.exit(1);',
      '}',
      "process.stdout.write('verification passed\\n');",
      '',
    ].join('\n'),
    'utf8',
  );
  const sourceDirectory = join(root, 'src');
  await mkdir(sourceDirectory);
  await writeFile(
    join(sourceDirectory, 'add.mjs'),
    'export function add(a, b) {\n  return a - b;\n}\n',
    'utf8',
  );
  await runGit(['add', '--', 'package.json', 'verify.mjs', 'src/add.mjs'], root);
  await runGit(['commit', '-m', 'initial fixture'], root);
  return root;
}

async function expectRepositoryCompleted(root: string): Promise<void> {
  await expect(readFile(join(root, 'src/add.mjs'), 'utf8')).resolves.toContain('return a + b;');
  await expect(git(['status', '--porcelain'], root)).resolves.toBe('');
  await expect(git(['log', '-1', '--pretty=%s'], root)).resolves.toBe('fix add implementation\n');
  await expect(git(['branch', '--show-current'], root)).resolves.toBe('agent/fix-add\n');
}

async function runGit(args: readonly string[], cwd: string): Promise<void> {
  const result = await runProcess(
    { command: 'git', args, cwd, environment: gitEnvironment },
    signal,
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr);
  }
}

async function git(args: readonly string[], cwd: string): Promise<string> {
  const result = await runProcess(
    { command: 'git', args, cwd, environment: gitEnvironment },
    signal,
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout;
}
