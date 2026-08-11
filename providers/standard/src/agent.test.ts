import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

import { EchoTool, InMemoryEventLog, ScriptedModelPort, ToolRegistry } from '@openagentcore/kernel';

import { AgentBuilder, AgentConfigurationError, createAgent } from './agent.js';
import type { AgentConfigInput } from './agent.js';
import { OpenAICompatibleModel } from './model/openai-compatible.js';

describe('AgentBuilder', () => {
  it('provides the kernel defaults when a concrete model Port is supplied', () => {
    const model = new ScriptedModelPort([]);
    const typedBuilder = AgentBuilder.fromPreset('oss-local');
    if (Date.now() < 0) {
      // @ts-expect-error The explicit-code surface must reject misspelled keys.
      typedBuilder.configure({ model: { nmae: 'typo' } });
    }

    const agent = AgentBuilder.fromPreset('oss-local').model(model).build();

    expect(agent.model).toBe(model);
    expect(agent.eventLog).toBeInstanceOf(InMemoryEventLog);
    expect(agent.eventLog).toMatchObject({ tenantId: 'local', sessionId: 'default' });
    expect(agent.tools).toBeInstanceOf(ToolRegistry);
    expect(agent.tools.list()).toEqual([]);
    expect(agent.prompts.require('system.identity').content).toContain('OpenAgentCore');
  });

  it('requires a model name and maxContext when constructing the standard adapter', () => {
    const missingName = captureConfigurationError(() =>
      AgentBuilder.fromPreset('oss-local').build(),
    );
    expect(missingName).toMatchObject({ layer: 'preset', keyPath: 'model.name' });
    expect(missingName.message).toContain('key path "model.name"');

    const missingContext = captureConfigurationError(() =>
      AgentBuilder.fromPreset('oss-local')
        .configure({ model: { name: 'qwen3:8b' } })
        .build(),
    );
    expect(missingContext.keyPath).toBe('model.capabilities.maxContext');
  });

  it('recursively merges builtin, preset, file, environment, and explicit layers', () => {
    const agent = AgentBuilder.fromPreset('oss-local')
      .configFile({
        identity: { tenantId: 'file-tenant', sessionId: 'file-session' },
        model: {
          name: 'file-model',
          headers: { 'x-from-file': 'kept' },
          capabilities: { maxContext: 4_096, toolUse: 'native', vision: true },
        },
      })
      .environment({
        OAC_SESSION_ID: 'environment-session',
        OAC_MODEL_NAME: 'environment-model',
        OAC_MODEL_MAX_CONTEXT: '8192',
      })
      .configure({
        identity: { tenantId: 'explicit-tenant' },
        model: { capabilities: { maxContext: 16_384 } },
      })
      .build();

    expect(agent.eventLog).toMatchObject({
      tenantId: 'explicit-tenant',
      sessionId: 'environment-session',
    });
    expect(agent.model).toBeInstanceOf(OpenAICompatibleModel);
    expect(agent.model.capabilities).toEqual({
      streaming: true,
      toolUse: 'native',
      promptCaching: false,
      structuredOutput: false,
      maxContext: 16_384,
      vision: true,
    });
  });

  it('reports the originating layer and key path for invalid values', () => {
    const fileError = captureConfigurationError(() =>
      AgentBuilder.fromPreset('oss-local')
        .configFile({ model: { unsupported: true } })
        .model(new ScriptedModelPort([]))
        .build(),
    );
    expect(fileError).toMatchObject({ layer: 'config-file', keyPath: 'model.unsupported' });

    const environmentError = captureConfigurationError(() =>
      AgentBuilder.fromPreset('oss-local')
        .environment({ OAC_MODEL_MAX_CONTEXT: 'many' })
        .model(new ScriptedModelPort([]))
        .build(),
    );
    expect(environmentError).toMatchObject({
      layer: 'environment',
      keyPath: 'model.capabilities.maxContext',
    });

    const explicitError = captureConfigurationError(() =>
      AgentBuilder.fromPreset('oss-local')
        .configure({
          model: { capabilities: { toolUse: 'automatic' } },
        } as unknown as AgentConfigInput)
        .model(new ScriptedModelPort([]))
        .build(),
    );
    expect(explicitError).toMatchObject({
      layer: 'explicit-code',
      keyPath: 'model.capabilities.toolUse',
    });

    const streamingError = captureConfigurationError(() =>
      AgentBuilder.fromPreset('oss-local')
        .environment({
          OAC_MODEL_NAME: 'local-model',
          OAC_MODEL_MAX_CONTEXT: '4096',
          OAC_MODEL_STREAMING: 'false',
        })
        .build(),
    );
    expect(streamingError).toMatchObject({
      layer: 'environment',
      keyPath: 'model.capabilities.streaming',
    });

    const whitespaceNameError = captureConfigurationError(() =>
      AgentBuilder.fromPreset('oss-local')
        .configure({ model: { name: ' ', capabilities: { maxContext: 4_096 } } })
        .build(),
    );
    expect(whitespaceNameError).toMatchObject({
      layer: 'explicit-code',
      keyPath: 'model.name',
    });

    const queryUrlError = captureConfigurationError(() =>
      AgentBuilder.fromPreset('oss-local')
        .configFile({
          model: {
            baseUrl: 'http://127.0.0.1/v1?secret=query-secret',
            name: 'local-model',
            capabilities: { maxContext: 4_096 },
          },
        })
        .build(),
    );
    expect(queryUrlError).toMatchObject({
      layer: 'config-file',
      keyPath: 'model.baseUrl',
    });
    expect(queryUrlError.message).not.toContain('query-secret');

    const credentialUrlError = captureConfigurationError(() =>
      AgentBuilder.fromPreset('oss-local')
        .configure({
          model: {
            baseUrl: 'http://user:super-secret@127.0.0.1/v1',
            name: 'local-model',
            capabilities: { maxContext: 4_096 },
          },
        })
        .build(),
    );
    expect(credentialUrlError).toMatchObject({
      layer: 'explicit-code',
      keyPath: 'model.baseUrl',
    });
    expect(credentialUrlError.message).not.toContain('super-secret');

    const whitespaceApiKeyError = captureConfigurationError(() =>
      AgentBuilder.fromPreset('oss-local')
        .configure({
          model: {
            name: 'local-model',
            apiKey: ' ',
            capabilities: { maxContext: 4_096 },
          },
        })
        .build(),
    );
    expect(whitespaceApiKeyError).toMatchObject({
      layer: 'explicit-code',
      keyPath: 'model.apiKey',
    });
  });

  it('merges authorization case-insensitively and honors layer priority', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      const higherHeader = AgentBuilder.fromPreset('oss-local')
        .configFile({
          model: {
            name: 'local-model',
            headers: { Authorization: 'Bearer file-secret' },
            capabilities: { maxContext: 4_096 },
          },
        })
        .configure({ model: { headers: { authorization: 'Bearer explicit-secret' } } })
        .build();
      await collect(
        higherHeader.model.stream(
          { messages: [{ role: 'user', content: 'hello' }], tools: [], toolUse: 'none' },
          new AbortController().signal,
        ),
      );

      const higherApiKey = AgentBuilder.fromPreset('oss-local')
        .configFile({
          model: {
            name: 'local-model',
            headers: { Authorization: 'Bearer file-secret' },
            capabilities: { maxContext: 4_096 },
          },
        })
        .configure({ model: { apiKey: 'explicit-api-key' } })
        .build();
      await collect(
        higherApiKey.model.stream(
          { messages: [{ role: 'user', content: 'hello' }], tools: [], toolUse: 'none' },
          new AbortController().signal,
        ),
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
      const secondHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
      expect(firstHeaders.get('authorization')).toBe('Bearer explicit-secret');
      expect(firstHeaders.get('authorization')).not.toContain('file-secret');
      expect(secondHeaders.get('authorization')).toBe('Bearer explicit-api-key');
      expect(secondHeaders.get('authorization')).not.toContain('file-secret');

      const sameLayerConflict = captureConfigurationError(() =>
        AgentBuilder.fromPreset('oss-local')
          .configure({
            model: {
              name: 'local-model',
              apiKey: 'api-key',
              headers: { Authorization: 'Bearer header-secret' },
              capabilities: { maxContext: 4_096 },
            },
          })
          .build(),
      );
      expect(sameLayerConflict).toMatchObject({
        layer: 'explicit-code',
        keyPath: 'model.headers.Authorization',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('assembles explicit event, tool, strategy, middleware, and prompt overrides', async () => {
    const eventLog = new InMemoryEventLog({
      tenantId: 'explicit-tenant',
      sessionId: 'explicit-session',
    });
    const model = new ScriptedModelPort([
      [
        {
          kind: 'tool-call',
          callId: 'call-echo',
          tool: 'echo',
          args: { text: 'hello' },
        },
        { kind: 'finish', reason: 'tool-calls' },
      ],
      [
        { kind: 'text', text: 'Echo completed.' },
        {
          kind: 'usage',
          usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
        },
        { kind: 'finish', reason: 'stop' },
      ],
    ]);
    const echo = new EchoTool();
    let eventMiddlewareCalls = 0;

    const agent = AgentBuilder.fromPreset('oss-local')
      .model(model)
      .eventLog(eventLog)
      .tool(echo, { groups: ['local'] })
      .strategy('stop', 'max-steps', { maxSteps: 4 })
      .use('event', async (_context, next) => {
        eventMiddlewareCalls += 1;
        await next();
      })
      .promptOverride('system.identity', 'Builder test identity.', {
        mode: 'replace',
        version: 'test-v1',
      })
      .build();

    const result = await agent.runTurn({ content: 'Use echo, then report.' });

    expect(agent.eventLog).toBe(eventLog);
    expect(agent.tools.require('echo')).toBe(echo);
    expect(agent.tools.groupsFor('echo')).toEqual(['local']);
    expect(agent.prompts.require('system.identity').content).toBe('Builder test identity.');
    expect(model.requests[0]?.messages[0]?.content).toContain('Builder test identity.');
    expect(result.events.some((event) => event.type === 'tool.result')).toBe(true);
    expect(result.stopReason).toBe('completed');
    expect(eventMiddlewareCalls).toBe(result.events.length);
  });
});

describe('createAgent', () => {
  it('provides the oss-local facade without contacting its configured endpoint', async () => {
    const agent = createAgent({
      preset: 'oss-local',
      environment: {
        OAC_MODEL_NAME: 'environment-model',
        OAC_MODEL_MAX_CONTEXT: '4096',
      },
      identity: { tenantId: 'facade-tenant', sessionId: 'facade-session' },
      model: { capabilities: { maxContext: 8_192 } },
    });

    expect(agent.model).toBeInstanceOf(OpenAICompatibleModel);
    expect(agent.model.capabilities).toMatchObject({
      toolUse: 'prompted',
      maxContext: 8_192,
    });
    expect(agent.eventLog).toMatchObject({
      tenantId: 'facade-tenant',
      sessionId: 'facade-session',
    });

    await expect(
      agent.model.countTokens(
        {
          messages: [{ role: 'user', content: 'Count locally.' }],
          tools: [],
          toolUse: 'none',
        },
        new AbortController().signal,
      ),
    ).resolves.toBeGreaterThan(0);
  });
});

function captureConfigurationError(action: () => unknown): AgentConfigurationError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentConfigurationError);
    return error as AgentConfigurationError;
  }
  throw new Error('Expected AgentConfigurationError.');
}

async function collect<TValue>(values: AsyncIterable<TValue>): Promise<TValue[]> {
  const collected: TValue[] = [];
  for await (const value of values) collected.push(value);
  return collected;
}
