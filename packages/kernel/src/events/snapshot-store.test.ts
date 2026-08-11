import { describe, expect, it } from 'vitest';

import { InMemorySnapshotStore, SnapshotStoreInvariantError } from './snapshot-store.js';

interface TestState {
  messages: string[];
}

describe('InMemorySnapshotStore', () => {
  it('stores isolated state and loads snapshots by reference', async () => {
    const store = new InMemorySnapshotStore<TestState>();
    const state = { messages: ['first'] };
    const stored = await store.save({
      tenantId: 'tenant-test',
      sessionId: 'session-test',
      lastSeq: 2,
      state,
    });

    state.messages.push('mutated outside');
    stored.state.messages.push('mutated return value');

    await expect(store.load(stored.snapshotRef)).resolves.toMatchObject({
      tenantId: 'tenant-test',
      sessionId: 'session-test',
      lastSeq: 2,
      state: { messages: ['first'] },
    });
  });

  it('loads the snapshot with the greatest lastSeq for one stream', async () => {
    const store = new InMemorySnapshotStore<TestState>();
    await store.save({
      tenantId: 'tenant-test',
      sessionId: 'session-test',
      lastSeq: 5,
      state: { messages: ['newer'] },
    });
    await store.save({
      tenantId: 'tenant-test',
      sessionId: 'session-test',
      lastSeq: 2,
      state: { messages: ['older'] },
    });

    await expect(store.loadLatest('tenant-test', 'session-test')).resolves.toMatchObject({
      lastSeq: 5,
      state: { messages: ['newer'] },
    });
    await expect(store.loadLatest('tenant-test', 'missing')).resolves.toBeUndefined();
  });

  it('rejects invalid snapshot metadata', async () => {
    const store = new InMemorySnapshotStore<TestState>();

    await expect(
      store.save({
        tenantId: 'tenant-test',
        sessionId: 'session-test',
        lastSeq: -1,
        state: { messages: [] },
      }),
    ).rejects.toBeInstanceOf(SnapshotStoreInvariantError);
  });
});
