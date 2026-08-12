import { describe, expect, it, vi } from 'vitest';

import { createTencentApmTrace } from './apm.js';

describe('createTencentApmTrace', () => {
  it('exports through standard OTLP with Tencent Cloud resource metadata', async () => {
    const bodies: string[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(null, { status: 200 });
    });
    const trace = createTencentApmTrace({
      endpoint: 'https://apm.example.invalid/otlp',
      fetch,
      now: () => 1,
    });
    trace.startSpan('probe', { kind: 'internal' }).end();

    await trace.forceFlush();

    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://apm.example.invalid/otlp/v1/traces');
    expect(bodies[0]).toContain('tencent_cloud');
  });
});
