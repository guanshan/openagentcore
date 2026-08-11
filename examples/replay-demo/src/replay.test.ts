import { describe, expect, it, vi } from 'vitest';

import { runReplayDemo } from './replay.js';

describe('replay demo', () => {
  it('rebuilds the same projection after discarding in-memory state', async () => {
    const writeLine = vi.fn();

    const result = await runReplayDemo(writeLine);

    expect(result.matches).toBe(true);
    expect(result.afterRecovery).toEqual(result.beforeInterruption);
    expect(writeLine).toHaveBeenLastCalledWith('Projection match: true');
  });
});
