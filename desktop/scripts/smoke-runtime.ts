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
 *
 * "Every asset the page loads" is read off the PAGE: the served index.html's
 * own references, then the static imports of each script it reaches and what
 * each stylesheet pulls in, every one of them fetched from the running host.
 * That is the set a browser would ask for, so a file the packer dropped is a
 * 404 here whatever else the package still lists. (Fetching the package's own
 * listing instead, as this did, proved only that the host serves what is
 * there.) The listing is the second check: it must be that same set, so a
 * walk that under-read the page cannot pass by having asked for less.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { collectImports } from '../../scripts/deps-graph.ts'
import { choosePort, HandoffError, probePort, RuntimeProcess, signIn } from '../src/runtime.ts'

const resources = resolve(process.argv[2] ?? fail('usage: smoke-runtime.ts <resources directory>'))
// A per-user installer that never elevates ships no elevation helper.
if (existsSync(join(resources, 'elevate.exe'))) fail('the app ships resources/elevate.exe, an elevation helper nothing here uses (package.ts: nsis.packElevateHelper)')

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

/** A reference a served file makes, as the flat name this host serves it under; `undefined` for what is no file of the host's (a fragment, inline data, another origin). */
function assetName(reference: string, from: string): string | undefined {
  if (/^(#|data:|blob:|[a-z][a-z0-9+.-]*:)/i.test(reference)) return undefined
  const name = reference.replace(/[?#].*$/, '').replace(/^\.?\//, '')
  // The host serves one flat directory (`app/web.ts`): a nested path is a 404 in a browser.
  if (name.length === 0 || name.includes('/')) refuse(`${from} references "${reference}", which is not a flat asset the host serves`)
  return name
}

/**
 * What one served file makes a browser fetch next: the same reading
 * `src/app/web/assets.test.ts` gives the source tree (and the same import
 * extractor, so a JSDoc type import, which is a comment, is not a fetch).
 */
function referencesOf(name: string, text: string): string[] {
  const found: (string | undefined)[] = []
  if (name.endsWith('.html')) {
    for (const match of text.matchAll(/\s(?:src|href)\s*=\s*["']([^"']+)["']/gi)) found.push(assetName(match[1]!, name))
  } else if (name.endsWith('.js')) {
    for (const ref of collectImports(text)) if (!ref.typeOnly) found.push(assetName(ref.spec, name))
  } else if (name.endsWith('.css')) {
    for (const match of text.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)/g)) found.push(assetName(match[1]!, name))
    for (const match of text.matchAll(/url\(\s*["']?([^"')]+?)["']?\s*\)/g)) found.push(assetName(match[1]!, name))
  }
  return found.filter((one): one is string => one !== undefined)
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
let failure: string | undefined
try {
  const ready = await runtime.start({ node, bin, port, cwd: folder, folders: [folder], env, onStderr: (chunk) => stderr.push(chunk) })
  const version = (JSON.parse(readFileSync(join(resources, 'runtime', 'node_modules', 'minidsh', 'package.json'), 'utf8')) as { version: string }).version
  if (ready.version !== version) refuse(`the runtime reports ${ready.version}, its package ${version}`)
  const cookie = await signIn(ready.port, ready.token)
  // One-shot: the same token a second time is REFUSED, which is an answer
  // from the host saying no (app/web.ts answers 401). A timeout, a dropped
  // connection or a malformed answer is some other failure, and passes nothing.
  const again: unknown = await signIn(ready.port, ready.token).then(
    () => 'accepted',
    (error: unknown) => error,
  )
  if (again === 'accepted') refuse('the launch token was accepted twice')
  if (!(again instanceof HandoffError) || again.status === undefined || again.status < 400 || again.status >= 500) {
    refuse(`the second sign-in was not refused, it failed another way: ${again instanceof Error ? again.message : String(again)}`)
  }
  const origin = `http://127.0.0.1:${ready.port}`

  const index = await fetch(`${origin}/`, { headers: { cookie } })
  if (index.status !== 200) refuse(`GET / answered ${index.status}`)
  const html = await index.text()
  if (!html.includes('<title>MiniDSH</title>')) refuse('the page is not the Web UI')
  // Every asset, with the file that first asked for it: what a 404 must name.
  const loadedBy = new Map<string, string>([['index.html', 'the page itself']])
  const queue = ['index.html']
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    let text = html
    if (name !== 'index.html') {
      const answer = await fetch(`${origin}/${name}`, { headers: { cookie } })
      if (answer.status !== 200) refuse(`GET /${name} answered ${answer.status}: ${loadedBy.get(name)} loads it, and the package does not serve it`)
      text = await answer.text()
    }
    for (const next of referencesOf(name, text)) {
      if (loadedBy.has(next)) continue
      loadedBy.set(next, name)
      queue.push(next)
    }
  }
  const listed = readdirSync(join(resources, 'runtime', 'node_modules', 'minidsh', 'dist', 'app', 'web')).filter((name) => /\.(js|css|html)$/.test(name))
  const unreached = listed.filter((name) => !loadedBy.has(name))
  if (unreached.length > 0) refuse(`the package ships ${unreached.join(', ')}, which nothing the page loads reaches: the page was read short, or the package holds what it should not`)
  const unlisted = [...loadedBy.keys()].filter((name) => !listed.includes(name))
  if (unlisted.length > 0) refuse(`the host served ${unlisted.join(', ')}, which the package's own web directory does not list`)

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
  const done = `desktop smoke: runtime ${version} on the bundled node ${process.platform}-${process.arch}: ready, one-shot handoff (a second use answered ${again.status}), the ${loadedBy.size} assets the page loads, initialize, a leased session, graceful stop releasing it\n`
  // Written out before the exit below can cut it short.
  await new Promise<void>((written) => process.stdout.write(done, () => written()))
} catch (error) {
  failure = `${error instanceof Error ? error.message : String(error)}\n${Buffer.concat(stderr).toString().slice(-4000)}`
  // The runtime must be gone before its home can be: wait for the kill, to a bound.
  runtime.kill()
  await Promise.race([runtime.exited, new Promise((bound) => setTimeout(bound, 5_000))])
} finally {
  // After the catch, not instead of it: a failed run used to exit from inside
  // the catch, which skipped this and left both folders behind. A folder that
  // will not go is said, and never replaces the verdict above.
  for (const dir of [home, folder]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (error) {
      process.stderr.write(`desktop smoke: left ${dir} behind (${error instanceof Error ? error.message : String(error)})\n`)
    }
  }
}
if (failure !== undefined) fail(failure)
// Said, not left to the event loop: the stop's deadline is a timer nothing
// cancels, and this process sat out its thirty seconds after it had finished,
// on every leg.
process.exit(0)
