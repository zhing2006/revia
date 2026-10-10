import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte({ configFile: false })],
  base: './',
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  worker: { format: 'es' },
  build: { target: 'es2023', assetsInlineLimit: 0 },
  test: { include: ['src/**/*.test.ts', 'tests/cli.test.ts'], environment: 'node', fileParallelism: true },
});
