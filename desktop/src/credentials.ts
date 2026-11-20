/**
 * Provider keys from the welcome and keys views, through the runtime's own
 * CLI: `minidsh credentials list --json` and `minidsh credentials set NAME`.
 * The credential store belongs to the runtime (`capabilities/credentials-local`
 * reads it, and its writer sits beside it); the desktop never opens the file,
 * so the store has one owner and one format (ARCHITECTURE §11, the
 * `credentials-local` row).
 *
 * A VALUE travels only on the child's stdin, then stdin is closed: never in
 * argv (any process can read another's command line) and never in the
 * environment (inherited by everything the child spawns). The NAME is
 * validated before anything is spawned, since it does go in argv.
 *
 * Owns: the two invocations and the reading of their results. Must not own:
 * which refs exist (the composition declares them; `list` reports them) or
 * the form that asks (the overlay, through main).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { SpawnLike } from './runtime.ts'

export type CredentialSource = 'env' | 'store' | 'absent'

export interface CredentialRef {
  readonly name: string
  readonly source: CredentialSource
}

export interface CredentialList {
  readonly home: string
  /** The store file the runtime reads; `null` when the composition mounts no store (keys come from the environment alone). */
  readonly store: string | null
  readonly refs: readonly CredentialRef[]
}

export type ListResult = { readonly ok: true; readonly list: CredentialList } | { readonly ok: false; readonly reason: string }
export type SetResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export interface CliOptions {
  /** The bundled node executable. */
  readonly node: string
  /** The runtime's `bin/minidsh.js`. */
  readonly bin: string
  readonly env: NodeJS.ProcessEnv
  /** Where the CLI runs; main's own working directory when absent. */
  readonly cwd?: string
  readonly spawnImpl?: SpawnLike
  readonly timeoutMs?: number
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
export const isCredentialName = (name: string): boolean => NAME.test(name) && name.length <= 128

/** No `list` answer is near this; a child that writes more is not answering. */
const MAX_STDOUT = 1024 * 1024
const STDERR_KEEP = 8 * 1024
const DEFAULT_TIMEOUT_MS = 30_000

interface CliRun {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly failure?: string
}

/** One bounded CLI run: killed at the deadline or past the output cap, never left behind. */
function runCli(options: CliOptions, args: readonly string[], input: string | undefined): Promise<CliRun> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = (options.spawnImpl ?? spawn)(options.node, [options.bin, ...args], {
        env: options.env,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', failure: `could not run the runtime (${(error as NodeJS.ErrnoException).code ?? 'error'})` })
      return
    }
    const stdout: Buffer[] = []
    let stdoutBytes = 0
    let stderr = ''
    let failure: string | undefined
    let done = false
    const finish = (code: number | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr, ...(failure === undefined ? {} : { failure }) })
    }
    const abort = (why: string): void => {
      failure ??= why
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => abort('the runtime did not answer in time'), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    child.on('error', (error) => {
      if (child.pid !== undefined) return
      failure ??= `could not run the runtime (${(error as NodeJS.ErrnoException).code ?? 'error'})`
      finish(null)
    })
    child.on('close', (code) => finish(code))
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_STDOUT) abort('the runtime wrote more than any answer holds')
      else stdout.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_KEEP)
    })
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on('error', () => undefined)
    if (input !== undefined) child.stdin?.end(input)
    else child.stdin?.end()
  })
}

/** The CLI's last stderr line, for a one-line reason; `secret` is cut out wherever it appears. */
function lastLine(stderr: string, secret?: string): string {
  let text = stderr
  if (secret !== undefined && secret.length > 0) text = text.split(secret).join('[redacted]')
  const line = text.trim().split(/\r?\n/).at(-1)?.trim() ?? ''
  return line.length > 300 ? `${line.slice(0, 299)}…` : line
}

function failed(command: string, run: CliRun, secret?: string): { ok: false; reason: string } {
  if (run.failure !== undefined) return { ok: false, reason: run.failure }
  const said = lastLine(run.stderr, secret)
  return { ok: false, reason: `minidsh credentials ${command} failed (exit ${run.code ?? 'unknown'})${said.length > 0 ? `: ${said}` : ''}` }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The `list --json` answer, or `undefined` when it is not that shape. */
export function parseCredentialList(text: string): CredentialList | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value) || typeof value.home !== 'string' || (typeof value.store !== 'string' && value.store !== null) || !Array.isArray(value.refs)) return undefined
  const refs: CredentialRef[] = []
  for (const ref of value.refs) {
    if (!isRecord(ref) || typeof ref.name !== 'string' || !isCredentialName(ref.name)) return undefined
    if (ref.source !== 'env' && ref.source !== 'store' && ref.source !== 'absent') return undefined
    refs.push({ name: ref.name, source: ref.source })
  }
  return { home: value.home, store: value.store, refs }
}

export async function listCredentials(options: CliOptions): Promise<ListResult> {
  const run = await runCli(options, ['credentials', 'list', '--json'], undefined)
  if (run.failure !== undefined || run.code !== 0) return failed('list', run)
  const list = parseCredentialList(run.stdout)
  return list === undefined ? { ok: false, reason: 'the credentials list was not understood' } : { ok: true, list }
}

/**
 * Stores one key. The value must be printable text with no line break or
 * control character: keys are, and a stray newline from a paste is better
 * refused than silently kept inside a header later.
 */
export async function setCredential(options: CliOptions & { readonly name: string; readonly value: string }): Promise<SetResult> {
  const { name, value } = options
  if (!isCredentialName(name)) return { ok: false, reason: 'That is not a valid key name.' }
  // oxlint-disable-next-line no-control-regex
  if (value.trim().length === 0 || /[\x00-\x1f\x7f]/.test(value)) return { ok: false, reason: 'The key is empty or contains a line break or control character.' }
  const run = await runCli(options, ['credentials', 'set', name], value)
  return run.failure === undefined && run.code === 0 ? { ok: true } : failed('set', run, value)
}
