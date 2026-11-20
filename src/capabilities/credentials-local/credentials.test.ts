/**
 * The credential seam: names travel, values do not. Environment beats the
 * store, blank is absent at every layer, and the store is re-read per call so
 * a rotation needs no reload.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { CREDENTIALS, credentialRef } from '../../core/credentials/index.ts'
import { LlmError } from '../../core/llm/index.ts'
import { DeepSeekAdapter } from '../llm-deepseek/adapter.ts'
import { credentialSources, credentialsLocalPlugin, updateCredentialStore } from './index.ts'

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

describe('the store writer (updateCredentialStore)', () => {
  function storePath(): string {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-cred-'))
    // A home that does not exist yet: the writer creates it.
    return join(dir, 'home', 'credentials.json')
  }

  it('writes exactly the key, atomically, owner-only on POSIX, and leaves no temporary behind', () => {
    const store = storePath()
    expect(updateCredentialStore(store, REF, 'v1')).toBe(true)
    expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual({ MINIDSH_TEST_SECRET: 'v1' })
    if (process.platform !== 'win32') expect((statSync(store).mode & 0o777).toString(8)).toBe('600')
    expect(readdirSync(dirname(store))).toEqual(['credentials.json'])
    // Another key is kept, in order, when one is replaced.
    writeFileSync(store, JSON.stringify({ OTHER_KEY: 'kept', MINIDSH_TEST_SECRET: 'v1' }))
    updateCredentialStore(store, REF, 'v2')
    expect(Object.entries(JSON.parse(readFileSync(store, 'utf8')))).toEqual([
      ['OTHER_KEY', 'kept'],
      ['MINIDSH_TEST_SECRET', 'v2'],
    ])
  })

  it('removes a key, and removing an absent one writes nothing', () => {
    const store = storePath()
    expect(updateCredentialStore(store, REF, undefined)).toBe(false)
    expect(existsSync(dirname(store))).toBe(false)
    mkdirSync(dirname(store))
    writeFileSync(store, JSON.stringify({ OTHER_KEY: 'kept', MINIDSH_TEST_SECRET: 'v1' }))
    expect(updateCredentialStore(store, REF, undefined)).toBe(true)
    expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual({ OTHER_KEY: 'kept' })
  })

  it('keeps a hand-written key named __proto__, which an ordinary object would silently drop', () => {
    const store = storePath()
    mkdirSync(dirname(store), { recursive: true })
    writeFileSync(store, '{"__proto__": "kept"}')
    updateCredentialStore(store, REF, 'v1')
    expect(readFileSync(store, 'utf8')).toContain('"__proto__": "kept"')
  })

  it('refuses a store it cannot read back exactly, leaves it byte for byte, and never quotes a value', () => {
    const store = storePath()
    mkdirSync(dirname(store), { recursive: true })
    for (const content of [`{ "MINIDSH_TEST_SECRET": 'sk-live-SECRETVALUE123' }`, '["sk-live-SECRETVALUE123"]', '{"MINIDSH_TEST_SECRET": 42}']) {
      writeFileSync(store, content)
      let message = ''
      try {
        updateCredentialStore(store, REF, 'new-value')
      } catch (error) {
        message = (error as Error).message
      }
      expect(message, `no refusal for ${content.slice(0, 2)}…`).toContain(store)
      expect(message).toMatch(/not rewritten/)
      expect(message).not.toContain('sk-live')
      expect(readFileSync(store, 'utf8')).toBe(content)
      expect(readdirSync(dirname(store))).toEqual(['credentials.json'])
    }
  })
})

describe('the source report (credentialSources)', () => {
  it('names the layer resolve would use, by the same rules, and the store problem once', () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-cred-'))
    const store = join(dir, 'credentials.json')
    const OTHER = credentialRef('MINIDSH_TEST_OTHER')
    expect(credentialSources(store, [REF, OTHER])).toEqual({ sources: [{ name: REF, source: 'absent' }, { name: OTHER, source: 'absent' }] })
    writeFileSync(store, JSON.stringify({ MINIDSH_TEST_SECRET: 'from-file', MINIDSH_TEST_OTHER: '  ' }))
    // A blank stored value is absent, exactly as resolve reads it.
    expect(credentialSources(store, [REF, OTHER]).sources).toEqual([{ name: REF, source: 'store' }, { name: OTHER, source: 'absent' }])
    process.env.MINIDSH_TEST_SECRET = 'from-env'
    expect(credentialSources(store, [REF]).sources).toEqual([{ name: REF, source: 'env' }])
    // A blank environment value falls through to the store.
    process.env.MINIDSH_TEST_SECRET = ' '
    expect(credentialSources(store, [REF]).sources).toEqual([{ name: REF, source: 'store' }])
    writeFileSync(store, `{ "MINIDSH_TEST_SECRET": 'sk-live-SECRETVALUE123' }`)
    const broken = credentialSources(store, [REF])
    expect(broken.sources).toEqual([{ name: REF, source: 'absent' }])
    expect(broken.problem).toMatch(/is not valid JSON/)
    expect(broken.problem).not.toContain('sk-live')
    // No store at all: the environment alone.
    expect(credentialSources(undefined, [REF]).sources).toEqual([{ name: REF, source: 'absent' }])
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

describe('the store writer under concurrency, links and odd names (S22.2 review)', () => {
  it('loses no key when four processes save at once: one read-modify-write at a time', { timeout: 60_000 }, async () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-cred-race-'))
    const store = join(dir, 'credentials.json')
    const module = new URL('./index.ts', import.meta.url).href
    const { spawn } = await import('node:child_process')
    const names = ['RACE_A', 'RACE_B', 'RACE_C', 'RACE_D']
    // A start barrier: every child has loaded the module and waits for `go`,
    // so the writes overlap instead of falling into each process's start-up jitter.
    const go = join(dir, 'go')
    const runs = names.map(
      (name) =>
        new Promise<number | null>((resolve) => {
          const script = [
            `const { updateCredentialStore } = await import(${JSON.stringify(module)})`,
            `const fs = await import('node:fs')`,
            `fs.writeFileSync(${JSON.stringify(join(dir as string, `ready-${name}`))}, '')`,
            `const pause = new Int32Array(new SharedArrayBuffer(4))`,
            `while (!fs.existsSync(${JSON.stringify(go)})) Atomics.wait(pause, 0, 0, 2)`,
            `for (let i = 0; i < 20; i++) updateCredentialStore(${JSON.stringify(store)}, ${JSON.stringify(name)}, 'value-' + i)`,
          ].join('\n')
          const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' })
          child.on('exit', (code) => resolve(code))
        }),
    )
    const until = Date.now() + 30_000
    while (names.some((name) => !existsSync(join(dir as string, `ready-${name}`))) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20))
    writeFileSync(go, '')
    expect(await Promise.all(runs)).toEqual([0, 0, 0, 0])
    const saved = JSON.parse(readFileSync(store, 'utf8')) as Record<string, string>
    expect(Object.keys(saved).toSorted(), JSON.stringify(saved)).toEqual(names)
    expect(Object.values(saved).every((value) => value === 'value-19')).toBe(true)
    expect(existsSync(`${store}.lock`)).toBe(false)
  })

  it('takes over a lock a crashed writer left, and writes through a symlinked store to its target', () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-cred-lock-'))
    const target = join(dir, 'dotfiles', 'credentials.json')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, '{ "KEPT": "k" }\n')
    const store = join(dir, 'credentials.json')
    let linked = true
    try {
      symlinkSync(target, store, 'file')
    } catch {
      linked = false
    }
    if (!linked) writeFileSync(store, '{ "KEPT": "k" }\n')
    const lockOf = linked ? `${target}.lock` : `${store}.lock`
    writeFileSync(lockOf, '')
    const old = new Date(Date.now() - 120_000)
    utimesSync(lockOf, old, old)
    expect(updateCredentialStore(store, REF, 'v')).toBe(true)
    if (linked) {
      // The link still names the target, and the target holds both keys.
      expect(lstatSync(store).isSymbolicLink()).toBe(true)
      expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ KEPT: 'k', MINIDSH_TEST_SECRET: 'v' })
    } else {
      expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual({ KEPT: 'k', MINIDSH_TEST_SECRET: 'v' })
    }
    expect(existsSync(lockOf)).toBe(false)
  })

  it('writes through a DANGLING store link to where it points, keeping the link (a dotfiles target not created yet)', (context) => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-cred-dangling-'))
    mkdirSync(join(dir, 'dotfiles'))
    const store = join(dir, 'home', 'credentials.json')
    mkdirSync(dirname(store))
    try {
      // Relative, through `..`: resolved from the link's own folder, as the OS does.
      symlinkSync(join('..', 'dotfiles', 'credentials.json'), store, 'file')
    } catch {
      context.skip('this host cannot create a symlink (Windows without Developer Mode)')
    }
    expect(updateCredentialStore(store, REF, 'v')).toBe(true)
    expect(lstatSync(store).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'dotfiles', 'credentials.json'), 'utf8'))).toEqual({ MINIDSH_TEST_SECRET: 'v' })
    expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual({ MINIDSH_TEST_SECRET: 'v' })
  })

  it('reads a reference named after an Object.prototype member as absent, never a crash', () => {
    dir = mkdtempSync(join(tmpdir(), 'minidsh-cred-proto-'))
    const store = join(dir, 'credentials.json')
    expect(credentialSources(store, [credentialRef('constructor'), credentialRef('toString')]).sources).toEqual([
      { name: 'constructor', source: 'absent' },
      { name: 'toString', source: 'absent' },
    ])
  })
})
