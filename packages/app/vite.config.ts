import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 引擎以原始碼形式引入：改引擎立刻反映在畫面上，不用另外 build。
      '@anti-air/engine': fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // data/ 在 repo 根目錄、不在 app root 之下，需明示放行。
    fs: { allow: [repoRoot] },
  },
});
