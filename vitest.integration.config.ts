import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/*.integration.test.ts'], hookTimeout: 180000, testTimeout: 30000, fileParallelism: false } });
