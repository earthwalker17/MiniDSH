/**
 * A stand-in for `minidsh web --json` that also LISTENS, started by main.ts
 * itself in `main.test.ts` (as MINIDSH_DESKTOP_BIN). It keeps the real CLI's
 * ORDER, which is what the lifecycle under test depends on: the listener is
 * up before `ready` is printed; stdin is read only AFTER `ready` (cli.ts arms
 * its stop there, so a stdin that ended during the boot is noticed then); and
 * the end of stdin ends the process with code 0, the listener answering until
 * it does.
 *
 * A test decides WHEN each step happens through files in FAKE_WEB_DIR, so
 * nothing here is timed:
 *
 *   it writes     `started` (its pid, once it listens)
 *                 `signins` (one line per token exchange asked of it)
 *   it waits for  `release-ready` before printing `ready`, under `hold-ready`
 *
 * FAKE_WEB, comma-separated:
 *
 *   hold-ready           do not print `ready` until `release-ready` exists
 *   hold-signin:drop     hold the token exchange until stdin ends, then exit
 *                        without answering it (a host that closed first)
 *   hold-signin:answer   hold it until stdin ends, then answer it and exit
 *                        once the answer is written (a host that answered
 *                        while closing)
 *
 * With neither `hold-signin`, the exchange is answered at once, and any other
 * request is answered with a page.
 */
import { appendFileSync, existsSync, renameSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const argv = process.argv.slice(2)
const port = Number(argv[argv.indexOf('--port') + 1])
const dir = process.env.FAKE_WEB_DIR ?? ''
const steps = new Set((process.env.FAKE_WEB ?? '').split(',').filter((step) => step.length > 0))
if (dir === '') throw new Error('fake-web-runtime: FAKE_WEB_DIR is not set')

// A test that died must not leave this listening for ever.
setTimeout(() => process.exit(8), 120_000)

const accept = (response: ServerResponse): void => {
  response.writeHead(303, { location: '/', 'set-cookie': 'minidsh_session=fake-cookie; HttpOnly; SameSite=Strict; Path=/' })
  response.end()
}

/** The exchange being held, if any, under `hold-signin`. */
let held: ServerResponse | undefined

const server = createServer((request, response) => {
  if (new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.has('token')) {
    appendFileSync(join(dir, 'signins'), 'asked\n')
    if (steps.has('hold-signin:drop') || steps.has('hold-signin:answer')) held = response
    else accept(response)
    return
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<title>MiniDSH</title>')
})
await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))

// Whole or absent: the test reads the pid out of it.
writeFileSync(join(dir, 'started.tmp'), String(process.pid))
renameSync(join(dir, 'started.tmp'), join(dir, 'started'))

if (steps.has('hold-ready')) while (!existsSync(join(dir, 'release-ready'))) await sleep(15)

const record = { type: 'ready', host: '127.0.0.1', port, token: 'tok_FAKE-1', version: '0.0.0-fake', home: join(dir, 'home'), workspaces: [{ id: 'w1', name: 'ws', root: process.cwd() }] }
await new Promise<void>((resolve) => process.stdout.write(`${JSON.stringify(record)}\n`, () => resolve()))

process.stdin.on('end', () => {
  if (held !== undefined && steps.has('hold-signin:answer')) {
    // The answer must ARRIVE, so the connection is closed in order (an exit
    // with bytes still queued may reset it instead): once it is written, close
    // the listener and its idle connection, and leave when both are gone.
    held.on('finish', () => {
      server.close(() => process.exit(0))
      setImmediate(() => server.closeIdleConnections())
    })
    accept(held)
    return
  }
  if (held !== undefined) process.exit(0)
  // The real host keeps answering while it closes: it disposes its root
  // first and closes the listener after (web.ts). So does this, for a moment.
  // No test waits on that moment; it only decides what a main that wrongly
  // signs in to a closing host meets here: an answer, not a refused
  // connection, so the exchange it should never have asked for is on record.
  setTimeout(() => process.exit(0), 250)
})
process.stdin.resume()
