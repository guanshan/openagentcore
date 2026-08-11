import {
  AgentLoop,
  EchoTool,
  InMemoryEventLog,
  ScriptedModelPort,
  ToolRegistry,
  createDefaultPromptRegistry,
} from '@openagentcore/kernel';

const prompts = createDefaultPromptRegistry().append(
  'system.project-context',
  'This context comes from the context-dry-run example.',
  'context-dry-run-v1',
);

const loop = new AgentLoop({
  eventLog: new InMemoryEventLog({
    tenantId: 'example-tenant',
    sessionId: 'context-dry-run',
  }),
  model: new ScriptedModelPort([]),
  tools: new ToolRegistry().register(new EchoTool()),
  prompts,
});

const { report } = await loop.dryRunContext({
  content: 'Inspect the assembled context without calling the model.',
});

console.log(report);
