/**
 * A stand-in for `minidsh credentials …`, spawned by `credentials.test.ts`.
 * `FAKE_CLI` picks the behaviour; `set` reports what reached it — argv, stdin
 * and whether the value is anywhere in its environment — to `FAKE_CLI_OUT`.
 *
 *   list       a valid `list --json` answer     list-junk   not JSON
 *   fail       a one-line error on stderr, exit 2
 *   flood      more stdout than any answer      hang        never exits
 *   set        read stdin to its end, report, exit 0
 *   set-leak   read stdin, then fail quoting the value on stderr
 */
import { writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const mode = process.env.FAKE_CLI ?? ''

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

const write = (stream: NodeJS.WriteStream, data: string): Promise<void> => new Promise((resolve) => stream.write(data, () => resolve()))

switch (mode) {
  case 'list':
    await write(
      process.stdout,
      JSON.stringify({
        home: '/home/x/.minidsh',
        store: '/home/x/.minidsh/credentials.json',
        refs: [
          { name: 'DEEPSEEK_API_KEY', source: 'store' },
          { name: 'ANTHROPIC_API_KEY', source: 'env' },
          { name: 'OPENAI_API_KEY', source: 'absent' },
        ],
        argv,
      }),
    )
    break
  case 'list-junk':
    await write(process.stdout, 'not json')
    break
  case 'fail':
    await write(process.stderr, 'minidsh credentials: starting\nminidsh credentials: the store at /x/credentials.json cannot be parsed\n')
    process.exit(2)
    break
  case 'flood':
    for (let i = 0; i < 40; i++) await write(process.stdout, 'y'.repeat(64 * 1024))
    break
  case 'hang':
    setInterval(() => undefined, 60_000)
    break
  case 'set': {
    const stdin = await readStdin()
    writeFileSync(process.env.FAKE_CLI_OUT!, JSON.stringify({ argv, stdin, inEnv: Object.values(process.env).some((value) => value?.includes(stdin)) }))
    break
  }
  case 'set-leak': {
    const stdin = await readStdin()
    await write(process.stderr, `refusing value ${stdin} for ${argv[2]}\n`)
    process.exit(1)
    break
  }
  default:
    throw new Error(`fake-cli: unknown mode ${mode}`)
}
