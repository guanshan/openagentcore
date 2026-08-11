export interface SnapshotInput<TState> {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly lastSeq: number;
  readonly state: TState;
}

export interface StoredSnapshot<TState> extends SnapshotInput<TState> {
  readonly snapshotRef: string;
}

export interface SnapshotStore<TState> {
  save(snapshot: SnapshotInput<TState>): Promise<StoredSnapshot<TState>>;
  load(snapshotRef: string): Promise<StoredSnapshot<TState> | undefined>;
  loadLatest(tenantId: string, sessionId: string): Promise<StoredSnapshot<TState> | undefined>;
}

export class SnapshotStoreInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotStoreInvariantError';
  }
}

export class InMemorySnapshotStore<TState> implements SnapshotStore<TState> {
  readonly #snapshots = new Map<string, StoredSnapshot<TState>>();
  #nextSnapshotId = 1;

  async save(snapshot: SnapshotInput<TState>): Promise<StoredSnapshot<TState>> {
    if (snapshot.tenantId.length === 0 || snapshot.sessionId.length === 0) {
      throw new SnapshotStoreInvariantError('Snapshot identity fields must be non-empty.');
    }

    if (!Number.isInteger(snapshot.lastSeq) || snapshot.lastSeq < 0) {
      throw new SnapshotStoreInvariantError(
        `Snapshot lastSeq must be a non-negative integer; received ${snapshot.lastSeq}.`,
      );
    }

    const stored = structuredClone({
      ...snapshot,
      snapshotRef: `memory-snapshot-${this.#nextSnapshotId}`,
    });
    this.#nextSnapshotId += 1;
    this.#snapshots.set(stored.snapshotRef, stored);
    return structuredClone(stored);
  }

  async load(snapshotRef: string): Promise<StoredSnapshot<TState> | undefined> {
    const snapshot = this.#snapshots.get(snapshotRef);
    return snapshot === undefined ? undefined : structuredClone(snapshot);
  }

  async loadLatest(
    tenantId: string,
    sessionId: string,
  ): Promise<StoredSnapshot<TState> | undefined> {
    let latest: StoredSnapshot<TState> | undefined;

    for (const snapshot of this.#snapshots.values()) {
      if (
        snapshot.tenantId === tenantId &&
        snapshot.sessionId === sessionId &&
        (latest === undefined || snapshot.lastSeq >= latest.lastSeq)
      ) {
        latest = snapshot;
      }
    }

    return latest === undefined ? undefined : structuredClone(latest);
  }
}
