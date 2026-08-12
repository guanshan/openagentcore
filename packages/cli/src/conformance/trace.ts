import type { TracePort } from '@openagentcore/kernel';

import type {
  ConformanceCaseResult,
  ConformanceSuiteResult,
  TraceConformanceAdapter,
} from './types.js';

export async function runTraceConformance(
  adapter: TraceConformanceAdapter,
): Promise<ConformanceSuiteResult> {
  const availability = await adapter.availability?.();
  if (availability !== undefined && !availability.available) {
    return skipped(adapter.name, adapter.capabilities ?? {}, availability.reason);
  }
  const trace = adapter.create();
  const cases: ConformanceCaseResult[] = [];
  await runCase(cases, 'capability declaration is structurally valid and honest', async () => {
    validateCapabilities(trace);
    if (trace.capabilities.contentCapture) {
      if (trace.serializeContent === undefined) {
        throw new Error('contentCapture=true requires serializeContent');
      }
      const serialized = trace.serializeContent({ apiKey: 'trace-secret' });
      if (serialized.includes('trace-secret')) {
        throw new Error('content serializer exposed a sensitive-key value');
      }
    }
  });
  await runCase(cases, 'turn and child span contexts preserve explicit parentage', async () => {
    const root = trace.startSpan('invoke_agent', {
      kind: 'internal',
      attributes: { 'gen_ai.operation.name': 'invoke_agent' },
    });
    const child = trace.startSpan('chat', {
      kind: 'client',
      parent: root.context,
      attributes: { 'gen_ai.operation.name': 'chat' },
    });
    validateContext(root.context, trace.capabilities.exporter === 'none');
    validateContext(child.context, trace.capabilities.exporter === 'none');
    if (child.context.traceId !== root.context.traceId) {
      throw new Error('child traceId differs from its explicit parent');
    }
    if (trace.capabilities.exporter !== 'none' && child.context.spanId === root.context.spanId) {
      throw new Error('exported parent and child share a spanId');
    }
    child.end({ status: 'ok' });
    root.end({ status: 'ok' });
  });
  await runCase(cases, 'token and strategy-style metrics flush through the port', async () => {
    trace.recordMetric({
      name: 'gen_ai.client.token.usage',
      value: 1,
      unit: '{token}',
      attributes: { 'gen_ai.token.type': 'input' },
    });
    trace.recordMetric({
      name: 'openagentcore.strategy.effect',
      value: 1,
      unit: '1',
      attributes: { 'openagentcore.strategy.name': 'conformance' },
    });
    await trace.forceFlush?.();
  });

  await trace.shutdown?.();
  return Object.freeze({
    port: 'trace',
    adapter: adapter.name,
    status: cases.some((entry) => entry.status === 'failed') ? 'failed' : 'passed',
    capabilities: Object.freeze({ ...trace.capabilities }),
    detail: summarizeCases(cases),
    cases: Object.freeze(cases),
  });
}

function skipped(
  adapter: string,
  capabilities: Readonly<Record<string, boolean | number | string>>,
  reason: string,
): ConformanceSuiteResult {
  return Object.freeze({
    port: 'trace',
    adapter,
    status: 'skipped',
    capabilities: Object.freeze({ ...capabilities }),
    detail: reason,
    cases: Object.freeze([]),
  });
}

function validateCapabilities(trace: TracePort): void {
  if (typeof trace.capabilities.exporter !== 'string' || trace.capabilities.exporter.length === 0) {
    throw new Error('exporter must be a non-empty string');
  }
  if (typeof trace.capabilities.contentCapture !== 'boolean') {
    throw new Error('contentCapture must be boolean');
  }
}

function validateContext(
  context: { readonly traceId: string; readonly spanId: string },
  allowNoop: boolean,
): void {
  if (!/^[0-9a-f]{32}$/.test(context.traceId) || !/^[0-9a-f]{16}$/.test(context.spanId)) {
    throw new Error('span context is not a lowercase hexadecimal OTLP identifier');
  }
  if (!allowNoop && (/^0+$/.test(context.traceId) || /^0+$/.test(context.spanId))) {
    throw new Error('exported spans use an invalid all-zero identifier');
  }
}

async function runCase(
  cases: ConformanceCaseResult[],
  name: string,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
    cases.push({ name, status: 'passed', detail: 'ok' });
  } catch (error) {
    cases.push({ name, status: 'failed', detail: stableError(error) });
  }
}

function summarizeCases(cases: readonly ConformanceCaseResult[]): string {
  const failed = cases.filter((entry) => entry.status === 'failed').length;
  return failed === 0
    ? `${cases.length} cases passed.`
    : `${failed} of ${cases.length} cases failed.`;
}

function stableError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
