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
      '@openagentcore/standard': fileURLToPath(
        new URL('./providers/standard/src/index.ts', import.meta.url),
      ),
    },
  },
});
