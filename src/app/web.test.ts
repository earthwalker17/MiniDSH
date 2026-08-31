/**
 * The web surface end to end over real HTTP and a real socket: the trust fence,
 * the static client, and a full attach/prompt/stream cycle driven the way the
 * browser client drives it.
 *
 * The fence is the point. This surface can write files and run commands, so the
 * cases that matter are the ones where someone reaches it WITHOUT the token, or
 * from another page.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Logger } from '../kernel/index.ts'
import { LLM } from '../core/llm/index.ts'
import { assistantText, ScriptedAdapter } from '../test-support/scripted-adapter.ts'
import { startWebHost, type WebHostHandle } from './web.ts'

const silent: Logger = { warn: () => {}, error: () => {} }
const SCRIPTED = { provider: 'scripted', model: 'scripted-model' }

let dirs: string[] = []
let hosts: WebHostHandle[] = []
let sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close()
  sockets = []
  for (const host of hosts.toReversed()) await host.dispose()
  hosts = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function web(...script: ReturnType<typeof assistantText>[]): Promise<{ host: WebHostHandle; origin: string; token: string }> {
  const adapter = new ScriptedAdapter().script(...(script.length > 0 ? script : [assistantText('hello from a browser')]))
  const host = await startWebHost({
    cwd: tempDir('minidsh-web-cwd-'),
    sessionsRoot: tempDir('minidsh-web-sessions-'),
    logger: silent,
    patches: [{ id: 'llm-deepseek', disabled: true }],
    prepare: (root) => {
      root.get(LLM).registerAdapter(root, adapter)
    },
  })
  hosts.push(host)
  return { host, origin: `http://127.0.0.1:${host.port}`, token: new URL(host.url).searchParams.get('token')! }
}

/** A raw request, so headers `fetch` refuses to forge (Host, Origin) can be set. */
function status(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: '/', method: 'GET', headers }, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    request.on('error', reject)
    request.end()
  })
}

/** The token-for-cookie exchange every browser does on the printed URL. */
async function signIn(origin: string, token: string): Promise<string> {
  const response = await fetch(`${origin}/?token=${token}`, { redirect: 'manual' })
  expect(response.status).toBe(303)
  const cookie = response.headers.getSetCookie()[0]!
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('SameSite=Strict')
  return cookie.split(';', 1)[0]!
}

describe('the web surface trust fence', () => {
  it('serves nothing without the cookie, and mints one only for the printed token', async () => {
    const { origin, token } = await web()
    expect((await fetch(`${origin}/`)).status).toBe(401)
    expect((await fetch(`${origin}/?token=wrong`, { redirect: 'manual' })).status).toBe(401)

    const cookie = await signIn(origin, token)
    const page = await fetch(`${origin}/`, { headers: { cookie } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('MiniDSH')
    expect((await fetch(`${origin}/app.js`, { headers: { cookie } })).status).toBe(200)
  })

  it('refuses a forged Host or a foreign Origin, before it looks at any credential', async () => {
    const { host, origin, token } = await web()
    const cookie = await signIn(origin, token)
    // `fetch` will not forge Host or Origin, so this speaks HTTP directly —
    // which is exactly what an attacker would do.
    expect(await status(host.port, { cookie, host: 'evil.example' })).toBe(403)
    expect(await status(host.port, { cookie, origin: 'http://evil.example' })).toBe(403)
    // The same request with this host's own authority still works.
    expect(await status(host.port, { cookie, origin: `http://127.0.0.1:${host.port}` })).toBe(200)
  })

  it('serves no path but its own flat assets', async () => {
    const { origin, token } = await web()
    const cookie = await signIn(origin, token)
    for (const path of ['/../package.json', '/nested/app.js', '/app.ts']) {
      expect((await fetch(`${origin}${path}`, { headers: { cookie } })).status).toBe(404)
    }
  })

  it('refuses the upgrade to a client that never signed in', async () => {
    const { host } = await web()
    const socket = new WebSocket(`ws://127.0.0.1:${host.port}/ws`)
    sockets.push(socket)
    const outcome = await new Promise<string>((resolve) => {
      socket.addEventListener('open', () => resolve('opened'), { once: true })
      socket.addEventListener('error', () => resolve('refused'), { once: true })
      socket.addEventListener('close', () => resolve('closed'), { once: true })
    })
    expect(outcome).not.toBe('opened')
  })
})

describe('the web surface, driven as a browser drives it', () => {
  it('attaches, prompts, streams, and reads its own durable log back', async () => {
    const { host, origin, token } = await web()
    const cookie = await signIn(origin, token)
    const socket = new WebSocket(`ws://127.0.0.1:${host.port}/ws`, { headers: { cookie } } as never)
    sockets.push(socket)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('the upgrade was refused')), { once: true })
    })

    const notifications: { method: string; params: Record<string, unknown> }[] = []
    const pending = new Map<number, (frame: Record<string, unknown>) => void>()
    let nextId = 1
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>
      if (typeof frame.method === 'string') notifications.push(frame as never)
      else {
        pending.get(frame.id as number)?.(frame)
        pending.delete(frame.id as number)
      }
    })
    const call = async <T>(method: string, params?: unknown): Promise<T> => {
      const id = nextId++
      const reply = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve))
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }))
      const frame = await reply
      if (frame.error) throw new Error((frame.error as { message: string }).message)
      return frame.result as T
    }

    const init = await call<{ serverInfo: { name: string }; workspaces: { id: string }[] }>('initialize')
    expect(init.serverInfo.name).toBe('minidsh')
    expect(init.workspaces).toHaveLength(1)

    const { sessionId } = await call<{ sessionId: string }>('session/prompt', { text: 'hi', agentOptions: SCRIPTED, workspaceId: init.workspaces[0]!.id })
    const deadline = Date.now() + 5000
    while (!notifications.some((one) => one.method === 'session.event' && (one.params.event as { type: string }).type === 'turn/end')) {
      if (Date.now() > deadline) throw new Error('the turn never ended')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    // The text streamed as chunks AND landed durably.
    expect(notifications.some((one) => (one.params.event as { type: string } | undefined)?.type === 'assistant/chunk')).toBe(true)
    const attached = await call<{ page: { events: { type: string }[] }; view: { status: string } }>('session/attach', { sessionId })
    expect(attached.page.events.some((event) => event.type === 'assistant/message')).toBe(true)
    expect(attached.view.status).toBe('idle')

    const listed = await call<{ sessions: { id: string; live: boolean }[] }>('sessions/list')
    expect(listed.sessions.map((one) => one.id)).toContain(sessionId)
  })
})
