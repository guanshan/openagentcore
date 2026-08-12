import { LocalProcessSandbox } from '@openagentcore/kernel';
import { DockerSandbox } from '@openagentcore/standard';
import { OpenAICompatibleModel } from '@openagentcore/standard/model';

import type { ModelConformanceAdapter, SandboxConformanceAdapter } from './types.js';

export function defaultModelAdapters(): readonly ModelConformanceAdapter[] {
  return [
    {
      name: '@openagentcore/standard/openai-compatible',
      create: () =>
        new OpenAICompatibleModel({
          baseUrl: 'http://conformance.invalid/v1',
          model: 'conformance',
          capabilities: { maxContext: 4_096, toolUse: 'prompted' },
          includeUsage: false,
          fetch: async () => conformanceStream(),
        }),
    },
  ];
}

export function defaultSandboxAdapters(): readonly SandboxConformanceAdapter[] {
  return [
    {
      name: '@openagentcore/kernel/local-process',
      create: (root) => new LocalProcessSandbox({ root }),
    },
    {
      name: '@openagentcore/standard/docker',
      create: (root) => new DockerSandbox({ root }),
      availability: async (sandbox, signal) => {
        if (!(sandbox instanceof DockerSandbox)) {
          return { available: false, reason: 'Default Docker factory returned the wrong adapter.' };
        }
        return sandbox.availability(signal);
      },
    },
  ];
}

function conformanceStream(): Response {
  return new Response(
    [
      'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n'),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
