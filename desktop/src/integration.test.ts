/**
 * The desktop's Electron-free modules against the REAL runtime contract: the
 * checkout's CLI (`bin/minidsh.js`, TypeScript on this Node) where the app
 * runs the bundled one. Keyless — nothing here calls a model — and hermetic:
 * a temp MINIDSH_HOME, a temp workspace, provider keys removed from the
 * child's environment so `credentials list` cannot read this host's.
 *
 * What it pins, end to end: `runtimeArgv` is a command line `web` accepts;
 * `start` resolves on the real `ready`; `signIn` spends the real token for the
 * real cookie, and a second exchange is refused; `inspectRuntime` reads a real
 * `control/subscribe` (idle: not busy, not unknown); the credentials round
 * trip goes through the runtime's own writer; `stop` ends stdin and the
 * runtime exits 0 with no lease left.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listCredentials, setCredential } from './credentials.ts'
import { inspectRuntime } from './inspect.ts'
import { choosePort, probePort, RuntimeProcess, signIn } from './runtime.ts'

const BIN = join(import.meta.dirname, '..', '..', 'bin', 'minidsh.js')
const KEYS = ['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'TAVILY_API_KEY']

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const undo of cleanup.splice(0).toReversed()) await undo()
})

const scratch = (prefix: string): string => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function hermeticEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, MINIDSH_HOME: home }
  for (const key of KEYS) delete env[key]
  return env
}

async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = choosePort()
    if (await probePort(port)) return port
  }
  throw new Error('no free port in the desktop range')
}

describe('the desktop against the real runtime contract', () => {
  it('starts, hands off, inspects and stops the checkout CLI', { timeout: 120_000 }, async () => {
    const home = scratch('minidsh-desktop-home-')
    const folder = scratch('minidsh-desktop-ws-')
    const port = await freePort()
    const runtime = new RuntimeProcess()
    cleanup.push(() => runtime.kill())
    const stderr: Buffer[] = []
    const ready = await runtime.start({ node: process.execPath, bin: BIN, port, cwd: folder, folders: [folder], env: hermeticEnv(home), onStderr: (chunk) => stderr.push(chunk) })
    expect(ready.port, Buffer.concat(stderr).toString()).toBe(port)
    expect(ready.home).toBe(home)
    expect(ready.workspaces.map((workspace) => workspace.root)).toEqual([folder])

    const cookie = await signIn(ready.port, ready.token)
    expect(cookie).toMatch(/^minidsh_session=[A-Za-z0-9_.-]+$/)
    // One-shot: the same token a second time is REFUSED, an answer from the
    // host (401) and not a failure to reach it, so a page that saw the token
    // could not use it.
    await expect(signIn(ready.port, ready.token)).rejects.toMatchObject({ name: 'HandoffError', status: 401 })

    const page = await fetch(`http://127.0.0.1:${ready.port}/`, { headers: { cookie } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<title>MiniDSH</title>')

    const activity = await inspectRuntime({ port: ready.port, cookie })
    expect(activity).toEqual({ busy: false, unknown: false, running: 0, jobs: 0, approvals: 0 })
    // A wrong cookie is no answer, and no answer is BUSY: the quit then asks.
    expect(await inspectRuntime({ port: ready.port, cookie: 'minidsh_session=forged' })).toMatchObject({ busy: true, unknown: true })

    const result = await runtime.stop({ deadlineMs: 30_000 })
    expect(result, Buffer.concat(stderr).toString()).toEqual({ graceful: true, killed: false })
    const end = await runtime.exited
    expect(end).toMatchObject({ code: 0, requested: true })
    const sessions = join(home, 'sessions')
    const locks = existsSync(sessions) ? readdirSync(sessions).filter((name) => name.endsWith('.lock')) : []
    expect(locks).toEqual([])
  })

  it('lists, saves and re-lists a provider key through the runtime\'s own writer, never echoing it', { timeout: 120_000 }, async () => {
    const home = scratch('minidsh-desktop-keys-')
    mkdirSync(home, { recursive: true })
    const cli = { node: process.execPath, bin: BIN, env: hermeticEnv(home), cwd: home }
    const before = await listCredentials(cli)
    expect(before.ok).toBe(true)
    if (!before.ok) return
    expect(before.list.store).toBe(join(home, 'credentials.json'))
    expect(before.list.refs.find((ref) => ref.name === 'DEEPSEEK_API_KEY')?.source).toBe('absent')

    const secret = 'sk-desktop-integration-0123456789'
    expect(await setCredential({ ...cli, name: 'DEEPSEEK_API_KEY', value: secret })).toEqual({ ok: true })
    expect(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8'))).toEqual({ DEEPSEEK_API_KEY: secret })
    const after = await listCredentials(cli)
    expect(after.ok && after.list.refs.find((ref) => ref.name === 'DEEPSEEK_API_KEY')?.source).toBe('store')
    expect(JSON.stringify(after)).not.toContain(secret)

    // A value the runtime refuses (a space inside) never reaches the store.
    const refused = await setCredential({ ...cli, name: 'DEEPSEEK_API_KEY', value: 'two words' })
    expect(refused.ok).toBe(false)
    expect(JSON.stringify(refused)).not.toContain('two words')
    expect(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8'))).toEqual({ DEEPSEEK_API_KEY: secret })
  })
})
