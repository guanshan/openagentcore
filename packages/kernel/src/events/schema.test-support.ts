import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { AnySchema } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';

import type { AgentEvent } from './types.js';

const schemaPath = fileURLToPath(
  new URL('../../../../spec/schemas/agent-event.v0.json', import.meta.url),
);
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as AnySchema;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const addFormats = formatsModule.default as unknown as (instance: Ajv2020) => Ajv2020;
addFormats(ajv);
const validate = ajv.compile<AgentEvent>(schema);

export function assertSchemaValidEvent<TEvent extends AgentEvent>(event: TEvent): TEvent {
  if (!validate(event)) {
    throw new Error(`Test event does not match AgentEvent v0: ${JSON.stringify(validate.errors)}`);
  }
  return event;
}
