import { defineConfig } from 'vitest/config'

/**
 * Two groups, run one after the other. The real-browser suites launch Chrome
 * (a burst of several processes each) and, run beside the rest of the suite on
 * a loaded host, starved its CPU-bound tests past their timeouts (the pdf
 * helper's decode budget, measured 2026-10-19). So they run after everything
 * else, one file at a time, and the rest keeps its full parallelism.
 */
const BROWSER_SUITES = ['src/capabilities/tool-browser/**/*.test.ts']

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test-support/**'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: ['src/**/*.e2e.test.ts', 'node_modules/**', ...BROWSER_SUITES],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: BROWSER_SUITES,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
})
