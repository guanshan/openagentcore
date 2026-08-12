import { randomBytes } from 'node:crypto';

import type { ModelRequest } from '@openagentcore/kernel';
import { describe, expect, it, vi } from 'vitest';

import {
  TENCENT_HY3_CAPABILITIES,
  TENCENT_TOKENHUB_BASE_URL,
  TencentHunyuanModel,
  TencentModelConfigError,
} from './hunyuan.js';

const REQUEST: ModelRequest = {
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
  toolUse: 'native',
};

describe('TencentHunyuanModel', () => {
  it('uses the current TokenHub endpoint and documented hy3 capabilities', async () => {
    const credential = randomBytes(24).toString('base64url');
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const model = new TencentHunyuanModel({ apiKey: credential, fetch });

    const chunks = [];
    for await (const chunk of model.stream(REQUEST, new AbortController().signal)) {
      chunks.push(chunk);
    }

    expect(model.capabilities).toEqual(TENCENT_HY3_CAPABILITIES);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${TENCENT_TOKENHUB_BASE_URL}/chat/completions`);
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'hy3', stream: true });
    expect(JSON.stringify(chunks)).not.toContain(credential);
  });

  it('does not guess capabilities for an arbitrary model ID', () => {
    expect(() => new TencentHunyuanModel({ model: 'another-model' })).toThrow(
      TencentModelConfigError,
    );
  });
});
