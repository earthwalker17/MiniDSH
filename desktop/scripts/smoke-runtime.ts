/**
 * The packaged app's runtime, started the way the app starts it, with no
 * window: the bundled Node runs the bundled CLI's `web --json` against a temp
 * MINIDSH_HOME and a temp folder, and this checks what the window would need.
 *
 *   node desktop/scripts/smoke-runtime.ts <the app's resources directory>
 *
 * Keyless and headless, so every CI leg runs it on what it packed: the
 * contract (`ready`, the handoff, and the token refused a second time), every
 * browser asset the page loads, a WebSocket `initialize`, a session prompted
 * into being (its turn fails at once with no key, but the session holds its
 * lease, which the smoke sees), and a graceful stop (stdin's end) that exits
 * 0 and releases that lease. It drives the app's own modules
 * (`desktop/src/runtime.ts`), so the smoke and the app cannot disagree on
 * the contract.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { choosePort, probePort, RuntimeProcess, signIn } from '../src/runtime.ts'

const resources = resolve(process.argv[2] ?? fail('usage: smoke-runtime.ts <resources directory>'))

function fail(message: string): never {
  process.stderr.write(`desktop smoke: ${message}\n`)
  process.exit(1)
}

/**
 * A failed check once the runtime is up. It THROWS, so the catch below kills
 * the runtime before the process exits: an exit from inside the try would skip
 * that and leave `minidsh web` running on a developer's machine (S22.5).
 */
function refuse(message: string): never {
  throw new Error(message)
}

const node = process.platform === 'win32' ? join(resources, 'node', 'node.exe') : join(resources, 'node', 'bin', 'node')
const bin = join(resources, 'runtime', 'node_modules', 'minidsh', 'bin', 'minidsh.js')
for (const required of [node, bin]) if (!existsSync(required)) fail(`the package lacks ${required}`)

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'minidsh-smoke-home-')))
const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'minidsh-smoke-ws-')))
const env: NodeJS.ProcessEnv = { ...process.env, MINIDSH_HOME: home }
for (const key of ['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'TAVILY_API_KEY']) delete env[key]

let port = choosePort()
for (let attempt = 0; attempt < 20 && !(await probePort(port)); attempt++) port = choosePort()
const runtime = new RuntimeProcess()
const stderr: Buffer[] = []
try {
  const ready = await runtime.start({ node, bin, port, cwd: folder, folders: [folder], env, onStderr: (chunk) => stderr.push(chunk) })
  const version = (JSON.parse(readFileSync(join(resources, 'runtime', 'node_modules', 'minidsh', 'package.json'), 'utf8')) as { version: string }).version
  if (ready.version !== version) refuse(`the runtime reports ${ready.version}, its package ${version}`)
  const cookie = await signIn(ready.port, ready.token)
  // One-shot: the same token a second time is refused.
  const reused = await signIn(ready.port, ready.token).then(
    () => true,
    () => false,
  )
  if (reused) refuse('the launch token was accepted twice')
  const origin = `http://127.0.0.1:${ready.port}`

  const index = await fetch(`${origin}/`, { headers: { cookie } })
  if (index.status !== 200) refuse(`GET / answered ${index.status}`)
  const html = await index.text()
  const assets = readdirSync(join(resources, 'runtime', 'node_modules', 'minidsh', 'dist', 'app', 'web')).filter((name) => /\.(js|css|html)$/.test(name))
  // The page loads about twenty files; a listing that came back empty would
  // make the loop below prove nothing.
  if (assets.length < 10) refuse(`only ${assets.length} browser assets in the package`)
  for (const asset of assets) {
    const answer = await fetch(`${origin}/${asset}`, { headers: { cookie } })
    if (answer.status !== 200) refuse(`GET /${asset} answered ${answer.status}`)
    await answer.arrayBuffer()
  }
  if (!html.includes('<title>MiniDSH</title>')) refuse('the page is not the Web UI')

  // initialize, then a prompt that creates a session (no key: its turn fails
  // at once, which is fine — the session exists and holds its lease).
  const { initialized, sessionId } = await new Promise<{ initialized: string; sessionId: string }>((resolveWire, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${ready.port}/ws`, { headers: { cookie } } as never)
    const timer = setTimeout(() => reject(new Error('no initialize and prompt answers within 30 s')), 30_000)
    let initializedVersion = ''
    socket.addEventListener('open', () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })))
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as { id?: number; result?: { serverInfo?: { version?: string }; sessionId?: string }; error?: { message?: string } }
      if (frame.error !== undefined) {
        clearTimeout(timer)
        reject(new Error(`the wire refused request ${String(frame.id)}: ${frame.error.message ?? ''}`))
      } else if (frame.id === 1) {
        initializedVersion = String(frame.result?.serverInfo?.version)
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { text: 'smoke' } }))
      } else if (frame.id === 2) {
        clearTimeout(timer)
        socket.close()
        resolveWire({ initialized: initializedVersion, sessionId: String(frame.result?.sessionId) })
      }
    })
    socket.addEventListener('error', () => reject(new Error('the WebSocket upgrade was refused')))
  })
  if (initialized !== version) refuse(`initialize reports ${initialized}`)
  const lease = join(home, 'sessions', `${encodeURIComponent(sessionId)}.jsonl.lock`)
  const leaseDeadline = Date.now() + 10_000
  while (!existsSync(lease) && Date.now() < leaseDeadline) await new Promise((wait) => setTimeout(wait, 100))
  if (!existsSync(lease)) refuse(`the prompted session ${sessionId} holds no lease at ${lease}: the stop below would prove nothing`)

  const stop = await runtime.stop({ deadlineMs: 30_000 })
  if (!stop.graceful) refuse(`the stop was not graceful: ${JSON.stringify(stop)}`)
  const sessions = join(home, 'sessions')
  const locks = existsSync(sessions) ? readdirSync(sessions).filter((name) => name.endsWith('.lock')) : []
  if (locks.length > 0) refuse(`leases left behind: ${locks.join(', ')}`)
  process.stdout.write(`desktop smoke: runtime ${version} on the bundled node ${process.platform}-${process.arch}: ready, one-shot handoff, ${assets.length} assets, initialize, a leased session, graceful stop releasing it\n`)
} catch (error) {
  runtime.kill()
  fail(`${error instanceof Error ? error.message : String(error)}\n${Buffer.concat(stderr).toString().slice(-4000)}`)
} finally {
  rmSync(home, { recursive: true, force: true })
  rmSync(folder, { recursive: true, force: true })
}
