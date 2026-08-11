import { ScriptedModelPort } from '@openagentcore/kernel';
import { createAgent } from '@openagentcore/standard';

const agent = createAgent({
  environment: {},
  modelPort: new ScriptedModelPort([
    [
      { kind: 'text', text: 'Facade ready.' },
      { kind: 'finish', reason: 'stop' },
    ],
  ]),
});
const result = await agent.runTurn({ content: 'Confirm that the facade is ready.' });
console.log(result.stopReason);
