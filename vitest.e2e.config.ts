import { defineConfig } from 'vitest/config'

// Live tests against the real provider. Each suite self-skips without DEEPSEEK_API_KEY.
export default defineConfig({
  test: {
    include: ['src/**/*.e2e.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
