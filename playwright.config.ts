import { defineConfig } from '@playwright/test';
import { availableParallelism, tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const outputDir = process.env.REVIA_TEST_OUTPUT ??= mkdtempSync(join(tmpdir(), 'revia-tests-'));

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  outputDir,
  fullyParallel: true,
  workers: Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))),
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:5184', channel: 'chrome', locale: 'en-US', viewport: { width: 1440, height: 960 }, trace: 'retain-on-failure' },
  webServer: { command: 'node scripts/serve.mjs --no-open --port 5184', url: 'http://127.0.0.1:5184', reuseExistingServer: !process.env.CI },
});
