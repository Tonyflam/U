import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['apps/**/*.{test,spec}.ts', 'packages/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['apps/**/src/**', 'packages/**/src/**'],
      exclude: ['**/*.d.ts', '**/index.ts', '**/types.ts'],
      thresholds: {
        // U1 baseline — raised per-package as code lands.
        statements: 0,
        branches: 0,
        functions: 0,
        lines: 0,
      },
    },
  },
});
