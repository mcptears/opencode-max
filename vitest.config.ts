import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./src/__tests__/setup.ts'],
    testTimeout: 15000,
    exclude: ['node_modules/**', 'dist/**'],
  },
});
