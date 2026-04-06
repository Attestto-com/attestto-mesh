import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'], // re-export barrel — no logic to cover
      thresholds: {
        // node.ts and gc.ts require a live libp2p node — covered by integration
        // tests, not unit tests. Thresholds reflect unit-testable code only.
        // Raise these incrementally as integration test coverage is added.
        lines: 50,
        functions: 60,
        branches: 80,
        statements: 50,
      },
    },
  },
})
