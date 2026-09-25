import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/interfaces/cli/main.ts', 'src/interfaces/http/main.ts'],
      reporter: ['text', 'lcov'],
      // A floor, not a target: it catches a suite that quietly stopped running,
      // without pretending the remaining branches are all worth a test.
      thresholds: {
        statements: 85,
        branches: 75,
        functions: 85,
        lines: 85,
      },
    },
  },
});
