import { defineConfig } from 'vitest/config'

// Live tests against the real provider. Each suite self-skips without DEEPSEEK_API_KEY.
export default defineConfig({
  test: {
    include: ['src/**/*.e2e.test.ts'],
    // An arc's own diagnostics reach the terminal on a PASSING run too. What a
    // live arc measured is the point of running it — the routing arc's flake
    // rate is a number the route to V1 reports rather than hides, and a green
    // tick cannot say whether a run passed because the summary carried a fact
    // or because the model went back for it.
    disableConsoleIntercept: true,
    testTimeout: 600_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
