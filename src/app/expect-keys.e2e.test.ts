/**
 * The live suite's own premise: the keys it was promised are present.
 *
 * Every arc self-skips without its key, so `pnpm test:e2e` with no key at all
 * is green having run nothing — and the routing, OpenAI and search legs skip
 * on keys of their own even when DeepSeek's is set. A skip and a pass look
 * the same in a summary. `MINIDSH_EXPECT_KEYS` turns that into a refusal: a
 * comma list of the credential NAMES a run promises (for example
 * `DEEPSEEK_API_KEY,ANTHROPIC_API_KEY`), each of which must be set, or this
 * file fails and names the arcs that would have skipped. Unset, it passes:
 * the flag is a person's promise, never a default.
 *
 * Always on, and costs nothing: it reads the environment and calls no one.
 */
import { describe, expect, it } from 'vitest'

/** Which arcs each key gates (their `describe.skipIf`), for a failure that says what would not have run. */
const GATES: Readonly<Record<string, string>> = {
  DEEPSEEK_API_KEY: 'every arc, and the DeepSeek drift probe',
  ANTHROPIC_API_KEY: 'the routing arc (S6) and the Anthropic drift probe',
  OPENAI_API_KEY: 'the routing arc\'s OpenAI leg (S18) and the OpenAI drift probe',
  TAVILY_API_KEY: 'the search arc (S18)',
}

const promised = (process.env.MINIDSH_EXPECT_KEYS ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name.length > 0)

describe('the live suite\'s promised keys', () => {
  it('names only credentials it knows', () => {
    const unknown = promised.filter((name) => GATES[name] === undefined)
    expect(unknown, `MINIDSH_EXPECT_KEYS names ${unknown.join(', ')}; known: ${Object.keys(GATES).join(', ')}`).toEqual([])
  })

  it('has every key MINIDSH_EXPECT_KEYS promises, so no arc it gates can pass by skipping', () => {
    const missing = promised.filter((name) => (process.env[name] ?? '').trim().length === 0)
    expect(missing, missing.map((name) => `${name} is unset: ${GATES[name] ?? 'its arcs'} would self-skip`).join('\n')).toEqual([])
  })
})
