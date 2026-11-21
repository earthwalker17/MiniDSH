/**
 * `MINIDSH_EXPECT_KEYS`, held by every live test file itself.
 *
 * Every arc self-skips without its key, and a skip looks like a pass in a
 * summary. The flag — a comma list of the credential NAMES a run promises, for
 * example `DEEPSEEK_API_KEY,ANTHROPIC_API_KEY` — turns that skip into a
 * failure. It used to be enforced by one test file of its own, and
 * `pnpm test:e2e <filter>` hands the filter to vitest as a FILE-NAME filter:
 * any arc run alone (which is how an ordinary session runs one) dropped that
 * file, so the flag was read by nothing and the arc skipped green with its key
 * missing. A file that skips on a key now registers the refusal itself.
 *
 * Unset, the flag does nothing: it is a person's promise, never a default.
 * It reads the environment and calls no one.
 */
import { describe, expect, it } from 'vitest'

/** Which arcs each key gates, for a failure that says what would not have run. */
export const KEY_GATES = {
  DEEPSEEK_API_KEY: 'every arc, and the DeepSeek drift probe',
  ANTHROPIC_API_KEY: 'the routing arc (S6) and the Anthropic drift probe',
  OPENAI_API_KEY: "the routing arc's OpenAI leg (S18) and the OpenAI drift probe",
  TAVILY_API_KEY: 'the search arc (S18)',
} as const satisfies Readonly<Record<string, string>>

export type KeyName = keyof typeof KEY_GATES

/** The names `MINIDSH_EXPECT_KEYS` lists, as written. */
export function promisedKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.MINIDSH_EXPECT_KEYS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
}

/**
 * What stops a file that needs `needs` from counting as run: each promised key
 * it needs that is unset, and each promised name that is no known credential
 * (a misspelt name promises nothing, and would otherwise be believed).
 */
export function brokenPromises(needs: readonly KeyName[], env: NodeJS.ProcessEnv = process.env): string[] {
  const promised = promisedKeys(env)
  const unknown = promised.filter((name) => !(name in KEY_GATES))
  return [
    ...(unknown.length === 0 ? [] : [`MINIDSH_EXPECT_KEYS names ${unknown.join(', ')}; known: ${Object.keys(KEY_GATES).join(', ')}`]),
    ...needs.filter((name) => promised.includes(name) && (env[name] ?? '').trim().length === 0).map((name) => `${name} is promised by MINIDSH_EXPECT_KEYS and unset: ${KEY_GATES[name]} would self-skip`),
  ]
}

/**
 * Call once at the top of a live test file, with every key one of its suites
 * skips on. When the run promised one of them and it is absent, the FILE
 * fails — in a suite of its own, beside the suites that skipped.
 */
export function expectKeys(file: string, needs: readonly KeyName[]): void {
  const broken = brokenPromises(needs)
  // Registered only when there is something to refuse: a suite that exists to
  // be skipped would put one more "skipped" in every summary, which is the
  // very thing a reader of one is asked to distrust.
  if (broken.length === 0) return
  describe(`${file}: a run that PROMISED its keys`, () => {
    it('has every key MINIDSH_EXPECT_KEYS promises this file, so it cannot pass by skipping', () => {
      expect.fail(broken.join('\n'))
    })
  })
}
