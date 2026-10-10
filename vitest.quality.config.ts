import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.quality.test.ts'], environment: 'node', fileParallelism: true, testTimeout: 120000 } });
