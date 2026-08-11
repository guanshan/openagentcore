import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { AnySchema } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';

import type { AgentEvent } from './types.js';

export const agentEventSchemaId = 'https://openagentcore.dev/spec/schemas/agent-event.v0.json';

const agentEventSchemaPath = fileURLToPath(
  new URL('../../../../spec/schemas/agent-event.v0.json', import.meta.url),
);
const agentEventSchema = JSON.parse(readFileSync(agentEventSchemaPath, 'utf8')) as AnySchema;
const addFormats = formatsModule.default as unknown as (instance: Ajv2020) => Ajv2020;

export function createSpecAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv;
}

export async function collect<TValue>(values: AsyncIterable<TValue>): Promise<TValue[]> {
  const collected: TValue[] = [];
  for await (const value of values) {
    collected.push(value);
  }
  return collected;
}

const validate = createSpecAjv().compile<AgentEvent>(agentEventSchema);

export function assertSchemaValidEvent<TEvent extends AgentEvent>(event: TEvent): TEvent {
  if (!validate(event)) {
    throw new Error(`Test event does not match AgentEvent v0: ${JSON.stringify(validate.errors)}`);
  }
  return event;
}
