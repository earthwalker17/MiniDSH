import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { SandboxError, writableRoots, type SandboxEnforcement, type SandboxExecutionPolicy, type SandboxMode } from '../../core/sandbox/index.ts'
import { ShellError, type ShellExecRequest, type ShellRunResult, type ShellSession } from '../../core/shell/index.ts'
import { confinementRemedy, NO_CONFINEMENT, type Confinement } from './confine/index.ts'

export type ShellDialect = 'bash' | 'pwsh'

const DEFAULT_TIMEOUT_MS = 300_000
const POLL_MS = 20

function shellCommand(dialect: ShellDialect, shellPath: string | undefined): { cmd: string; args: string[] } {
  if (dialect === 'pwsh') return { cmd: shellPath ?? 'pwsh', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'] }
  return { cmd: shellPath ?? 'bash', args: ['--noprofile', '--norc'] }
}

/** The same shell, asked to run exactly one command and exit: the one-shot grant's shape. */
function oneShotCommand(dialect: ShellDialect, shellPath: string | undefined, command: string): { cmd: string; args: string[] } {
  if (dialect === 'pwsh') return { cmd: shellPath ?? 'pwsh', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] }
  return { cmd: shellPath ?? 'bash', args: ['--noprofile', '--norc', '-c', command] }
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

/** Spread into `spawn` options: absent overlay means "inherit", not "empty environment". */
function envOption(overlay: Readonly<Record<string, string>> | undefined): { env?: NodeJS.ProcessEnv } {
  return overlay === undefined ? {} : { env: { ...process.env, ...overlay } }
}

/**
 * A CONFINED child gets its own POSIX session, which is `--new-session` by
 * another name.
 *
 * The bwrap profile passes that flag deliberately: a command that keeps the
 * harness's controlling terminal can push a line into the user's own shell with
 * `ioctl(TIOCSTI)` without writing a single file, so no file-effect ceiling
 * describes it. Seatbelt cannot do the same — it is a syscall filter, not a
 * namespace — so on macOS the escape the Linux profile closes was open, and the
 * two backends disagreed about a threat only one of them had named. `setsid`
 * closes it for both.
 *
 * Only where something confines. An unconfined persistent child stays in the
 * harness's session on purpose: it makes no confinement claim to protect, and
 * staying there keeps the terminal's own SIGHUP as a last reaper.
 */
function sessionOption(confined: boolean): { detached?: boolean } {
  // Never on Windows: `detached` there means a new console, not a new session,
  // and Windows has no backend to confine with anyway.
  return confined && process.platform !== 'win32' ? { detached: true } : {}
}

/**
 * The identity of the execution world a child was spawned into.
 *
 * Two policies share a child exactly when a child spawned under one would be
 * indistinguishable from a child spawned under the other. Where nothing
 * confines, every policy collapses to one signature — so no policy change ever
 * costs a restart on a host with no backend, and `oneShot` is a no-op there.
 * `danger-full-access` is never wrapped, so it collapses too.
 */
function worldSignature(confinement: Confinement, policy: SandboxExecutionPolicy): string {
  if (confinement.id === 'none' || policy.mode === 'danger-full-access') return 'unconfined'
  return `${confinement.id}\0${policy.mode}\0${writableRoots(policy).join('\0')}`
}

/** One persistent shell child. Commands are serialized and framed by a per-session marker. */
export class ShellProcess implements ShellSession {
  private child: ChildProcessWithoutNullStreams | undefined
  /** The world the live child was spawned into; `undefined` when there is none. */
  private childWorld: string | undefined
  /** A world that has already answered a command here, so a restart into it is not a broken host. */
  private provenWorld: string | undefined
  /** An in-flight one-shot child, which disposal must reap: it runs under the WIDEST authority a session ever granted. */
  private oneShotChild: ChildProcess | undefined
  /**
   * Every POSIX process group a one-shot escalation opened in this session.
   *
   * Reaping the CHILD is not enough, and the probe is the reason: a command
   * that backgrounds and disowns something leaves the leader exiting at once
   * while its descendant runs on, so by the time disposal looks there is no
   * child left to kill and the escaped process holds the widest authority the
   * session ever granted. The group outlives its leader and stays addressable
   * — Linux keeps a pid allocated while it is in use as a pgid, so there is no
   * window in which this could signal an unrelated process — which is what
   * makes reaping at disposal both possible and safe.
   */
  private readonly oneShotGroups = new Set<number>()
  /** True from a spawn until its first command answered: a child that dies before that never worked at all. */
  private fresh = false
  /** True when the live child was spawned through the confinement wrapper. */
  private childWrapped = false
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
  private readonly confinement: Confinement

  constructor(dialect: ShellDialect, cwd: string, options: { shellPath?: string; maxCaptureChars?: number; confinement?: Confinement } = {}) {
    this.dialect = dialect
    this.cwd = cwd
    this.shellPath = options.shellPath
    this.maxCaptureChars = options.maxCaptureChars ?? 512_000
    // A piped child shell confines nothing on its own; a backend that wraps the
    // spawn in an OS sandbox supplies a truthful probe here instead.
    this.confinement = options.confinement ?? NO_CONFINEMENT
  }

  exec(request: ShellExecRequest): Promise<ShellRunResult> {
    const run = this.queue.then(() => this.runOne(request))
    this.queue = run.catch(() => undefined)
    return run
  }

  private enforcementFor(mode: SandboxMode): SandboxEnforcement {
    if (mode === 'danger-full-access') return 'none'
    return this.confinement.enforcement
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

  /**
   * The live child, spawned on first use — and CONFIRMED spawned before a byte
   * is written to it. A missing binary (no `pwsh` on a stock Windows, which
   * ships only PowerShell 5.1) surfaces as an `error` event one tick after
   * `spawn` returns; swallowing it left the poll loop reading a dead child as
   * "exited", so every approved command answered `(no output)` and nothing ever
   * named the cause. A refusal with a code is the honest answer, exactly as a
   * confined policy this world cannot enforce is refused rather than run
   * unconfined — and deliberately NOT a silent fallback to `powershell.exe`:
   * the prompt and the tool description say `pwsh`, and a 5.1 child under
   * those words would be a lie the model cannot detect.
   *
   * Under a backend the spawned binary is the WRAPPER, so a failure to start
   * is a failure to confine and gets the sandbox's code rather than the
   * shell's — the model needs the escalation path on exactly the host that
   * has a backend.
   */
  private async ensureChild(policy: SandboxExecutionPolicy, world: string): Promise<ChildProcessWithoutNullStreams> {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child
    const base = shellCommand(this.dialect, this.shellPath)
    const { cmd, args } = this.confinement.wrap(base.cmd, base.args, policy)
    const wrapped = cmd !== base.cmd
    const child = spawn(cmd, args, { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], ...envOption(this.confinement.envFor(policy)), ...sessionOption(wrapped) })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    // Identity-guarded: output from a killed child never lands in the live buffer.
    const append = (data: string): void => {
      if (this.child === child) this.buffer += data
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    this.child = child
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve())
        child.once('error', (error: NodeJS.ErrnoException) => {
          reject(this.startupFailure(cmd, wrapped, `could not be started (${error.code ?? error.message})`))
        })
      })
    } catch (error) {
      if (this.child === child) this.child = undefined
      throw error
    }
    // A later error (a child dying mid-command) is what the poll loop reads
    // as an exit; it must not surface as an unhandled event.
    child.on('error', () => {})
    child.stdin.write(initLine(this.dialect))
    // "Never answered" is a fact about the WORLD, not about this child object.
    // A restart back into a world that has already served a command is not a
    // host that cannot start a shell, and reporting one as the other turned a
    // command that legitimately ends the shell (`exit`) into a hard
    // SHELL_UNAVAILABLE telling the user to install bash.
    this.fresh = world !== this.provenWorld
    this.childWrapped = wrapped
    this.childWorld = world
    return child
  }

  /** One coded refusal for "the thing we spawned never worked", named for what it was. */
  private startupFailure(cmd: string, wrapped: boolean, what: string): Error {
    if (wrapped) {
      return new SandboxError(
        'SANDBOX_UNAVAILABLE',
        `the confinement wrapper "${cmd}" ${what}, so a command cannot run confined on this host; ${confinementRemedy()}`,
      )
    }
    const remedy = this.dialect === 'pwsh' ? 'install PowerShell 7 (pwsh)' : 'install bash'
    return new ShellError('SHELL_UNAVAILABLE', `the shell "${cmd}" ${what}; ${remedy}, or point the shell row's shellPath at it`)
  }

  private async runOne(request: ShellExecRequest): Promise<ShellRunResult> {
    const enforcement = this.confine(request.policy)
    const sandbox = { mode: request.policy.mode, enforcement }
    if (this.disposed) return { output: '', timedOut: false, truncated: false, reset: false, sandbox }
    // An already-cancelled call dispatches nothing: the poll loop would kill
    // the child a tick later, but by then the command had been written.
    if (request.signal?.aborted) return { output: '', timedOut: false, truncated: false, reset: false, aborted: true, sandbox }

    const world = worldSignature(this.confinement, request.policy)
    // A grant that covers ONE call may not become the persistent shell's world:
    // it runs beside it and leaves nothing behind. Unconditionally, even where
    // the two worlds would be indistinguishable — on a host that confines
    // nothing they always are, and sparing the spawn there let an escalated
    // `cd` or `export` persist into the session's shell while the tool told
    // the model the opposite. Isolation the caller was promised may not depend
    // on whether the executor happened to need it.
    if (request.oneShot === true) return this.runOneShot(request, sandbox)

    // Before the deadline is taken, never inside the poll loop: a confined
    // spawn costs milliseconds that belong to the shell, not to the command.
    let restarted = false
    if (this.child !== undefined && this.childWorld !== world) {
      await this.restart()
      restarted = true
    }
    const child = await this.ensureChild(request.policy, world)
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
        this.fresh = false
        this.provenWorld = world
        const exitCode = Number(match[1])
        return this.finalize(output, { exitCode, timedOut: false, reset: false, restarted }, sandbox)
      }
      // The shell itself died (e.g. the command was `exit`): report immediately
      // instead of polling until the deadline.
      if (child.exitCode !== null || child.killed) {
        const output = this.buffer
        const code = child.exitCode
        const wrapped = this.childWrapped
        this.child = undefined
        this.childWorld = undefined
        this.buffer = ''
        // A child that spawned and died before answering its FIRST command
        // never worked: a broken shim, a wrapper that exits at startup, a
        // build that rejects `-Command -`. That is the same fact as a failed
        // spawn and gets the same coded refusal — never an empty output. A
        // wrapper that printed its own failure line is the sandbox's fault
        // and not the shell's, and only that conjunction says so: a nonzero
        // exit alone is an ordinary command failing.
        if (this.fresh) {
          this.fresh = false
          const trimmed = output.trim()
          const runnerFailed = wrapped && this.isRunnerFailure(trimmed)
          throw this.startupFailure(
            runnerFailed ? this.confinement.id : (this.shellPath ?? this.dialect),
            runnerFailed,
            `exited (code ${code ?? 'unknown'}) before it answered its first command${trimmed.length > 0 ? `: ${trimmed.slice(0, 200)}` : ''}`,
          )
        }
        return this.finalize(output, { timedOut: false, reset: true, restarted }, sandbox)
      }
      if (request.signal?.aborted) return this.finalize(this.buffer, { timedOut: false, reset: await this.reset(), restarted }, sandbox)
      if (Date.now() > deadline) return this.finalize(this.buffer, { timedOut: true, reset: await this.reset(), restarted }, sandbox)
      await sleep(POLL_MS)
    }
  }

  /**
   * One command, one child, under a policy that is not this session's.
   *
   * No marker framing: the process exits when the command does, so its exit
   * code IS the command's and its pipes carry the whole output. That is also
   * why an approved escalation leaves no shell state behind — a grant that
   * covers one call should not be able to.
   */
  private async runOneShot(request: ShellExecRequest, sandbox: ShellRunResult['sandbox']): Promise<ShellRunResult> {
    const base = oneShotCommand(this.dialect, this.shellPath, request.command)
    const { cmd, args } = this.confinement.wrap(base.cmd, base.args, request.policy)
    const wrapped = cmd !== base.cmd
    // The one-shot is detached on POSIX whether or not it is wrapped, and for a
    // second reason: `danger-full-access` is never wrapped, so the escalated
    // child is the one child that is BOTH unconfined and running under the
    // widest authority the session ever grants. Its own process group is what
    // lets the kill below reap what it started — without it a backgrounded
    // command survived the grant, the tool call and the agent scope, which is
    // the opposite of what the comment under this line has always promised.
    const child = spawn(cmd, args, {
      cwd: this.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...envOption(this.confinement.envFor(request.policy)),
      ...sessionOption(true),
    })
    // Reachable from `dispose`: an escalated command runs under the widest
    // authority the session ever granted, so it is the LAST thing that may
    // outlive the agent scope that was supposed to end it.
    this.oneShotChild = child
    if (child.pid !== undefined && process.platform !== 'win32') this.oneShotGroups.add(child.pid)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let output = ''
    const append = (data: string): void => void (output += data)
    child.stdout.on('data', append)
    child.stderr.on('data', append)

    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const ended = new Promise<{ code: number | null; failed?: Error }>((resolve) => {
      child.once('error', (error: NodeJS.ErrnoException) =>
        resolve({ code: null, failed: this.startupFailure(cmd, wrapped, `could not be started (${error.code ?? error.message})`) }),
      )
      child.once('exit', (code) => resolve({ code }))
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    const onAbort = (): void => killTree(child)
    request.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const { code, failed } = await ended
      if (failed) throw failed
      // A wrapper that could not start printed its own line and never ran the
      // command; the shell's own failures are not this refusal's business.
      if (wrapped && code !== 0 && this.isRunnerFailure(output.trim())) {
        throw this.startupFailure(this.confinement.id, true, `exited (code ${code ?? 'unknown'}): ${output.trim().slice(0, 200)}`)
      }
      // `reset` is about the persistent shell, and this call never touched it.
      return this.finalize(output, { ...(code === null ? {} : { exitCode: code }), timedOut, reset: false, restarted: false }, sandbox)
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
      if (this.oneShotChild === child) this.oneShotChild = undefined
    }
  }

  /**
   * The wrapper failed, as opposed to the shell inside it.
   *
   * The conjunction is nonzero exit + wrapped + the wrapper's own diagnostic
   * prefix, minus the one diagnostic that is about the wrapped program rather
   * than the wrapper: `bwrap: execvp bash: No such file or directory` is a
   * MISSING SHELL reported in bwrap's voice, and calling it a sandbox failure
   * sends the model to escalate — which would spawn the same missing shell
   * unconfined and fail again, after spending someone's consent.
   */
  private isRunnerFailure(text: string): boolean {
    if (/^\s*bwrap: execvp /m.test(text)) return false
    return this.matches(text, this.confinement.runnerFailureSignatures)
  }

  private matches(text: string, signatures: readonly string[]): boolean {
    if (signatures.length === 0) return false
    const lower = text.toLowerCase()
    return signatures.some((signature) => lower.includes(signature))
  }

  private finalize(
    raw: string,
    extra: { exitCode?: number; timedOut: boolean; reset: boolean; restarted: boolean },
    sandbox: ShellRunResult['sandbox'],
  ): ShellRunResult {
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
      ...(extra.restarted ? { restarted: true as const } : {}),
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
    this.childWorld = undefined
    this.buffer = ''
    await killAndWait(old)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const child = this.child
    const oneShot = this.oneShotChild
    this.child = undefined
    this.childWorld = undefined
    this.oneShotChild = undefined
    await Promise.all([killAndWait(child), killAndWait(oneShot)])
    // …and everything an escalation left behind, including what outlived the
    // child that started it. Nothing granted for one call may outlive the scope.
    for (const group of this.oneShotGroups.values()) {
      try {
        process.kill(-group, 'SIGKILL')
      } catch {
        // Already gone, which is the ordinary case.
      }
    }
    this.oneShotGroups.clear()
  }
}

/**
 * Kill a child AND what it started, where the platform can say so.
 *
 * A child spawned `detached` on POSIX leads its own process group, so a
 * negative pid signals the group — the difference between reaping a shell and
 * reaping a shell that backgrounded something. Falls back to the child alone
 * when there is no group (never detached), when it is already gone, or on
 * Windows, which has neither.
 */
function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      // Fall through to the single-child kill.
    }
  }
  child.kill('SIGKILL')
}

/** Kills a child and waits for it to actually exit (so its cwd lock is released on Windows). */
function killAndWait(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.killed) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, 2000)
    child.once('exit', done)
    killTree(child)
  })
}
