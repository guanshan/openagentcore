import {
  AgentLoop,
  EchoTool,
  InMemoryEventLog,
  ToolRegistry,
  type ModelChunk,
  type ModelPort,
  type ModelRequest,
} from '@openagentcore/kernel';

import type {
  ConformanceCaseResult,
  ConformanceSuiteResult,
  ModelConformanceAdapter,
} from './types.js';

const defaultRequest = Object.freeze({
  messages: [{ role: 'user', content: 'Return a short conformance response.' }],
  tools: [],
  toolUse: 'none',
} satisfies ModelRequest);

export async function runModelConformance(
  adapter: ModelConformanceAdapter,
): Promise<ConformanceSuiteResult> {
  const cases: ConformanceCaseResult[] = [];
  await runCase(cases, 'capability declaration is structurally valid', async () => {
    validateCapabilities(adapter.create());
  });
  await runCase(cases, 'countTokens returns a non-negative safe integer', async () => {
    const model = adapter.create();
    const count = await model.countTokens(adapter.request ?? defaultRequest, signal());
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`received ${String(count)}`);
    }
  });
  await runCase(cases, 'declared stream mode produces exactly one terminal finish', async () => {
    const model = adapter.create();
    const request = adapter.request ?? requestForCapabilities(model);
    const chunks = await collect(model.stream(request, signal()));
    validateStream(chunks);
  });
  await runCase(
    cases,
    'unsupported native tool use follows the kernel downgrade path',
    async () => {
      const model = adapter.create();
      const loop = new AgentLoop({
        eventLog: new InMemoryEventLog({
          tenantId: 'conformance',
          sessionId: `model-${safeId(adapter.name)}`,
        }),
        model,
        tools: new ToolRegistry().register(new EchoTool()),
      });
      const result = await loop.dryRunContext({ content: 'Inspect capability negotiation.' });
      const expected =
        model.capabilities.toolUse === 'native'
          ? []
          : [`tool-use:native->${model.capabilities.toolUse}`];
      if (JSON.stringify(result.assembly.capabilityDowngrades) !== JSON.stringify(expected)) {
        throw new Error(
          `expected ${JSON.stringify(expected)}, received ${JSON.stringify(
            result.assembly.capabilityDowngrades,
          )}`,
        );
      }
    },
  );
  await runCase(cases, 'pre-aborted calls preserve cancellation', async () => {
    const reason = new Error('model conformance cancellation');
    const controller = new AbortController();
    controller.abort(reason);
    const model = adapter.create();
    await expectRejected(
      model.countTokens(adapter.request ?? defaultRequest, controller.signal),
      reason,
    );
    const iterator = model
      .stream(adapter.request ?? requestForCapabilities(model), controller.signal)
      [Symbol.asyncIterator]();
    await expectRejected(iterator.next(), reason);
  });

  const model = adapter.create();
  return Object.freeze({
    port: 'model',
    adapter: adapter.name,
    status: cases.some((entry) => entry.status === 'failed') ? 'failed' : 'passed',
    capabilities: Object.freeze({ ...model.capabilities }),
    detail: summarizeCases(cases),
    cases: Object.freeze(cases),
  });
}

function validateCapabilities(model: ModelPort): void {
  const capabilities = model.capabilities;
  for (const field of ['streaming', 'promptCaching', 'structuredOutput', 'vision'] as const) {
    if (typeof capabilities[field] !== 'boolean') {
      throw new Error(`${field} must be boolean`);
    }
  }
  if (!['native', 'prompted', 'none'].includes(capabilities.toolUse)) {
    throw new Error(`invalid toolUse ${String(capabilities.toolUse)}`);
  }
  if (!Number.isSafeInteger(capabilities.maxContext) || capabilities.maxContext < 1) {
    throw new Error('maxContext must be a positive safe integer');
  }
}

function requestForCapabilities(model: ModelPort): ModelRequest {
  return {
    ...defaultRequest,
    toolUse: model.capabilities.toolUse === 'none' ? 'none' : model.capabilities.toolUse,
  };
}

function validateStream(chunks: readonly ModelChunk[]): void {
  const finishes = chunks.filter((chunk) => chunk.kind === 'finish');
  if (finishes.length !== 1 || chunks.at(-1)?.kind !== 'finish') {
    throw new Error(`expected one terminal finish, received ${JSON.stringify(chunks)}`);
  }
}

async function collect(values: AsyncIterable<ModelChunk>): Promise<readonly ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of values) {
    chunks.push(chunk);
  }
  return chunks;
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

async function expectRejected(operation: Promise<unknown>, reason: unknown): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (error === reason) {
      return;
    }
    throw new Error(`cancellation changed to ${stableError(error)}`);
  }
  throw new Error('operation resolved after cancellation');
}

function signal(): AbortSignal {
  return new AbortController().signal;
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

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-');
}
