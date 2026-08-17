import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@anti-air/engine': fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)),
    },
  },
});
