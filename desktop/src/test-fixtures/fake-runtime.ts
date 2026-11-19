/**
 * A stand-in for `minidsh web --json`, spawned by `runtime.test.ts` with the
 * real `child_process`. Its argv is the pinned `runtimeArgv`, so what it does
 * comes from `FAKE_RUNTIME`: comma-separated steps run in order.
 *
 *   argv            stderr: one JSON line of its argv and cwd
 *   ready           stdout: a valid ready record for the --port it was given
 *   ready-port      … naming the wrong port          ready-host   … a non-loopback host
 *   ready-badtoken  … with a token outside the charset
 *   error           stdout: an EADDRINUSE error record
 *   noise           stdout: non-JSON, an unknown type, a JSON array
 *   split           a ready record in byte pieces, a UTF-8 character cut in two
 *   crlf            a ready record ended by CRLF
 *   long            a 2 MiB line, then a newline
 *   stderr:N        N bytes to stderr, ending in "END"
 *   sleep:MS        wait
 *   exit:N          exit with code N
 *   stdin-exit:N    exit with code N when stdin ends
 *   hang            stay alive whatever happens to stdin
 */
import { setTimeout as sleep } from 'node:timers/promises'

const argv = process.argv.slice(2)
const port = Number(argv[argv.indexOf('--port') + 1])

const write = (stream: NodeJS.WriteStream, data: string | Buffer): Promise<void> => new Promise((resolve) => stream.write(data, () => resolve()))

const ready = (overrides: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ type: 'ready', host: '127.0.0.1', port, token: 'tok_EN-123', version: '1.2.0', home: '/home/zoë/.minidsh', workspaces: [{ id: 'w1', name: 'proj', root: process.cwd() }], ...overrides })}\n`

for (const step of (process.env.FAKE_RUNTIME ?? '').split(',').filter((each) => each.length > 0)) {
  const [name, arg] = step.split(':')
  switch (name) {
    case 'argv':
      await write(process.stderr, `${JSON.stringify({ argv, cwd: process.cwd() })}\n`)
      break
    case 'ready':
      await write(process.stdout, ready())
      break
    case 'ready-port':
      await write(process.stdout, ready({ port: port + 1 }))
      break
    case 'ready-host':
      await write(process.stdout, ready({ host: '0.0.0.0' }))
      break
    case 'ready-badtoken':
      await write(process.stdout, ready({ token: 'has space' }))
      break
    case 'error':
      await write(process.stdout, `${JSON.stringify({ type: 'error', code: 'EADDRINUSE', message: `port ${port} is in use` })}\n`)
      break
    case 'noise':
      await write(process.stdout, 'starting…\n{"type":"progress","n":1}\n[1,2]\n')
      break
    case 'split': {
      const bytes = Buffer.from(ready(), 'utf8')
      // Inside the two-byte "ë": the decoder must carry its first byte over.
      const cut = bytes.indexOf(Buffer.from('ë', 'utf8')) + 1
      for (const piece of [bytes.subarray(0, 7), bytes.subarray(7, cut), bytes.subarray(cut)]) {
        await write(process.stdout, piece)
        await sleep(30)
      }
      break
    }
    case 'crlf':
      await write(process.stdout, ready().replace(/\n$/, '\r\n'))
      break
    case 'long':
      await write(process.stdout, `${'x'.repeat(2 * 1024 * 1024)}\n`)
      break
    case 'stderr':
      await write(process.stderr, `${'e'.repeat(Math.max(0, Number(arg) - 3))}END`)
      break
    case 'sleep':
      await sleep(Number(arg))
      break
    case 'exit':
      process.exit(Number(arg))
      break
    case 'stdin-exit':
      process.stdin.on('end', () => process.exit(Number(arg)))
      process.stdin.resume()
      break
    case 'hang':
      process.stdin.resume()
      setInterval(() => undefined, 60_000)
      break
    default:
      throw new Error(`fake-runtime: unknown step ${step}`)
  }
}
