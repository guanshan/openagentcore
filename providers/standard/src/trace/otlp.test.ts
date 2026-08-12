import {
  AgentLoop,
  EchoTool,
  InMemoryEventLog,
  ScriptedModelPort,
  ToolRegistry,
  type TracePort,
} from '@openagentcore/kernel';
import { describe, expect, it, vi } from 'vitest';

import { OtlpTracePort } from './otlp.js';

describe('OtlpTracePort', () => {
  it('exports OTLP/HTTP spans with explicit parents and metrics', async () => {
    const requests: RequestRecord[] = [];
    const trace = createTrace(requests);
    const root = trace.startSpan('invoke_agent', {
      kind: 'internal',
      attributes: { 'gen_ai.operation.name': 'invoke_agent' },
      startTimeUnixMs: 10,
    });
    const child = trace.startSpan('chat', {
      kind: 'client',
      parent: root.context,
      attributes: { 'gen_ai.operation.name': 'chat' },
      startTimeUnixMs: 11,
    });
    child.end({ status: 'ok', endTimeUnixMs: 12 });
    root.end({ status: 'ok', endTimeUnixMs: 13 });
    trace.recordMetric({
      name: 'gen_ai.client.token.usage',
      value: 5,
      unit: '{token}',
      attributes: { 'gen_ai.token.type': 'input' },
      timeUnixMs: 14,
    });

    await trace.forceFlush();

    expect(requests.map((request) => request.url)).toEqual([
      'http://collector.test/v1/traces',
      'http://collector.test/v1/metrics',
    ]);
    const payload = requests[0]?.body as TracePayload;
    const spans = payload.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ name: 'chat', parentSpanId: root.context.spanId, kind: 3 });
    expect(spans[1]).toMatchObject({ name: 'invoke_agent', kind: 1 });
    expect(JSON.stringify(requests[1]?.body)).toContain('gen_ai.client.token.usage');
  });

  it('keeps prompt and tool content out by default', async () => {
    const requests: RequestRecord[] = [];
    const trace = createTrace(requests);

    await runTracedTurn(trace, 'prompt-default-sentinel', {
      apiKey: 'tool-default-secret',
    });
    await trace.forceFlush();

    const payload = JSON.stringify(requests);
    expect(payload).not.toContain('prompt-default-sentinel');
    expect(payload).not.toContain('tool-default-secret');
    expect(payload).not.toContain('gen_ai.input.messages');
    expect(payload).not.toContain('gen_ai.tool.call.arguments');
  });

  it('applies Record & Replay redaction rules when content capture is explicitly enabled', async () => {
    const requests: RequestRecord[] = [];
    const trace = createTrace(requests, true);

    await runTracedTurn(trace, 'Authorization: Bearer prompt-secret', {
      apiKey: 'tool-secret',
      note: 'access_token=embedded-secret',
      clientSecret: 'additional-secret',
    });
    await trace.forceFlush();

    const payload = JSON.stringify(requests);
    expect(payload).toContain('[REDACTED]');
    for (const secret of ['prompt-secret', 'tool-secret', 'embedded-secret', 'additional-secret']) {
      expect(payload).not.toContain(secret);
    }
    expect(payload).toContain('gen_ai.input.messages');
    expect(payload).toContain('gen_ai.tool.call.arguments');
  });

  it('surfaces OTLP rejection from forceFlush without leaking the response body', async () => {
    const trace = new OtlpTracePort({
      endpoint: 'http://collector.test',
      fetch: vi.fn(async () => new Response('credential-sentinel', { status: 503 })),
    });
    const span = trace.startSpan('invoke_agent', { kind: 'internal' });
    span.end();

    await expect(trace.forceFlush()).rejects.toThrow('status 503');
    await expect(trace.forceFlush()).rejects.not.toThrow('credential-sentinel');
  });
});

interface RequestRecord {
  readonly url: string;
  readonly body: unknown;
}

interface TracePayload {
  readonly resourceSpans: readonly {
    readonly scopeSpans: readonly {
      readonly spans: readonly {
        readonly name: string;
        readonly parentSpanId?: string;
        readonly kind: number;
      }[];
    }[];
  }[];
}

function createTrace(requests: RequestRecord[], captureContent = false): OtlpTracePort {
  return new OtlpTracePort({
    endpoint: 'http://collector.test',
    captureContent,
    additionalSensitiveKeys: ['clientSecret'],
    resourceAttributes: { 'service.name': 'trace-test' },
    fetch: vi.fn(async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(null, { status: 200 });
    }),
  });
}

async function runTracedTurn(
  trace: TracePort,
  prompt: string,
  args: Record<string, string>,
): Promise<void> {
  const loop = new AgentLoop({
    eventLog: new InMemoryEventLog({ tenantId: 'tenant-otlp', sessionId: 'session-otlp' }),
    model: new ScriptedModelPort([
      [{ kind: 'tool-call', callId: 'call-otlp', tool: 'echo', args }],
      [
        { kind: 'text', text: 'done' },
        { kind: 'finish', reason: 'stop' },
      ],
    ]),
    tools: new ToolRegistry().register(new EchoTool()),
    trace,
  });
  await loop.runTurn({ content: prompt });
}
