import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['tests/**/*.performance.test.ts'], environment: 'node', fileParallelism: false, testTimeout: 180000 } });
