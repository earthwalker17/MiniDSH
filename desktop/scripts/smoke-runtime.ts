/**
 * The packaged app's runtime, started the way the app starts it, with no
 * window: the bundled Node runs the bundled CLI's `web --json` against a temp
 * MINIDSH_HOME and a temp folder, and this checks what the window would need.
 *
 *   node desktop/scripts/smoke-runtime.ts <the app's resources directory>
 *
 * Keyless and headless, so every CI leg runs it on what it packed: the
 * contract (`ready`, the one-shot handoff), every browser asset the page
 * loads, a WebSocket `initialize`, and a graceful stop (stdin's end) that
 * exits 0 and leaves no lease. It drives the app's own modules
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
  if (ready.version !== version) fail(`the runtime reports ${ready.version}, its package ${version}`)
  const cookie = await signIn(ready.port, ready.token)
  const origin = `http://127.0.0.1:${ready.port}`

  const index = await fetch(`${origin}/`, { headers: { cookie } })
  if (index.status !== 200) fail(`GET / answered ${index.status}`)
  const html = await index.text()
  const assets = readdirSync(join(resources, 'runtime', 'node_modules', 'minidsh', 'dist', 'app', 'web')).filter((name) => /\.(js|css|html)$/.test(name))
  for (const asset of assets) {
    const answer = await fetch(`${origin}/${asset}`, { headers: { cookie } })
    if (answer.status !== 200) fail(`GET /${asset} answered ${answer.status}`)
    await answer.arrayBuffer()
  }
  if (!html.includes('<title>MiniDSH</title>')) fail('the page is not the Web UI')

  const initialized = await new Promise<string>((resolveInit, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${ready.port}/ws`, { headers: { cookie } } as never)
    const timer = setTimeout(() => reject(new Error('no initialize answer within 15 s')), 15_000)
    socket.addEventListener('open', () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })))
    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as { id?: number; result?: { serverInfo?: { version?: string } } }
      if (frame.id !== 1) return
      clearTimeout(timer)
      socket.close()
      resolveInit(String(frame.result?.serverInfo?.version))
    })
    socket.addEventListener('error', () => reject(new Error('the WebSocket upgrade was refused')))
  })
  if (initialized !== version) fail(`initialize reports ${initialized}`)

  const stop = await runtime.stop({ deadlineMs: 30_000 })
  if (!stop.graceful) fail(`the stop was not graceful: ${JSON.stringify(stop)}`)
  const sessions = join(home, 'sessions')
  const locks = existsSync(sessions) ? readdirSync(sessions).filter((name) => name.endsWith('.lock')) : []
  if (locks.length > 0) fail(`leases left behind: ${locks.join(', ')}`)
  process.stdout.write(`desktop smoke: runtime ${version} on the bundled node ${process.platform}-${process.arch}: ready, handoff, ${assets.length} assets, initialize, graceful stop\n`)
} catch (error) {
  runtime.kill()
  fail(`${error instanceof Error ? error.message : String(error)}\n${Buffer.concat(stderr).toString().slice(-4000)}`)
} finally {
  rmSync(home, { recursive: true, force: true })
  rmSync(folder, { recursive: true, force: true })
}
