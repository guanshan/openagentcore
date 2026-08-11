import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { AnySchema } from 'ajv';
import { describe, expect, it } from 'vitest';

import { EventLogInvariantError, InMemoryEventLog } from './event-log.js';
import type { EventStreamIdentity } from './event-log.js';
import {
  materializeMessageHistory,
  projectMessageHistory,
  ProjectionInvariantError,
} from './projection.js';
import { agentEventSchemaId, createSpecAjv } from './schema.test-support.js';
import type { AgentEvent, AgentEventType, Trajectory } from './types.js';
import { projectSessionState } from '../loop/session-state.js';

const specDirectory = fileURLToPath(new URL('../../../../spec/', import.meta.url));
const vectorDirectory = fileURLToPath(new URL('../../../../spec/vectors/', import.meta.url));

type VectorExpectation = 'accepted' | 'schema-rejected' | 'append-rejected' | 'replay-rejected';

interface SpecVector {
  readonly fileName: string;
  readonly description: string;
  readonly stream: EventStreamIdentity;
  readonly expected: VectorExpectation;
  readonly events: readonly unknown[];
}

const agentEventSchema = await readJson<AnySchema>(`${specDirectory}schemas/agent-event.v0.json`);
const trajectorySchema = await readJson<AnySchema>(`${specDirectory}schemas/trajectory.v0.json`);
const vectors = await loadVectors();

const ajv = createSpecAjv();
ajv.addSchema(agentEventSchema);
const validateEvent = ajv.getSchema<AgentEvent>(agentEventSchemaId);
if (validateEvent === undefined) {
  throw new Error(`Schema not registered: ${agentEventSchemaId}`);
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
    const log = new InMemoryEventLog(vector.stream);

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
      return;
    }

    expect(appendError).toBeUndefined();

    let replayError: unknown;
    try {
      await projectSessionState(log.read(0));
      const projection = await projectMessageHistory(log.read(0));
      materializeMessageHistory(projection);
    } catch (error) {
      replayError = error;
    }

    if (vector.expected === 'replay-rejected') {
      expect(replayError).toBeInstanceOf(ProjectionInvariantError);
    } else {
      expect(replayError).toBeUndefined();
    }
  });

  it('covers at least three replay-rejected compaction invariants', () => {
    expect(
      vectors.filter(
        (vector) =>
          vector.fileName.startsWith('invalid-replay-') && vector.expected === 'replay-rejected',
      ).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('covers at least two complete framed turns', () => {
    expect(
      vectors.filter(
        (vector) => vector.fileName.startsWith('valid-turn-') && vector.expected === 'accepted',
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('covers at least three replay-rejected temporal invariants', () => {
    expect(
      vectors.filter(
        (vector) =>
          vector.fileName.startsWith('invalid-replay-temporal-') &&
          vector.expected === 'replay-rejected',
      ).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('covers all twelve event variants with schema-valid fixtures', () => {
    const complete = vectors.find((vector) => vector.fileName === 'valid-turn-tool.json');
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
        'step.started',
        'step.finished',
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

  it('accepts a compaction strategy name and rejects an empty one', () => {
    const event = {
      type: 'compaction.applied',
      seq: 2,
      tenantId: 'tenant-demo',
      sessionId: 'session-demo',
      ts: '2026-08-11T00:00:00Z',
      summary: 'Summary.',
      dropped: { fromSeq: 0, toSeq: 1 },
      strategy: 'sliding-window',
    };

    expect(validateEvent(event), JSON.stringify(validateEvent.errors)).toBe(true);
    expect(validateEvent({ ...event, strategy: '' })).toBe(false);
  });

  it('projects injected steering inputs into message history', async () => {
    const vector = vectors.find((candidate) => candidate.fileName === 'valid-turn-no-tools.json');
    if (vector === undefined) {
      throw new Error('Missing no-tools turn vector.');
    }

    const projection = await projectMessageHistory(vector.events as readonly AgentEvent[]);
    expect(materializeMessageHistory(projection)).toContainEqual({
      kind: 'message',
      role: 'user',
      content: 'Steering input.',
      sourceSeqs: [1],
    });
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
    isEventStreamIdentity(candidate['stream']) &&
    (candidate['expected'] === 'accepted' ||
      candidate['expected'] === 'schema-rejected' ||
      candidate['expected'] === 'append-rejected' ||
      candidate['expected'] === 'replay-rejected') &&
    Array.isArray(candidate['events'])
  );
}

function isEventStreamIdentity(value: unknown): value is EventStreamIdentity {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['tenantId'] === 'string' &&
    candidate['tenantId'].length > 0 &&
    typeof candidate['sessionId'] === 'string' &&
    candidate['sessionId'].length > 0
  );
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
