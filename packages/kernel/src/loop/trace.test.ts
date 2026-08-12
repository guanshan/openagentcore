import { describe, expect, it, vi } from 'vitest';

import { InMemoryEventLog } from '../events/event-log.js';
import type { JsonValue } from '../events/types.js';
import { ScriptedModelPort } from '../ports/model.js';
import type {
  TraceAttributes,
  TraceMetric,
  TracePort,
  TraceSpan,
  TraceSpanContext,
  TraceSpanEndOptions,
  TraceSpanOptions,
} from '../ports/trace.js';
import { EchoTool, ToolRegistry } from '../tools/tool.js';
import { AgentLoop } from './agent-loop.js';

describe('AgentLoop TracePort', () => {
  it('emits the turn, step, model and tool span tree plus usage and strategy metrics', async () => {
    const trace = new RecordingTracePort(false);
    const loop = createLoop(trace);

    await loop.runTurn({ content: 'Use the echo tool.' });

    expect(trace.spans.map((span) => span.name)).toEqual([
      'invoke_agent',
      'agent.step 1',
      'chat',
      'execute_tool echo',
      'agent.step 2',
      'chat',
    ]);
    const turn = trace.spans[0];
    const firstStep = trace.spans[1];
    const model = trace.spans[2];
    const tool = trace.spans[3];
    expect(firstStep?.parent).toEqual(turn?.context);
    expect(model?.parent).toEqual(firstStep?.context);
    expect(tool?.parent).toEqual(firstStep?.context);
    expect(trace.metrics).toContainEqual(
      expect.objectContaining({
        name: 'gen_ai.client.token.usage',
        value: 3,
        attributes: expect.objectContaining({ 'gen_ai.token.type': 'input' }),
      }),
    );
    expect(trace.metrics).toContainEqual(
      expect.objectContaining({ name: 'openagentcore.model.cost', value: 0.01, unit: 'USD' }),
    );
    expect(trace.metrics).toContainEqual(
      expect.objectContaining({ name: 'openagentcore.strategy.effect' }),
    );
  });

  it('omits prompt and tool arguments by default', async () => {
    const trace = new RecordingTracePort(false);
    await createLoop(trace).runTurn({ content: 'prompt-sentinel' });

    const serialized = JSON.stringify(trace.spans);
    expect(serialized).not.toContain('prompt-sentinel');
    expect(serialized).not.toContain('argument-sentinel');
    expect(trace.spans.find((span) => span.name === 'chat')?.attributes).not.toHaveProperty(
      'gen_ai.input.messages',
    );
    expect(
      trace.spans.find((span) => span.name === 'execute_tool echo')?.attributes,
    ).not.toHaveProperty('gen_ai.tool.call.arguments');
  });

  it('uses the TracePort serializer for explicitly enabled content and isolates trace errors', async () => {
    const trace = new RecordingTracePort(true);
    const onTraceError = vi.fn();
    const loop = createLoop(trace, onTraceError);

    await loop.runTurn({ content: 'secret prompt' });

    expect(trace.spans.find((span) => span.name === 'chat')?.attributes).toHaveProperty(
      'gen_ai.input.messages',
      '[REDACTED-CONTENT]',
    );
    expect(trace.serializedContent).toHaveLength(4);
    expect(onTraceError).not.toHaveBeenCalled();

    const dishonest = new RecordingTracePort(true);
    Object.defineProperty(dishonest, 'serializeContent', { value: undefined });
    const dishonestError = vi.fn();
    await createLoop(dishonest, dishonestError).runTurn({ content: 'still completes' });
    expect(dishonestError).toHaveBeenCalledWith(expect.any(Error));
  });
});

function createLoop(trace: TracePort, onTraceError?: (error: unknown) => void): AgentLoop {
  return new AgentLoop({
    eventLog: new InMemoryEventLog({ tenantId: 'tenant-trace', sessionId: 'session-trace' }),
    model: new ScriptedModelPort([
      [
        {
          kind: 'tool-call',
          callId: 'call-trace',
          tool: 'echo',
          args: { value: 'argument-sentinel', apiKey: 'secret-key' },
        },
        {
          kind: 'usage',
          usage: {
            inputTokens: 3,
            outputTokens: 2,
            totalTokens: 5,
            cost: { amount: 0.01, currency: 'USD' },
          },
        },
      ],
      [
        { kind: 'text', text: 'done' },
        { kind: 'finish', reason: 'stop' },
      ],
    ]),
    tools: new ToolRegistry().register(new EchoTool()),
    trace,
    ...(onTraceError === undefined ? {} : { onTraceError }),
  });
}

interface RecordedSpan {
  readonly name: string;
  readonly context: TraceSpanContext;
  readonly parent: TraceSpanContext | undefined;
  readonly attributes: Record<string, unknown>;
  end: TraceSpanEndOptions | undefined;
}

class RecordingTracePort implements TracePort {
  readonly capabilities: TracePort['capabilities'];
  readonly spans: RecordedSpan[] = [];
  readonly metrics: TraceMetric[] = [];
  readonly serializedContent: JsonValue[] = [];
  #nextSpan = 0;

  constructor(contentCapture: boolean) {
    this.capabilities = { exporter: 'test', contentCapture };
  }

  serializeContent(value: JsonValue): string {
    this.serializedContent.push(structuredClone(value));
    return '[REDACTED-CONTENT]';
  }

  startSpan(name: string, options: TraceSpanOptions): TraceSpan {
    this.#nextSpan += 1;
    const context = {
      traceId: options.parent?.traceId ?? this.#nextSpan.toString(16).padStart(32, '0'),
      spanId: this.#nextSpan.toString(16).padStart(16, '0'),
    };
    const recorded: RecordedSpan = {
      name,
      context,
      parent: options.parent,
      attributes: { ...(options.attributes ?? {}) },
      end: undefined,
    };
    this.spans.push(recorded);
    return {
      context,
      setAttributes: (attributes: TraceAttributes) =>
        Object.assign(recorded.attributes, attributes),
      end: (end?: TraceSpanEndOptions) => {
        recorded.end = end;
      },
    };
  }

  recordMetric(metric: TraceMetric): void {
    this.metrics.push(structuredClone(metric));
  }
}
