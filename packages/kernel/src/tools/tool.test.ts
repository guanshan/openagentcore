import { describe, expect, it } from 'vitest';

import {
  EchoTool,
  FailingTool,
  ResultFailingTool,
  SlowTool,
  ToolRegistry,
  ToolRegistryError,
  type Tool,
} from './tool.js';

const signal = new AbortController().signal;

describe('ToolRegistry', () => {
  it('registers, resolves, lists, and groups tools', () => {
    const echo = new EchoTool();
    const failing = new FailingTool();
    const registry = new ToolRegistry()
      .register(echo, { groups: ['core', 'safe'] })
      .register(failing, { groups: ['core'] });

    expect(registry.get('echo')).toBe(echo);
    expect(registry.require('failing')).toBe(failing);
    expect(registry.list()).toEqual([echo, failing]);
    expect(registry.list('core')).toEqual([echo, failing]);
    expect(registry.list('safe')).toEqual([echo]);
    expect(registry.list('missing')).toEqual([]);
    expect(registry.groups()).toEqual(['core', 'safe']);
    expect(registry.groupsFor('echo')).toEqual(['core', 'safe']);
    expect(registry.groupsFor('failing')).toEqual(['core']);
  });

  it('rejects duplicate names, missing lookups, and empty group names', () => {
    const registry = new ToolRegistry().register(new EchoTool());

    expect(() => registry.register(new EchoTool())).toThrow(ToolRegistryError);
    expect(() => registry.require('missing')).toThrow(ToolRegistryError);
    expect(() => new ToolRegistry().register(new EchoTool(), { groups: [''] })).toThrow(
      ToolRegistryError,
    );
  });

  it('allows an external Tool implementation without registry changes', async () => {
    const custom: Tool = {
      name: 'custom',
      inputSchema: { type: 'string' },
      permission: { kind: 'read' },
      async execute(request, executionSignal) {
        executionSignal.throwIfAborted();
        return {
          outcome: 'succeeded',
          result: { callId: request.callId, attempt: request.attempt },
        };
      },
    };
    const registry = new ToolRegistry().register(custom, { groups: ['external'] });

    await expect(
      registry.require('custom').execute({ callId: 'call-custom', args: null, attempt: 2 }, signal),
    ).resolves.toEqual({
      outcome: 'succeeded',
      result: { callId: 'call-custom', attempt: 2 },
    });
  });
});

describe('scripted tools', () => {
  it('echoes JSON arguments and records callId and attempt as recovery inputs', async () => {
    const tool = new EchoTool();
    const request = { callId: 'stable-call-id', args: { text: 'hello' }, attempt: 3 } as const;

    await expect(tool.execute(request, signal)).resolves.toEqual({
      outcome: 'succeeded',
      result: request.args,
    });
    expect(tool.requests).toEqual([request]);
  });

  it('fails with the configured error after recording the request', async () => {
    const error = new Error('expected failure');
    const tool = new FailingTool(error);
    const request = { callId: 'call-fail', args: null, attempt: 1 } as const;

    await expect(tool.execute(request, signal)).rejects.toBe(error);
    expect(tool.requests).toEqual([request]);
  });

  it('reports a completed failed result without throwing', async () => {
    const result = { exitCode: 1, stderr: 'tests failed' } as const;
    const tool = new ResultFailingTool(result);
    const request = { callId: 'call-result-fail', args: null, attempt: 1 } as const;

    await expect(tool.execute(request, signal)).resolves.toEqual({
      outcome: 'failed',
      result,
    });
    expect(tool.requests).toEqual([request]);
  });

  it('checks AbortSignal before execution and while a slow tool is pending', async () => {
    const beforeStart = new AbortController();
    const beforeStartReason = new Error('cancelled before tool');
    beforeStart.abort(beforeStartReason);
    const echo = new EchoTool();

    await expect(
      echo.execute({ callId: 'call-1', args: null, attempt: 1 }, beforeStart.signal),
    ).rejects.toBe(beforeStartReason);
    expect(echo.requests).toEqual([]);

    const duringExecution = new AbortController();
    const duringExecutionReason = new Error('cancelled slow tool');
    const slow = new SlowTool(10_000);
    const execution = slow.execute(
      { callId: 'call-2', args: { value: true }, attempt: 1 },
      duringExecution.signal,
    );
    duringExecution.abort(duringExecutionReason);

    await expect(execution).rejects.toBe(duringExecutionReason);
    expect(slow.requests).toHaveLength(1);
  });
});
