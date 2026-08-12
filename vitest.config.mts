import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@openagentcore/kernel': fileURLToPath(
        new URL('./packages/kernel/src/index.ts', import.meta.url),
      ),
      '@openagentcore/standard/model': fileURLToPath(
        new URL('./providers/standard/src/model/index.ts', import.meta.url),
      ),
      '@openagentcore/standard/sandbox': fileURLToPath(
        new URL('./providers/standard/src/sandbox/index.ts', import.meta.url),
      ),
      '@openagentcore/standard/store': fileURLToPath(
        new URL('./providers/standard/src/store/index.ts', import.meta.url),
      ),
      '@openagentcore/standard/trace': fileURLToPath(
        new URL('./providers/standard/src/trace/index.ts', import.meta.url),
      ),
      '@openagentcore/standard/vault': fileURLToPath(
        new URL('./providers/standard/src/vault/index.ts', import.meta.url),
      ),
      '@openagentcore/standard': fileURLToPath(
        new URL('./providers/standard/src/index.ts', import.meta.url),
      ),
    },
  },
});
