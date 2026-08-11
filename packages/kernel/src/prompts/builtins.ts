import { PromptRegistry, type PromptSourceSnapshot } from './registry.js';

export const BUILTIN_PROMPT_SOURCE_VERSION = '1.1.0';

export const BUILTIN_PROMPTS = Object.freeze([
  {
    id: 'compaction.summarize',
    version: '1.0.0',
    content:
      'Summarize the conversation faithfully. Preserve decisions, constraints, unresolved questions, and facts needed to continue the task.',
  },
  {
    id: 'error.retry-hint',
    version: '1.0.0',
    content:
      'The operation failed. Inspect the error, adjust the approach, and use another available path when retrying unchanged would not help.',
  },
  {
    id: 'subagent.default',
    version: '1.0.0',
    content:
      'Complete the delegated task within its stated scope and return concrete results to the parent agent.',
  },
  {
    id: 'system.capabilities',
    version: '1.0.0',
    content:
      'Use the capabilities made available for this run, and base conclusions on their returned results.',
  },
  {
    id: 'system.identity',
    version: '1.0.0',
    content:
      'You are an OpenAgentCore agent. Work toward the requested outcome while respecting the supplied constraints.',
  },
  {
    id: 'system.project-context',
    version: '1.0.0',
    content: '',
  },
  {
    id: 'system.skills',
    version: '1.0.0',
    content: '',
  },
  {
    id: 'system.tool-protocol',
    version: '1.0.0',
    content:
      'Follow the active tool protocol exactly and treat tool results as the authoritative outcome of each call.',
  },
  {
    id: 'system.user-custom',
    version: '1.0.0',
    content: '',
  },
  {
    id: 'tool.protocol.prompted',
    version: '1.1.0',
    content:
      'Emit exactly one complete tool call as OAC_TOOL_CALL {"callId":"...","tool":"...","args":{}}. Tool results are returned as OAC_TOOL_RESULT {"callId":"...","result":...}.',
  },
] as const);

export const BUILTIN_PROMPT_SOURCE: PromptSourceSnapshot = Object.freeze({
  id: '@openagentcore/kernel',
  version: BUILTIN_PROMPT_SOURCE_VERSION,
  prompts: BUILTIN_PROMPTS,
});

export function createDefaultPromptRegistry(): PromptRegistry {
  return new PromptRegistry(BUILTIN_PROMPT_SOURCE);
}
