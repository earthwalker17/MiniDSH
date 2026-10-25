/**
 * The credential seam: names travel, values do not. Environment beats the
 * store, blank is absent at every layer, and the store is re-read per call so
 * a rotation needs no reload.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { CREDENTIALS, credentialRef } from '../../core/credentials/index.ts'
import { LlmError } from '../../core/llm/index.ts'
import { DeepSeekAdapter } from '../llm-deepseek/adapter.ts'
import { credentialsLocalPlugin } from './index.ts'

const silent: Logger = { warn: () => {}, error: () => {} }
const REF = credentialRef('MINIDSH_TEST_SECRET')

let dir: string | undefined
let root: Context | undefined

afterEach(async () => {
  await root?.dispose()
  root = undefined
  delete process.env.MINIDSH_TEST_SECRET
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dir = undefined
})

async function mountWithStore(): Promise<{ resolve: () => string | undefined; store: string }> {
  dir = mkdtempSync(join(tmpdir(), 'minidsh-cred-'))
  const store = join(dir, 'credentials.json')
  root = createRoot({ logger: silent })
  root.plugin(credentialsLocalPlugin, { path: store })
  await root.settle()
  const credentials = root.get(CREDENTIALS)
  return { resolve: () => credentials.resolve(REF), store }
}

describe('credentials-local', () => {
  it('reports a malformed store once instead of silently answering "not set"', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-cred-'))
    const store = join(dir, 'credentials.json')
    const warnings: string[] = []
    root = createRoot({ logger: { warn: (message) => void warnings.push(message), error: () => {} } })
    root.plugin(credentialsLocalPlugin, { path: store })
    await root.settle()
    const credentials = root.get(CREDENTIALS)
    // Missing is silent: it is the ordinary state of a fresh home.
    expect(credentials.resolve(REF)).toBeUndefined()
    expect(warnings).toEqual([])
    writeFileSync(store, '{"MINIDSH_TEST_SECRET": "s",}') // a trailing comma
    expect(credentials.resolve(REF)).toBeUndefined()
    expect(credentials.resolve(REF)).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/credentials store .* is not valid JSON/)
    writeFileSync(store, '{"MINIDSH_TEST_SECRET": "s"}')
    expect(credentials.resolve(REF)).toBe('s')
  })

  it('reports where a store is malformed and never what it says there: the parser quotes the text around the fault', async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-cred-'))
    const store = join(dir, 'credentials.json')
    const warn = async (content: string): Promise<string> => {
      const warnings: string[] = []
      const local = createRoot({ logger: { warn: (message) => void warnings.push(message), error: () => {} } })
      local.plugin(credentialsLocalPlugin, { path: store })
      await local.settle()
      writeFileSync(store, content)
      expect(local.get(CREDENTIALS).resolve(REF)).toBeUndefined()
      await local.dispose()
      expect(warnings).toHaveLength(1)
      return warnings[0]!
    }
    // A single-quoted value: V8's message quotes about ten characters around
    // the fault, which here is the head of the secret.
    const quoted = await warn(`{\n  "MINIDSH_TEST_SECRET": 'sk-live-SECRETVALUE123'\n}`)
    expect(quoted).toMatch(/is not valid JSON;/)
    expect(quoted).not.toContain('sk-live')
    // Where the parser names a position, the warning keeps it, and only it.
    const comma = await warn(`{\n  "MINIDSH_TEST_SECRET": "sk-live-SECRETVALUE123",\n}`)
    expect(comma).toMatch(/is not valid JSON at line 3, column 1;/)
    expect(comma).not.toContain('sk-live')
    // A root that parses but is no object is "not a JSON object", not a TypeError's words.
    expect(await warn('null')).toMatch(/is not a JSON object/)
    expect(await warn('["sk-live-SECRETVALUE123"]')).toMatch(/is not a JSON object/)
  })

  it('resolves env over file, and the file when env is unset or blank', async () => {
    const { resolve, store } = await mountWithStore()
    writeFileSync(store, JSON.stringify({ MINIDSH_TEST_SECRET: 'from-file' }))
    expect(resolve()).toBe('from-file')
    process.env.MINIDSH_TEST_SECRET = 'from-env'
    expect(resolve()).toBe('from-env')
    // Blank is absent, not configured-but-empty: it falls through to the file.
    process.env.MINIDSH_TEST_SECRET = '   '
    expect(resolve()).toBe('from-file')
  })

  it('re-reads the store per call, so a rotation takes effect without a reload', async () => {
    const { resolve, store } = await mountWithStore()
    writeFileSync(store, JSON.stringify({ MINIDSH_TEST_SECRET: 'v1' }))
    expect(resolve()).toBe('v1')
    writeFileSync(store, JSON.stringify({ MINIDSH_TEST_SECRET: 'v2' }))
    expect(resolve()).toBe('v2')
  })

  it('treats a missing, malformed, or blank-valued store as absent', async () => {
    const { resolve, store } = await mountWithStore()
    expect(resolve()).toBeUndefined() // no file
    writeFileSync(store, 'not json')
    expect(resolve()).toBeUndefined() // malformed
    writeFileSync(store, JSON.stringify({ MINIDSH_TEST_SECRET: '' }))
    expect(resolve()).toBeUndefined() // blank value
    writeFileSync(store, JSON.stringify({ MINIDSH_TEST_SECRET: 42 }))
    expect(resolve()).toBeUndefined() // non-string value
  })

  it('describes where a value would be looked for, naming the store only when it has one', async () => {
    const { store } = await mountWithStore()
    const withStore = root!.get(CREDENTIALS).describe(REF)
    expect(withStore).toContain('MINIDSH_TEST_SECRET environment variable')
    expect(withStore).toContain(store)
    await root!.dispose()
    // Environment-only resolution has no file to name, and must not invent one.
    root = createRoot({ logger: silent })
    root.plugin(credentialsLocalPlugin, {})
    await root.settle()
    const envOnly = root.get(CREDENTIALS).describe(REF)
    expect(envOnly).toContain('MINIDSH_TEST_SECRET environment variable')
    expect(envOnly).not.toContain('credentials.json')
  })

  it('refuses a reference that is not an environment-variable name', () => {
    expect(() => credentialRef('has space')).toThrow(/not an environment-variable name/)
    expect(() => credentialRef('')).toThrow(/not an environment-variable name/)
    expect(() => credentialRef('9LEADING')).toThrow(/not an environment-variable name/)
    expect(credentialRef('_OK_2')).toBe('_OK_2')
  })
})

describe('the deepseek consumer', () => {
  it('reports a missing key by its reference name, never a value', async () => {
    const adapter = new DeepSeekAdapter({
      apiKeyRef: 'MINIDSH_TEST_SECRET',
      resolveKey: () => undefined,
      baseURL: 'http://localhost:1',
      defaultMaxTokens: 16,
    })
    const request = { provider: 'deepseek', model: 'deepseek-v4-flash', system: '', messages: [], tools: [] }
    const first = adapter.stream(request as never)[Symbol.asyncIterator]()
    await expect(first.next()).rejects.toSatisfy((error: unknown) => {
      return error instanceof LlmError && error.code === 'MISSING_CREDENTIAL' && /MINIDSH_TEST_SECRET/.test(error.message)
    })
  })

  it('names BOTH places a key may go when the store can say — the first failure a fresh install meets', async () => {
    const { store } = await mountWithStore()
    const credentials = root!.get(CREDENTIALS)
    const adapter = new DeepSeekAdapter({
      apiKeyRef: REF,
      resolveKey: () => credentials.resolve(REF),
      describeKey: () => credentials.describe(REF),
      baseURL: 'http://localhost:1',
      defaultMaxTokens: 16,
    })
    const request = { provider: 'deepseek', model: 'deepseek-v4-flash', system: '', messages: [], tools: [] }
    const first = adapter.stream(request as never)[Symbol.asyncIterator]()
    await expect(first.next()).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof LlmError) || error.code !== 'MISSING_CREDENTIAL') return false
      return error.message.includes('MINIDSH_TEST_SECRET environment variable') && error.message.includes(store)
    })
  })
})
