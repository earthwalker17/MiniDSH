import { defineConfig } from 'vitest/config'

/**
 * Live tests against the real providers. Every arc SELF-SKIPS when what it
 * needs is absent, and a skip looks like a pass in a summary, so a green run
 * proves only what actually ran. The skip paths:
 *
 *   DEEPSEEK_API_KEY   every arc, and the DeepSeek drift probe
 *   ANTHROPIC_API_KEY  the routing arc (S6), and the Anthropic drift probe
 *   OPENAI_API_KEY     the routing arc's OpenAI leg, and the OpenAI drift probe
 *   TAVILY_API_KEY     the search arc
 *   a browser          the browser arc (Chrome, Edge or Chromium where MiniDSH looks)
 *   a confining host   the authority arc takes its UNCONFINED branch, silently
 *   MINIDSH_SKILLS_NEUTRAL / _BASELINE  the skills arc's two reported legs
 *
 * Four flags turn a skip into a failure: MINIDSH_EXPECT_KEYS (a comma list of
 * the key names above, checked by expect-keys.e2e.test.ts),
 * MINIDSH_EXPECT_CONFINEMENT, MINIDSH_EXPECT_BROWSER, and — for the bundled
 * skills' Python reader and the shell suites under `pnpm check` —
 * MINIDSH_EXPECT_PYTHON and MINIDSH_EXPECT_SHELL. live.yml sets the ones its
 * hosts must meet; a local run that is meant to count sets them too.
 */
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
