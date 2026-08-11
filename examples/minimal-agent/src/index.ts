import {
  AgentLoop,
  EchoTool,
  InMemoryEventLog,
  ScriptedModelPort,
  ToolRegistry,
} from '@openagentcore/kernel';

const model = new ScriptedModelPort([
  [
    {
      kind: 'tool-call',
      callId: 'call-echo',
      tool: 'echo',
      args: { text: 'hello from OpenAgentCore' },
    },
    { kind: 'finish', reason: 'tool-calls' },
  ],
  [
    { kind: 'text', text: 'The echo tool completed.' },
    {
      kind: 'usage',
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    },
    { kind: 'finish', reason: 'stop' },
  ],
]);

const loop = new AgentLoop({
  eventLog: new InMemoryEventLog({
    tenantId: 'example-tenant',
    sessionId: 'minimal-agent',
  }),
  model,
  tools: new ToolRegistry().register(new EchoTool()),
});

const result = await loop.runTurn({ content: 'Echo a greeting, then report completion.' });

console.log('Event stream');
for (const event of result.events) {
  console.log(JSON.stringify(event));
}
console.log('Final message history');
console.log(JSON.stringify(result.history, null, 2));
