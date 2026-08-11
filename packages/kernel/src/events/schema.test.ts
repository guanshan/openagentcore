import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { AnySchema } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import { EventLogInvariantError, InMemoryEventLog } from './event-log.js';
import type { AgentEvent, AgentEventType, Trajectory } from './types.js';

const eventSchemaId = 'https://openagentcore.dev/spec/schemas/agent-event.v0.json';
const specDirectory = fileURLToPath(new URL('../../../../spec/', import.meta.url));
const vectorDirectory = fileURLToPath(new URL('../../../../spec/vectors/', import.meta.url));

type VectorExpectation = 'accepted' | 'schema-rejected' | 'append-rejected';

interface SpecVector {
  readonly fileName: string;
  readonly description: string;
  readonly expected: VectorExpectation;
  readonly events: readonly unknown[];
}

const agentEventSchema = await readJson<AnySchema>(`${specDirectory}schemas/agent-event.v0.json`);
const trajectorySchema = await readJson<AnySchema>(`${specDirectory}schemas/trajectory.v0.json`);
const vectors = await loadVectors();

const ajv = new Ajv2020({ allErrors: true, strict: true });
const addFormats = formatsModule.default as unknown as (instance: Ajv2020) => Ajv2020;
addFormats(ajv);
ajv.addSchema(agentEventSchema);
const validateEvent = ajv.getSchema<AgentEvent>(eventSchemaId);
if (validateEvent === undefined) {
  throw new Error(`Schema not registered: ${eventSchemaId}`);
}
const validateTrajectory = ajv.compile<Trajectory>(trajectorySchema);

describe('AgentEvent v0 schema', () => {
  it('discovers at least five hand-written vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(5);
  });

  it.each(vectors)('$fileName: $description', async (vector) => {
    const schemaAccepted = vector.events.every((event) => validateEvent(event));

    if (vector.expected === 'schema-rejected') {
      expect(schemaAccepted).toBe(false);
      return;
    }

    expect(schemaAccepted, JSON.stringify(validateEvent.errors)).toBe(true);
    const firstEvent = vector.events[0] as AgentEvent | undefined;
    const log = new InMemoryEventLog({
      tenantId: firstEvent?.tenantId ?? 'tenant-empty',
      sessionId: firstEvent?.sessionId ?? 'session-empty',
    });

    let appendError: unknown;
    try {
      for (const event of vector.events) {
        await log.append(event as AgentEvent);
      }
    } catch (error) {
      appendError = error;
    }

    if (vector.expected === 'append-rejected') {
      expect(appendError).toBeInstanceOf(EventLogInvariantError);
    } else {
      expect(appendError).toBeUndefined();
    }
  });

  it('covers all ten event variants with schema-valid fixtures', () => {
    const complete = vectors.find((vector) => vector.fileName === 'valid-complete-event-set.json');
    expect(complete).toBeDefined();
    if (complete === undefined) {
      throw new Error('Missing complete event-set vector.');
    }

    const actualTypes = new Set(
      complete.events.map((event) => (event as { readonly type: AgentEventType }).type),
    );
    expect(actualTypes).toEqual(
      new Set<AgentEventType>([
        'turn.started',
        'model.request',
        'model.delta',
        'tool.call',
        'tool.result',
        'permission.requested',
        'permission.resolved',
        'compaction.applied',
        'checkpoint.created',
        'turn.finished',
      ]),
    );
    expect(complete.events.every((event) => validateEvent(event))).toBe(true);
  });
});

describe('Trajectory v0 schema', () => {
  it('accepts metadata and a schema-valid event stream', () => {
    const complete = vectors.find((vector) => vector.fileName === 'valid-complete-event-set.json');
    if (complete === undefined) {
      throw new Error('Missing complete event-set vector.');
    }
    const trajectory: Trajectory = {
      metadata: {
        specVersion: '0.1.0',
        tenantId: 'tenant-demo',
        sessionId: 'session-complete',
        agentDefinitionSummary: { id: 'agent-demo' },
      },
      events: complete.events as readonly AgentEvent[],
    };

    expect(validateTrajectory(trajectory), JSON.stringify(validateTrajectory.errors)).toBe(true);
    expect(hasConsistentTrajectoryIdentity(trajectory)).toBe(true);
  });

  it('rejects a non-SemVer spec version', () => {
    expect(
      validateTrajectory({
        metadata: {
          specVersion: 'v0',
          tenantId: 'tenant-demo',
          sessionId: 'session-empty',
          agentDefinitionSummary: { id: 'agent-demo' },
        },
        events: [],
      }),
    ).toBe(false);
  });

  it('rejects numeric prerelease identifiers with leading zeroes', () => {
    expect(
      validateTrajectory({
        metadata: {
          specVersion: '1.0.0-01',
          tenantId: 'tenant-demo',
          sessionId: 'session-empty',
          agentDefinitionSummary: { id: 'agent-demo' },
        },
        events: [],
      }),
    ).toBe(false);
  });

  it('checks metadata identity against every event as a stream invariant', () => {
    const trajectory: Trajectory = {
      metadata: {
        specVersion: '1.0.0-rc.1+build.7',
        tenantId: 'tenant-metadata',
        sessionId: 'session-metadata',
        agentDefinitionSummary: { id: 'agent-demo' },
      },
      events: [
        {
          type: 'turn.started',
          seq: 0,
          tenantId: 'tenant-event',
          sessionId: 'session-event',
          ts: '2026-08-11T00:00:00Z',
          turnId: 'turn-1',
          input: { content: 'Start.' },
        },
      ],
    };

    expect(validateTrajectory(trajectory), JSON.stringify(validateTrajectory.errors)).toBe(true);
    expect(hasConsistentTrajectoryIdentity(trajectory)).toBe(false);
  });
});

function hasConsistentTrajectoryIdentity(trajectory: Trajectory): boolean {
  return trajectory.events.every(
    (event) =>
      event.tenantId === trajectory.metadata.tenantId &&
      event.sessionId === trajectory.metadata.sessionId,
  );
}

async function loadVectors(): Promise<SpecVector[]> {
  const fileNames = (await readdir(vectorDirectory))
    .filter((fileName) => fileName.endsWith('.json'))
    .sort();

  return Promise.all(
    fileNames.map(async (fileName) => {
      const value = await readJson<unknown>(`${vectorDirectory}${fileName}`);
      if (!isSpecVector(value)) {
        throw new Error(`Malformed spec vector: ${fileName}`);
      }
      return { ...value, fileName };
    }),
  );
}

function isSpecVector(value: unknown): value is Omit<SpecVector, 'fileName'> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['description'] === 'string' &&
    (candidate['expected'] === 'accepted' ||
      candidate['expected'] === 'schema-rejected' ||
      candidate['expected'] === 'append-rejected') &&
    Array.isArray(candidate['events'])
  );
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
