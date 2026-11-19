import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isCredentialName, listCredentials, parseCredentialList, setCredential, type CliOptions } from './credentials.ts'
import type { SpawnLike } from './runtime.ts'

const FAKE = join(import.meta.dirname, 'test-fixtures', 'fake-cli.ts')

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The fake CLI in `mode`, with a spawn that records what it was asked to run. */
function cli(mode: string, extra: Partial<CliOptions> = {}): { options: CliOptions; out: string; spawned: { command: string; args: readonly string[] }[] } {
  const dir = mkdtempSync(join(tmpdir(), 'minidsh-desktop-credentials-'))
  dirs.push(dir)
  const out = join(dir, 'out.json')
  const spawned: { command: string; args: readonly string[] }[] = []
  const spawnImpl: SpawnLike = (command, args, options) => {
    spawned.push({ command, args })
    return spawn(command, args, options)
  }
  return { options: { node: process.execPath, bin: FAKE, env: { ...process.env, FAKE_CLI: mode, FAKE_CLI_OUT: out }, spawnImpl, ...extra }, out, spawned }
}

const KEY = 'sk-test-0123456789abcdef'

describe('provider keys through the CLI', () => {
  it('lists the declared refs and their sources, never a value', async () => {
    const { options, spawned } = cli('list')
    expect(await listCredentials(options)).toEqual({
      ok: true,
      list: {
        home: '/home/x/.minidsh',
        store: '/home/x/.minidsh/credentials.json',
        refs: [
          { name: 'DEEPSEEK_API_KEY', source: 'store' },
          { name: 'ANTHROPIC_API_KEY', source: 'env' },
          { name: 'OPENAI_API_KEY', source: 'absent' },
        ],
      },
    })
    expect(spawned).toEqual([{ command: process.execPath, args: [FAKE, 'credentials', 'list', '--json'] }])
  })

  it('refuses a list it cannot read, a failing CLI with its last line, and a flood', async () => {
    expect(await listCredentials(cli('list-junk').options)).toEqual({ ok: false, reason: 'the credentials list was not understood' })
    expect(await listCredentials(cli('fail').options)).toEqual({ ok: false, reason: 'minidsh credentials list failed (exit 2): minidsh credentials: the store at /x/credentials.json cannot be parsed' })
    expect(await listCredentials(cli('flood').options)).toEqual({ ok: false, reason: 'the runtime wrote more than any answer holds' })
  })

  it('is bounded: a CLI that never answers is killed at the deadline', async () => {
    const started = Date.now()
    expect(await listCredentials(cli('hang', { timeoutMs: 300 }).options)).toEqual({ ok: false, reason: 'the runtime did not answer in time' })
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('says so when the runtime cannot be run at all', async () => {
    const result = await listCredentials(cli('list', { node: join(tmpdir(), 'no-such-node-binary') }).options)
    expect(result).toEqual({ ok: false, reason: 'could not run the runtime (ENOENT)' })
  })

  it('sets a key through stdin alone: not in argv, not in the environment', async () => {
    const { options, out, spawned } = cli('set')
    expect(await setCredential({ ...options, name: 'DEEPSEEK_API_KEY', value: KEY })).toEqual({ ok: true })
    const seen = JSON.parse(readFileSync(out, 'utf8')) as { argv: string[]; stdin: string; inEnv: boolean }
    expect(seen).toEqual({ argv: ['credentials', 'set', 'DEEPSEEK_API_KEY'], stdin: KEY, inEnv: false })
    expect(JSON.stringify(spawned)).not.toContain(KEY)
  })

  it('validates the name and the value before spawning anything', async () => {
    for (const name of ['', '1KEY', 'KEY-NAME', 'KEY NAME', '--approve', 'A'.repeat(129), 'KEY;rm']) {
      const { options, spawned } = cli('set')
      expect(await setCredential({ ...options, name, value: KEY })).toEqual({ ok: false, reason: 'That is not a valid key name.' })
      expect(spawned).toEqual([])
    }
    for (const value of ['', '   ', `${KEY}\n`, `a\rb`, `a\u0000b`, `a\u001bb`]) {
      const { options, spawned } = cli('set')
      expect(await setCredential({ ...options, name: 'DEEPSEEK_API_KEY', value })).toMatchObject({ ok: false })
      expect(spawned).toEqual([])
    }
    expect(['DEEPSEEK_API_KEY', '_X', 'a1'].every(isCredentialName)).toBe(true)
  })

  it('never repeats the value in a failure, even when the CLI quotes it', async () => {
    const result = await setCredential({ ...cli('set-leak').options, name: 'DEEPSEEK_API_KEY', value: KEY })
    expect(result).toEqual({ ok: false, reason: 'minidsh credentials set failed (exit 1): refusing value [redacted] for DEEPSEEK_API_KEY' })
  })

  it('reads only the documented list shape', () => {
    expect(parseCredentialList(JSON.stringify({ home: 'h', store: 's', refs: [] }))).toEqual({ home: 'h', store: 's', refs: [] })
    for (const bad of [
      { home: 'h', store: 's', refs: [{ name: 'X', source: 'keychain' }] },
      { home: 'h', store: 's', refs: [{ name: 'bad name', source: 'env' }] },
      { home: 'h', refs: [] },
      { home: 'h', store: 's', refs: {} },
      [],
    ]) {
      expect(parseCredentialList(JSON.stringify(bad))).toBeUndefined()
    }
  })
})
