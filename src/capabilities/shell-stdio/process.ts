import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { SandboxError, type SandboxEnforcement, type SandboxExecutionPolicy, type SandboxMode } from '../../core/sandbox/index.ts'
import type { ShellExecRequest, ShellRunResult, ShellSession } from '../../core/shell/index.ts'

export type ShellDialect = 'bash' | 'pwsh'

const DEFAULT_TIMEOUT_MS = 300_000
const POLL_MS = 20

function shellCommand(dialect: ShellDialect, shellPath: string | undefined): { cmd: string; args: string[] } {
  if (dialect === 'pwsh') return { cmd: shellPath ?? 'pwsh', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'] }
  return { cmd: shellPath ?? 'bash', args: ['--noprofile', '--norc'] }
}

function initLine(dialect: ShellDialect): string {
  if (dialect === 'pwsh') {
    return `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Continue'\n`
  }
  return `export LC_ALL=C.UTF-8 2>/dev/null; true\n`
}

function wrapper(dialect: ShellDialect, base64: string, marker: string): string {
  if (dialect === 'pwsh') {
    return (
      `$global:LASTEXITCODE=$null; ` +
      `try { Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64}'))) } ` +
      `catch { Write-Output ($_ | Out-String) }; ` +
      `Write-Output ('${marker}:' + $(if($LASTEXITCODE -ne $null){$LASTEXITCODE}elseif($?){'0'}else{'1'}))\n`
    )
  }
  // `< /dev/null`: a command that reads stdin would otherwise block until the
  // deadline AND swallow the next command out of the shared command pipe.
  // PowerShell has no stdin redirect operator, so pwsh keeps only the deadline.
  return `eval "$(printf %s '${base64}' | base64 -d 2>/dev/null || printf %s '${base64}' | base64 --decode)" < /dev/null; printf '\\n${marker}:%s\\n' "$?"\n`
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** One persistent shell child. Commands are serialized and framed by a per-session marker. */
export class ShellProcess implements ShellSession {
  private child: ChildProcessWithoutNullStreams | undefined
  private buffer = ''
  private readonly markerBase = `__DSH_${crypto.randomUUID().replace(/-/g, '')}__`
  /** Per-command nonce: a stale marker from a killed command can never match the next one. */
  private commandSeq = 0
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false
  private readonly dialect: ShellDialect
  private readonly cwd: string
  private readonly shellPath: string | undefined
  private readonly maxCaptureChars: number
  private readonly enforcementFor: (mode: SandboxMode) => SandboxEnforcement

  constructor(
    dialect: ShellDialect,
    cwd: string,
    options: { shellPath?: string; maxCaptureChars?: number; enforcementFor?: (mode: SandboxMode) => SandboxEnforcement } = {},
  ) {
    this.dialect = dialect
    this.cwd = cwd
    this.shellPath = options.shellPath
    this.maxCaptureChars = options.maxCaptureChars ?? 512_000
    // A piped child shell confines nothing on its own; a provider that wraps the
    // spawn in an OS sandbox supplies a truthful probe here instead.
    this.enforcementFor = options.enforcementFor ?? (() => 'none')
  }

  exec(request: ShellExecRequest): Promise<ShellRunResult> {
    const run = this.queue.then(() => this.runOne(request))
    this.queue = run.catch(() => undefined)
    return run
  }

  /**
   * Deny-only, never negotiating: a confined policy this world cannot enforce
   * refuses rather than running unconfined. Escalation is the tool job.
   */
  private confine(policy: SandboxExecutionPolicy): SandboxEnforcement {
    if (policy.mode === 'danger-full-access') return 'none'
    const enforcement = this.enforcementFor(policy.mode)
    if (enforcement === 'none') {
      throw new SandboxError(
        'SANDBOX_UNAVAILABLE',
        `this host has no confinement backend, so a command cannot run under "${policy.mode}" mode`,
      )
    }
    return enforcement
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child
    const { cmd, args } = shellCommand(this.dialect, this.shellPath)
    const child = spawn(cmd, args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    // Identity-guarded: output from a killed child never lands in the live buffer.
    const append = (data: string): void => {
      if (this.child === child) this.buffer += data
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', () => {})
    child.stdin.write(initLine(this.dialect))
    this.child = child
    return child
  }

  private async runOne(request: ShellExecRequest): Promise<ShellRunResult> {
    const enforcement = this.confine(request.policy)
    const sandbox = { mode: request.policy.mode, enforcement }
    if (this.disposed) return { output: '', timedOut: false, truncated: false, reset: false, sandbox }
    // An already-cancelled call dispatches nothing: the poll loop would kill
    // the child a tick later, but by then the command had been written.
    if (request.signal?.aborted) return { output: '', timedOut: false, truncated: false, reset: false, aborted: true, sandbox }
    const child = this.ensureChild()
    this.buffer = ''
    const marker = `${this.markerBase}${++this.commandSeq}`
    const base64 = Buffer.from(request.command, 'utf8').toString('base64')
    child.stdin.write(wrapper(this.dialect, base64, marker))

    const pattern = new RegExp(`${marker}:(-?\\d+)`)
    const deadline = Date.now() + (request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    for (;;) {
      const match = pattern.exec(this.buffer)
      if (match) {
        const output = this.buffer.slice(0, this.buffer.indexOf(marker))
        this.buffer = ''
        const exitCode = Number(match[1])
        return this.finalize(output, { exitCode, timedOut: false, reset: false }, sandbox)
      }
      // The shell itself died (e.g. the command was `exit`): report immediately
      // instead of polling until the deadline.
      if (child.exitCode !== null || child.killed) {
        const output = this.buffer
        this.child = undefined
        this.buffer = ''
        return this.finalize(output, { timedOut: false, reset: true }, sandbox)
      }
      if (request.signal?.aborted) return this.finalize(this.buffer, { timedOut: false, reset: await this.reset() }, sandbox)
      if (Date.now() > deadline) return this.finalize(this.buffer, { timedOut: true, reset: await this.reset() }, sandbox)
      await sleep(POLL_MS)
    }
  }

  private finalize(raw: string, extra: { exitCode?: number; timedOut: boolean; reset: boolean }, sandbox: ShellRunResult['sandbox']): ShellRunResult {
    const trimmed = raw.replace(/^\n+/, '').replace(/\n+$/, '')
    // A MEMORY bound, not a context bound. What the model should see is the
    // tool's decision, and it cannot make it from output the executor already
    // threw away — so everything captured is returned, and `truncated` reports
    // only that the process outran this buffer.
    const truncated = trimmed.length > this.maxCaptureChars
    const output = truncated ? `${trimmed.slice(0, this.maxCaptureChars)}\n[output stopped at ${this.maxCaptureChars} captured characters]` : trimmed
    return {
      output,
      timedOut: extra.timedOut,
      truncated,
      reset: extra.reset,
      sandbox,
      ...(extra.exitCode === undefined ? {} : { exitCode: extra.exitCode }),
    }
  }

  private async reset(): Promise<boolean> {
    await this.restart()
    return true
  }

  async restart(): Promise<void> {
    const old = this.child
    this.child = undefined
    this.buffer = ''
    await killAndWait(old)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const child = this.child
    this.child = undefined
    await killAndWait(child)
  }
}

/** Kills a child and waits for it to actually exit (so its cwd lock is released on Windows). */
function killAndWait(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.killed) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, 2000)
    child.once('exit', done)
    child.kill('SIGKILL')
  })
}
