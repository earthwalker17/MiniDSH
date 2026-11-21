/**
 * The live suite's own premise: the keys it was promised are present.
 *
 * Every arc self-skips without its key, so `pnpm test:e2e` with no key at all
 * is green having run nothing — and the routing, OpenAI and search legs skip
 * on keys of their own even when DeepSeek's is set. A skip and a pass look
 * the same in a summary. `MINIDSH_EXPECT_KEYS` turns that into a refusal: a
 * comma list of the credential NAMES a run promises (for example
 * `DEEPSEEK_API_KEY,ANTHROPIC_API_KEY`), each of which must be set, or the
 * arcs it gates fail. Unset, it passes: the flag is a person's promise, never
 * a default.
 *
 * The refusal itself is `test-support/expect-keys.ts`, and EVERY live file
 * registers it (`expectKeys`): a run filtered to one arc's file name never
 * loads this file. This file is the whole promise read in one place — every
 * promised name, whichever arc needs it — and the rule's own test, with a
 * stated environment in place of this run's.
 *
 * Always on, and costs nothing: it reads the environment and calls no one.
 */
import { describe, expect, it } from 'vitest'
import { brokenPromises, KEY_GATES, promisedKeys, type KeyName } from '../test-support/expect-keys.ts'

const EVERY_KEY = Object.keys(KEY_GATES) as KeyName[]

describe('the live suite\'s promised keys', () => {
  it('names only credentials it knows, and has every key MINIDSH_EXPECT_KEYS promises, so no arc it gates can pass by skipping', () => {
    expect(brokenPromises(EVERY_KEY), `MINIDSH_EXPECT_KEYS=${promisedKeys().join(',')}`).toEqual([])
  })
})

describe('the rule every live file holds (expectKeys)', () => {
  const set = { DEEPSEEK_API_KEY: 'sk-set' }

  it('is silent when nothing is promised, whatever is missing', () => {
    expect(brokenPromises(EVERY_KEY, {})).toEqual([])
    expect(brokenPromises(EVERY_KEY, { MINIDSH_EXPECT_KEYS: ' , ' })).toEqual([])
  })

  it('refuses a promised key that is unset or blank, naming the arcs that would have skipped', () => {
    const env = { ...set, MINIDSH_EXPECT_KEYS: 'DEEPSEEK_API_KEY, TAVILY_API_KEY', TAVILY_API_KEY: '  ' }
    expect(brokenPromises(['DEEPSEEK_API_KEY', 'TAVILY_API_KEY'], env)).toEqual(['TAVILY_API_KEY is promised by MINIDSH_EXPECT_KEYS and unset: the search arc (S18) would self-skip'])
  })

  it('holds a file only to the keys IT needs: a promise about another arc\'s key is that arc\'s to fail', () => {
    const env = { ...set, MINIDSH_EXPECT_KEYS: 'DEEPSEEK_API_KEY,TAVILY_API_KEY' }
    expect(brokenPromises(['DEEPSEEK_API_KEY'], env)).toEqual([])
    expect(brokenPromises(['TAVILY_API_KEY'], env)).toHaveLength(1)
  })

  it('does not hold a file to a key nobody promised', () => {
    expect(brokenPromises(['DEEPSEEK_API_KEY', 'OPENAI_API_KEY'], { ...set, MINIDSH_EXPECT_KEYS: 'DEEPSEEK_API_KEY' })).toEqual([])
  })

  it('refuses a promised name that is no known credential, in every file: a misspelt promise is believed by nobody', () => {
    const env = { ...set, MINIDSH_EXPECT_KEYS: 'DEEPSEEK_API_KEY,DEEPSEEK_KEY' }
    expect(brokenPromises(['DEEPSEEK_API_KEY'], env)).toEqual([`MINIDSH_EXPECT_KEYS names DEEPSEEK_KEY; known: ${EVERY_KEY.join(', ')}`])
  })
})
