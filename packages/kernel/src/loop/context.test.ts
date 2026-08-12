import { describe, expect, it } from 'vitest';

import { InMemoryEventLog } from '../events/event-log.js';
import { ScriptedModelPort } from '../ports/model.js';
import type { SandboxCapabilityRequest, SandboxPort } from '../ports/sandbox.js';
import { createDefaultPromptRegistry } from '../prompts/builtins.js';
import { EchoTool, ResultFailingTool, ToolRegistry } from '../tools/tool.js';
import { AgentLoop, PROMPTED_TOOL_CALL_PREFIX } from './agent-loop.js';
import type { MiddlewareExecutionMode } from './middleware.js';

const timestamp = '2026-08-11T00:00:00Z';

describe('AgentLoop context assembly', () => {
  it('reports the ordered pipeline, final messages, prompt provenance, tokens, and downgrades', async () => {
    const model = new ScriptedModelPort([], {
      capabilities: { toolUse: 'prompted' },
    });
    const prompts = createDefaultPromptRegistry().append(
      'system.identity',
      'Runtime identity extension.',
      'runtime-identity-v1',
    );
    const loop = createLoop(model, {
      prompts,
      tools: new ToolRegistry().register(new EchoTool()),
    });

    const result = await loop.dryRunContext({ content: 'Inspect this context.' });

    expect(result.assembly.stages.map((stage) => stage.stage)).toEqual([
      'history',
      'memory',
      'skills',
      'compaction',
      'slots',
      'context-middleware',
      'model-middleware',
    ]);
    expect(result.assembly.messages).toContainEqual({
      role: 'user',
      content: 'Inspect this context.',
    });
    expect(result.assembly.capabilityDowngrades).toEqual(['tool-use:native->prompted']);
    expect(result.assembly.totalTokens).toEqual(expect.any(Number));
    expect(result.assembly.segments).not.toHaveLength(0);
    expect(
      result.assembly.segments.every((segment) => typeof segment.tokenCount === 'number'),
    ).toBe(true);
    expect(result.assembly.stages.every((stage) => typeof stage.tokenCount === 'number')).toBe(
      true,
    );

    for (const message of result.assembly.messages) {
      expect(result.report).toContain(message.content);
    }
    expect(result.report).toContain('Capability downgrades: tool-use:native->prompted');
    expect(result.report).toContain('Total tokens:');
    expect(result.report).toContain(
      'system.identity from builtin/@openagentcore/kernel@1.1.0 (replace, prompt 1.0.0)',
    );
    expect(result.report).toContain(
      'system.identity from runtime/runtime@runtime-identity-v1 (append, prompt runtime-identity-v1)',
    );
  });

  it('keeps dry-run read-only and produces the same middleware-shaped messages as execution', async () => {
    const model = new ScriptedModelPort([
      [
        { kind: 'text', text: 'Context accepted.' },
        { kind: 'finish', reason: 'stop' },
      ],
    ]);
    const log = new InMemoryEventLog(identity('read-only'));
    const loop = createLoop(model, { eventLog: log });
    const contextModes: MiddlewareExecutionMode[] = [];
    const modelModes: MiddlewareExecutionMode[] = [];
    loop.use('context', async (context, next) => {
      contextModes.push(context.mode);
      context.messages.push({ role: 'system', content: 'Context middleware addition.' });
      await next();
    });
    loop.use('model', async (context, next) => {
      modelModes.push(context.mode);
      context.request = {
        ...context.request,
        messages: [
          ...context.request.messages,
          { role: 'system', content: 'Model middleware addition.' },
        ],
      };
      await next();
    });

    const dryRun = await loop.dryRunContext({ content: 'Use deterministic middleware.' });

    await expect(readEvents(log)).resolves.toEqual([]);
    expect(model.requests).toEqual([]);
    expect(contextModes).toEqual(['dry-run']);
    expect(modelModes).toEqual(['dry-run']);

    const turn = await loop.runTurn({ content: 'Use deterministic middleware.' });

    expect(turn.stopReason).toBe('completed');
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.messages).toEqual(dryRun.assembly.messages);
    expect(contextModes).toEqual(['dry-run', 'execute']);
    expect(modelModes).toEqual(['dry-run', 'execute']);
  });

  it('persists an honest sandbox capability downgrade in the model request event', async () => {
    const model = new ScriptedModelPort([
      [
        { kind: 'text', text: 'No snapshot required.' },
        { kind: 'finish', reason: 'stop' },
      ],
    ]);
    const log = new InMemoryEventLog(identity('sandbox-downgrade'));
    const sandbox = {
      capabilities: { snapshot: false },
      workspacePath: '/workspace',
      fs: {},
      exec: async () => {
        throw new Error('not used');
      },
    } as unknown as SandboxPort;
    const loop = createLoop(model, {
      eventLog: log,
      sandbox,
      sandboxCapabilities: { snapshot: true },
    });

    await loop.runTurn({ content: 'Continue without snapshots.' });

    expect(await readEvents(log)).toContainEqual(
      expect.objectContaining({
        type: 'model.request',
        capabilityDowngrades: ['sandbox-snapshot:requested->unavailable'],
      }),
    );
  });

  it('uses runtime overrides for the prompted protocol and failed-tool retry hint', async () => {
    const promptedInstruction = 'CUSTOM_PROMPTED_PROTOCOL';
    const retryInstruction = 'CUSTOM_FAILED_TOOL_RETRY_HINT';
    const prompts = createDefaultPromptRegistry()
      .replace('tool.protocol.prompted', promptedInstruction, 'prompted-v2')
      .replace('error.retry-hint', retryInstruction, 'retry-v2');
    const promptedCall = `${PROMPTED_TOOL_CALL_PREFIX}${JSON.stringify({
      callId: 'call-failed-result',
      tool: 'result-failing',
      args: { command: 'test' },
    })}`;
    const model = new ScriptedModelPort(
      [
        [
          { kind: 'text', text: promptedCall },
          { kind: 'finish', reason: 'tool-calls' },
        ],
        [
          { kind: 'text', text: 'Adjusted after failure.' },
          { kind: 'finish', reason: 'stop' },
        ],
      ],
      { capabilities: { toolUse: 'prompted' } },
    );
    const loop = createLoop(model, {
      prompts,
      tools: new ToolRegistry().register(new ResultFailingTool()),
    });

    const result = await loop.runTurn({ content: 'Run the failing operation.' });

    expect(result.stopReason).toBe('completed');
    const firstSystemPrompt = model.requests[0]?.messages[0]?.content;
    const secondSystemPrompt = model.requests[1]?.messages[0]?.content;
    expect(firstSystemPrompt).toContain(promptedInstruction);
    expect(firstSystemPrompt).not.toContain(retryInstruction);
    expect(firstSystemPrompt).not.toContain('emits one complete tool call');
    expect(secondSystemPrompt).toContain(promptedInstruction);
    expect(secondSystemPrompt).toContain(retryInstruction);
  });
});

interface LoopOptions {
  readonly eventLog?: InMemoryEventLog;
  readonly prompts?: ReturnType<typeof createDefaultPromptRegistry>;
  readonly tools?: ToolRegistry;
  readonly sandbox?: SandboxPort;
  readonly sandboxCapabilities?: SandboxCapabilityRequest;
}

function createLoop(model: ScriptedModelPort, options: LoopOptions = {}): AgentLoop {
  return new AgentLoop({
    eventLog: options.eventLog ?? new InMemoryEventLog(identity('context')),
    model,
    ...(options.prompts === undefined ? {} : { prompts: options.prompts }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
    ...(options.sandboxCapabilities === undefined
      ? {}
      : { sandboxCapabilities: options.sandboxCapabilities }),
    now: () => timestamp,
    sleep: async (_delayMs, signal) => signal.throwIfAborted(),
  });
}

function identity(suffix: string) {
  return {
    tenantId: 'tenant-test',
    sessionId: `session-${suffix}`,
  } as const;
}

async function readEvents(log: InMemoryEventLog) {
  const events = [];
  for await (const event of log.read(0)) {
    events.push(event);
  }
  return events;
}
