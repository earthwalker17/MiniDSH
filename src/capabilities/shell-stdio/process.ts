import { spawn, type ChildProcess, type ChildProcessByStdio, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable } from 'node:stream'
import {
  DEFAULT_ACCEPTANCE,
  meetsAcceptance,
  SandboxError,
  writableRoots,
  type SandboxEnforcement,
  type SandboxExecutionPolicy,
  type SandboxMode,
} from '../../core/sandbox/index.ts'
import {
  ShellError,
  type ShellExecRequest,
  type ShellJob,
  type ShellJobExit,
  type ShellJobRequest,
  type ShellRunResult,
  type ShellSession,
} from '../../core/shell/index.ts'
import { childEnvironment, killAndWait, killTree, spawnChild, spawnRefusal, transientSpawnText, type Spawner } from '../../core/process.ts'
import { confinementRemedy, NO_CONFINEMENT, type Confinement } from './confine/index.ts'

export type ShellDialect = 'bash' | 'pwsh'

const DEFAULT_TIMEOUT_MS = 300_000
const POLL_MS = 20

function shellCommand(dialect: ShellDialect, shellPath: string | undefined): { cmd: string; args: string[] } {
  if (dialect === 'pwsh') return { cmd: shellPath ?? 'pwsh', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'] }
  return { cmd: shellPath ?? 'bash', args: ['--noprofile', '--norc'] }
}

/**
 * The same shell, asked to run exactly one command and exit: the one-shot
 * grant's shape, and a job's. pwsh gets the persistent child's encoding
 * line first: without it PowerShell writes its own text in the OEM code page,
 * which a host on CP936 delivered to the model as replacement characters
 * (measured 2026-10-15). Guarded, because a console setting can throw where
 * there is no console; the command's own exit code is unchanged.
 */
function oneShotCommand(dialect: ShellDialect, shellPath: string | undefined, command: string): { cmd: string; args: string[] } {
  if (dialect === 'pwsh') {
    const utf8 = 'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}; $OutputEncoding = [Text.Encoding]::UTF8; '
    return { cmd: shellPath ?? 'pwsh', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', utf8 + command] }
  }
  return { cmd: shellPath ?? 'bash', args: ['--noprofile', '--norc', '-c', command] }
}

/**
 * The child's first line, which ends by printing `ready`: the handshake that
 * tells "the shell never answered the harness" from "the model's command
 * ended the shell". The shell reads its pipe a line at a time, so the marker
 * is printed before the first command is even read — a child that dies
 * without it never worked, and one that dies after it died of a command.
 */
function initLine(dialect: ShellDialect, ready: string): string {
  if (dialect === 'pwsh') {
    return `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Continue'; Write-Output '${ready}'\n`
  }
  return `export LC_ALL=C.UTF-8 2>/dev/null; printf '%s\\n' '${ready}'\n`
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

/**
 * How long a dead child's pipes get to deliver what it wrote. Node may report
 * the exit before the last 'data' (its docs say so), and the ready marker a
 * shell printed just before a first-command `exit` is exactly such a last
 * write; 'close' normally comes within a loop turn, and only a backgrounded
 * descendant still holding a pipe makes the bound the answer.
 */
const DRAIN_MS = 500

/** Spread into `spawn` options. Always an explicit env: inheriting wholesale is what this stopped doing. */
function envOption(declared: readonly string[], overlay: Readonly<Record<string, string>> | undefined): { env: NodeJS.ProcessEnv } {
  return { env: childEnvironment(declared, overlay) }
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
 * costs a restart on a host with no backend. A one-shot still gets its own
 * throwaway child there: `exec` routes `oneShot` before any world comparison.
 * `danger-full-access` is never wrapped, so it collapses too.
 */
function worldSignature(confinement: Confinement, policy: SandboxExecutionPolicy): string {
  if (confinement.id === 'none' || policy.mode === 'danger-full-access') return 'unconfined'
  return `${confinement.id}\0${policy.mode}\0${writableRoots(policy).join('\0')}`
}

/** One persistent shell child. Commands are serialized and framed by a per-session marker. */
export class ShellProcess implements ShellSession {
  /** Registered the tick it is spawned, before it is known to have become a process, so a disposal racing the start finds it. */
  private child: ChildProcess | undefined
  /** Settles when the live child's pipes have closed, or never while a descendant holds one. */
  private childClosed: Promise<void> | undefined
  /** The world the live child was spawned into; `undefined` when there is none. */
  private childWorld: string | undefined
  /** In-flight one-shot children, which disposal must reap: each runs under the WIDEST authority a session ever granted. */
  private readonly oneShotChildren = new Set<ChildProcess>()
  /** Running job processes, and how to tell each that THIS shell's disposal is what killed it. */
  private readonly jobChildren = new Map<ChildProcess, () => void>()
  /**
   * Every POSIX process group a one-shot escalation or a job opened in this
   * session.
   *
   * Reaping the CHILD is not enough, and the probe is the reason: a command
   * that backgrounds and disowns something leaves the leader exiting at once
   * while its descendant runs on, so by the time disposal looks there is no
   * child left to kill and the escaped process holds the widest authority the
   * session ever granted. A process group outlives its leader and stays
   * addressable while ANY member is alive — the kernel will not reuse a pid
   * that is still in use as a pgid — which is what makes reaping at disposal
   * possible at all.
   *
   * Which is also its limit: once a group is entirely gone its pid is free
   * again, and an unrelated leader can be given it. That is not remote — macOS
   * wraps its pids at 99,999 (Linux at its `pid_max`: 4,194,304 under WSL 2's
   * Ubuntu, but the kernel's own default is 32,768), which a busy machine
   * passes in hours, and a web session lives for days. So a group
   * is dropped once it is provably empty (`kill(-g, 0)` answers ESRCH):
   * before every addition, when a one-shot ends, before the reap, and on a
   * one-minute timer while any group is held. A group with any member alive
   * still holds its number, so pruning loses no reap; what remains is the time
   * from a group emptying to the next prune — at most that minute, never the
   * session's whole life, which is what pruning only at additions left
   * (S20.5 review).
   */
  private readonly reapGroups = new Set<number>()
  private pruneTimer: NodeJS.Timeout | undefined
  /** True from a spawn until the child printed its ready marker: a child that dies before that never worked at all. */
  private fresh = false
  /** True when the live child was spawned through the confinement wrapper. */
  private childWrapped = false
  private buffer = ''
  private readonly markerBase = `__DSH_${crypto.randomUUID().replace(/-/g, '')}__`
  /** The init line's handshake: sequence 0, which no command is ever given. */
  private readonly readyMarker = `${this.markerBase}0`
  /** Per-command nonce: a stale marker from a killed command can never match the next one. */
  private commandSeq = 0
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false
  private readonly dialect: ShellDialect
  private readonly cwd: string
  private readonly shellPath: string | undefined
  private readonly maxCaptureChars: number
  private readonly confinement: Confinement
  /** Credential names this deployment declared, asked at EVERY spawn: a row may declare after this shell exists. */
  private readonly withheld: () => readonly string[]
  /** `spawn` itself, except in a test that stages what Node does when the host is out of descriptors. */
  private readonly spawner: Spawner

  constructor(
    dialect: ShellDialect,
    cwd: string,
    options: { shellPath?: string; maxCaptureChars?: number; confinement?: Confinement; withheld?: () => readonly string[]; spawner?: Spawner } = {},
  ) {
    this.dialect = dialect
    this.cwd = cwd
    this.shellPath = options.shellPath
    this.maxCaptureChars = options.maxCaptureChars ?? 512_000
    this.withheld = options.withheld ?? (() => [])
    // A piped child shell confines nothing on its own; a backend that wraps the
    // spawn in an OS sandbox supplies a truthful probe here instead.
    this.confinement = options.confinement ?? NO_CONFINEMENT
    this.spawner = options.spawner ?? spawn
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
   * for what the CALLER accepts refuses rather than running unconfined.
   * Escalation is the tool's job.
   *
   * `accepts` defaults to `full`, which is the refusal this has always made.
   * A session that durably accepts less (a host with no backend, where the
   * alternative is an escalation per command) gets the command run and the
   * enforcement it really got REPORTED — which is what lands in the effect
   * record and what the audit reads.
   *
   * Note what this does NOT do: `ensureChild` wraps unconditionally, and
   * `NO_CONFINEMENT.wrap` is the identity, so on a host with a working backend
   * the command is still confined whatever anyone accepts. Acceptance relaxes
   * a refusal; it never disables a boundary.
   */
  private confine(policy: SandboxExecutionPolicy, accepts: SandboxEnforcement): SandboxEnforcement {
    if (policy.mode === 'danger-full-access') return 'none'
    const enforcement = this.enforcementFor(policy.mode)
    if (!meetsAcceptance(enforcement, accepts)) {
      throw new SandboxError(
        'SANDBOX_UNAVAILABLE',
        enforcement === 'none'
          ? `this host has no confinement backend, so a command cannot run under "${policy.mode}" mode`
          : `this host enforces "${policy.mode}" only "${enforcement}", and this session requires "${accepts}"`,
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
   *
   * Every pipe is read only once the child is known to exist (`spawnChild`:
   * out of descriptors, Node hands back a child with none).
   */
  private async ensureChild(policy: SandboxExecutionPolicy, world: string): Promise<ChildProcessWithoutNullStreams> {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child as ChildProcessWithoutNullStreams
    if (this.disposed) throw new ShellError('SHELL_UNAVAILABLE', 'this shell session has ended')
    const base = shellCommand(this.dialect, this.shellPath)
    const { cmd, args } = this.confinement.wrap(base.cmd, base.args, policy)
    const wrapped = cmd !== base.cmd
    const { child, spawned } = spawnChild(
      cmd,
      args,
      // `windowsHide`: no console of the harness's, so a Ctrl+C aimed at the
      // terminal does not reach this shell and silently take its state (the
      // job's reason, below).
      { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...envOption(this.withheld(), this.confinement.envFor(policy)), ...sessionOption(wrapped) },
      this.spawner,
    )
    this.child = child
    try {
      await spawned
    } catch (error) {
      if (this.child === child) this.child = undefined
      throw this.spawnFailure(cmd, wrapped, error)
    }
    const piped = child as ChildProcessWithoutNullStreams
    piped.stdout.setEncoding('utf8')
    piped.stderr.setEncoding('utf8')
    // Identity-guarded: output from a killed child never lands in the live buffer.
    const append = (data: string): void => {
      if (this.child === child) this.buffer += data
    }
    piped.stdout.on('data', append)
    piped.stderr.on('data', append)
    this.childClosed = new Promise((resolve) => child.once('close', () => resolve()))
    piped.stdin.write(initLine(this.dialect, this.readyMarker))
    // Fresh until the ready marker arrives, in EVERY world. S11's review
    // exempted a world that had answered once, because a command that ends the
    // shell (`exit`, `set -e` meeting `false`) read as "install bash" there —
    // but the first command of a session is a fresh world too, and still read
    // that way (S20.5). The handshake answers both: the marker is printed
    // before the command is even read.
    this.fresh = true
    this.childWrapped = wrapped
    this.childWorld = world
    return piped
  }

  /**
   * A spawn the OS refused, in the words its kind deserves. A transient one
   * (EMFILE, EAGAIN: `spawnRefusal`) is the host's moment, so it keeps its code
   * — SANDBOX_UNAVAILABLE under a wrapper, which is where the tool routes a
   * refusal — but never tells anyone to install what is installed, and steers
   * the model to the retry rather than to spending someone's consent on a
   * wider mode that would meet the same limit.
   */
  private spawnFailure(cmd: string, wrapped: boolean, error: unknown): Error {
    const kind = spawnRefusal(error)
    // The command's own, under any wrapper too: SANDBOX_UNAVAILABLE would steer
    // the model to spend a consent on a wider mode that meets the same limit,
    // and "install bash" was simply false (S20.5 review).
    if (kind === 'command') {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      return new ShellError(
        'SHELL_COMMAND_INVALID',
        `this command cannot be passed to a process (${code}): it is too long for one argument here or contains a NUL byte, so nothing ran; a one-shot or a job carries its command as an argument, so put a long command in a script file in the workspace and run that`,
      )
    }
    if (kind === 'transient') {
      const what = transientSpawnText(error)
      return wrapped
        ? new SandboxError('SANDBOX_UNAVAILABLE', `the confinement wrapper "${cmd}" ${what} (a wider mode would meet the same limit)`)
        : new ShellError('SHELL_UNAVAILABLE', `the shell "${cmd}" ${what}`)
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return this.startupFailure(cmd, wrapped, `could not be started (${code ?? (error instanceof Error ? error.message : String(error))})`)
  }

  /**
   * Consume the ready marker once its whole line has arrived: what precedes it
   * is the child's start-up noise, and what follows is the first command's.
   */
  private takeReady(): void {
    const at = this.buffer.indexOf(this.readyMarker)
    const end = at === -1 ? -1 : this.buffer.indexOf('\n', at + this.readyMarker.length)
    if (end === -1) return
    this.buffer = this.buffer.slice(end + 1)
    this.fresh = false
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
    const enforcement = this.confine(request.policy, request.accepts ?? DEFAULT_ACCEPTANCE)
    const sandbox = { mode: request.policy.mode, enforcement }
    // Nothing ran. It carries `aborted` for the same reason the cancelled
    // branch below does: 'nothing ran' must never read as 'ran and printed
    // nothing', and a consumer recording effects needs one field to refuse on.
    if (this.disposed) return { output: '', timedOut: false, truncated: false, reset: false, aborted: true, sandbox }
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
      // A disposal that landed inside the restart found no child to kill (the
      // restart had already let go of it); spawning now would leave a shell
      // nothing reaps (S20.5 review).
      if (this.disposed) return { output: '', timedOut: false, truncated: false, reset: false, aborted: true, sandbox }
    }
    const child = await this.ensureChild(request.policy, world)
    const closed = this.childClosed
    this.buffer = ''
    const marker = `${this.markerBase}${++this.commandSeq}`
    const base64 = Buffer.from(request.command, 'utf8').toString('base64')
    child.stdin.write(wrapper(this.dialect, base64, marker))
    const startedAt = Date.now()

    const pattern = new RegExp(`${marker}:(-?\\d+)`)
    const deadline = Date.now() + (request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    for (;;) {
      if (this.fresh) this.takeReady()
      const match = this.fresh ? null : pattern.exec(this.buffer)
      if (match) {
        const output = this.buffer.slice(0, this.buffer.indexOf(marker))
        this.buffer = ''
        const exitCode = Number(match[1])
        return this.finalize(output, { exitCode, timedOut: false, reset: false, restarted, startedAt }, sandbox)
      }
      // The shell itself died (e.g. the command was `exit`): report immediately
      // instead of polling until the deadline — once its pipes have delivered
      // what it wrote, which the exit can outrun.
      if (child.exitCode !== null || child.killed) {
        await Promise.race([closed, sleep(DRAIN_MS)])
        if (this.fresh) this.takeReady()
        const output = this.buffer
        const code = child.exitCode
        const wrapped = this.childWrapped
        this.child = undefined
        this.childWorld = undefined
        this.buffer = ''
        // A child that died before its ready marker never answered the
        // harness: a broken shim, a wrapper that exits at startup, a build
        // that rejects `-Command -`. That is the same fact as a failed spawn
        // and gets the same coded refusal — never an empty output. One that
        // died AFTER it died of the command, which ran: a reset, with what it
        // printed, and recorded as a command that ran. A wrapper that printed
        // its own failure line is the sandbox's fault and not the shell's, and
        // only that conjunction says so: a nonzero exit alone is an ordinary
        // command failing.
        if (this.fresh) {
          this.fresh = false
          const trimmed = output.trim()
          const runnerFailed = wrapped && this.isRunnerFailure(trimmed)
          throw this.startupFailure(
            runnerFailed ? this.confinement.id : (this.shellPath ?? this.dialect),
            runnerFailed,
            `exited (code ${code ?? 'unknown'}) before it answered${trimmed.length > 0 ? `: ${trimmed.slice(0, 200)}` : ''}`,
          )
        }
        return this.finalize(output, { timedOut: false, reset: true, restarted, startedAt }, sandbox)
      }
      // `durationMs` is stamped HERE, before the reset: killing and reaping
      // the child can take seconds, and charging that to the command would
      // report a 120 s deadline as "timed out, 120.9s".
      if (request.signal?.aborted) {
        const durationMs = Date.now() - startedAt
        return this.finalize(this.buffer, { timedOut: false, reset: await this.reset(), restarted, startedAt, durationMs }, sandbox)
      }
      if (Date.now() > deadline) {
        const durationMs = Date.now() - startedAt
        return this.finalize(this.buffer, { timedOut: true, reset: await this.reset(), restarted, startedAt, durationMs }, sandbox)
      }
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
    const { child, spawned } = spawnChild(
      cmd,
      args,
      // `windowsHide` for the job's reason (below): a Ctrl+C at the terminal
      // must not end an approved command in flight.
      { cwd: this.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...envOption(this.withheld(), this.confinement.envFor(request.policy)), ...sessionOption(true) },
      this.spawner,
    )
    // Reachable from `dispose`: an escalated command runs under the widest
    // authority the session ever granted, so it is the LAST thing that may
    // outlive the agent scope that was supposed to end it.
    const startedAt = Date.now()
    this.oneShotChildren.add(child)
    this.addGroup(child)
    const ended = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      void killTree(child)
    }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const onAbort = (): void => void killTree(child)
    request.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      try {
        await spawned
      } catch (error) {
        throw this.spawnFailure(cmd, wrapped, error)
      }
      const { stdout, stderr } = child as ChildProcessByStdio<null, Readable, Readable>
      stdout.setEncoding('utf8')
      stderr.setEncoding('utf8')
      let output = ''
      const append = (data: string): void => void (output += data)
      stdout.on('data', append)
      stderr.on('data', append)
      const code = await ended
      // A wrapper that could not start printed its own line and never ran the
      // command; the shell's own failures are not this refusal's business.
      if (wrapped && code !== 0 && this.isRunnerFailure(output.trim())) {
        throw this.startupFailure(this.confinement.id, true, `exited (code ${code ?? 'unknown'}): ${output.trim().slice(0, 200)}`)
      }
      // `reset` is about the persistent shell, and this call never touched it.
      return this.finalize(output, { ...(code === null ? {} : { exitCode: code }), timedOut, reset: false, restarted: false, startedAt }, sandbox)
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
      this.oneShotChildren.delete(child)
      this.pruneGroups()
    }
  }

  /**
   * A job's process: `runOneShot`'s spawn, without its deadline and without
   * waiting for the exit. The order is the contract (ARCHITECTURE §7 holds only its
   * consequence: a job runs under the stamp its start resolved):
   * `confine()` refuses what this world cannot deliver for what the caller
   * accepts, a disposed shell starts nothing, and the spawned child enters the
   * reap set in the same tick, so no await sits between the policy the caller
   * resolved and a child disposal can find. It returns once the child has
   * SPAWNED: a missing binary or wrapper is a refusal, as it is for `exec`.
   *
   * It never goes through the per-owner queue — a job would hold the
   * persistent shell for its whole life — and never touches the persistent
   * child or its state: a job runs in a fresh shell at the session root.
   */
  async start(request: ShellJobRequest): Promise<ShellJob> {
    const enforcement = this.confine(request.policy, request.accepts ?? DEFAULT_ACCEPTANCE)
    if (this.disposed) throw Object.assign(new Error("this session's shell has been disposed; nothing was started"), { code: 'ABORTED_BEFORE_DISPATCH' })
    const base = oneShotCommand(this.dialect, this.shellPath, request.command)
    const { cmd, args } = this.confinement.wrap(base.cmd, base.args, request.policy)
    const wrapped = cmd !== base.cmd
    const { child, spawned } = spawnChild(
      cmd,
      args,
      {
        cwd: this.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...envOption(this.withheld(), this.confinement.envFor(request.policy)),
        // Its own process group on POSIX, wrapped or not, so a kill reaches what
        // it started — the one-shot's reason, and a server's children are the
        // commonest thing a job leaves behind.
        ...sessionOption(true),
        // No console of the harness's on Windows (CREATE_NO_WINDOW, every stdio
        // piped or ignored): a Ctrl+C a person aims at the terminal is delivered
        // to every process on its console, and would otherwise end the job too.
        windowsHide: true,
      },
      this.spawner,
    )
    // Registered in the spawn's own tick, before it is known to have worked:
    // the await below is the only one, and a disposal landing in it must find
    // the child (a pipeless one, out of descriptors, has no pid to kill).
    let disposedHere = false
    let stopRequested = false
    this.jobChildren.set(child, () => (disposedHere = true))
    this.addGroup(child)
    const forget = (): void => {
      this.jobChildren.delete(child)
      if (child.pid !== undefined) this.reapGroups.delete(child.pid)
    }
    try {
      await spawned
    } catch (error) {
      forget()
      throw this.spawnFailure(cmd, wrapped, error)
    }
    const { stdout, stderr } = child as ChildProcessByStdio<null, Readable, Readable>
    stdout.setEncoding('utf8')
    stderr.setEncoding('utf8')
    // The first lines, kept only to tell a runner that never started from a
    // command that failed; the output itself goes straight to the caller.
    let opening = ''
    const forward = (chunk: string): void => {
      if (opening.length < 2_000) opening += chunk.slice(0, 2_000 - opening.length)
      request.output(chunk)
    }
    stdout.on('data', forward)
    stderr.on('data', forward)
    let closed = false
    child.once('close', () => (closed = true))
    const exited = new Promise<ShellJobExit>((resolve) => {
      child.once('exit', (code, signal) => {
        // Decided at the exit, before the pipes' grace: a stop asked for in
        // that grace did not end a process that had already ended.
        const selfEnded = !stopRequested && !disposedHere
        const settle = (): void => {
          // The job is over, so what it started is too: a descendant still in
          // its group would otherwise outlive the end the log records.
          if (child.pid !== undefined && process.platform !== 'win32') {
            try {
              process.kill(-child.pid, 'SIGKILL')
            } catch {
              // Already gone, which is the ordinary case.
            }
          }
          forget()
          const failed = wrapped && code !== 0 && this.isRunnerFailure(opening.trim())
          resolve({
            ...(code === null ? {} : { exitCode: code }),
            ...(signal === null ? {} : { signal }),
            ...(failed ? { failure: `the confinement runner "${this.confinement.id}" failed: ${opening.trim().slice(0, 200)}` } : {}),
            ...(disposedHere ? { disposed: true as const } : {}),
            ...(selfEnded ? { selfEnded: true as const } : {}),
          })
        }
        // 'exit' can precede the last 'data'; 'close' waits for the pipes, and
        // never comes while a backgrounded descendant still holds one. So the
        // pipes get a short grace, then the job ends with what it wrote.
        if (closed) return settle()
        const grace = setTimeout(() => {
          stdout.destroy()
          stderr.destroy()
          settle()
        }, 1_500)
        child.once('close', () => {
          clearTimeout(grace)
          settle()
        })
      })
    })
    return {
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      sandbox: { mode: request.policy.mode, enforcement },
      exited,
      kill: () => {
        stopRequested = true
        void killTree(child)
      },
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
    extra: { exitCode?: number; timedOut: boolean; reset: boolean; restarted: boolean; startedAt: number; durationMs?: number },
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
      durationMs: extra.durationMs ?? Date.now() - extra.startedAt,
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
    const oneShots = [...this.oneShotChildren]
    const jobs = [...this.jobChildren]
    this.child = undefined
    this.childWorld = undefined
    this.oneShotChildren.clear()
    // A job killed HERE says so in its exit, so its owner records the stop as
    // the disposal it was, whichever of the two disposers unwound first.
    for (const [, markDisposed] of jobs) markDisposed()
    await Promise.all([killAndWait(child), ...oneShots.map(killAndWait), ...jobs.map(([job]) => killAndWait(job))])
    // …and everything an escalation or a job left behind, including what
    // outlived the child that started it. Nothing may outlive the scope.
    // Pruned first: a group already empty has given its number back, and
    // signalling that number now could reach whoever holds it.
    this.pruneGroups()
    for (const group of this.reapGroups.values()) {
      try {
        process.kill(-group, 'SIGKILL')
      } catch {
        // Gone since the prune, which is the ordinary case.
      }
    }
    this.reapGroups.clear()
    if (this.pruneTimer !== undefined) clearInterval(this.pruneTimer)
    this.pruneTimer = undefined
  }

  /** A child's own process group (POSIX), entered after dropping every group that is provably empty. */
  private addGroup(child: ChildProcess): void {
    if (child.pid === undefined || process.platform === 'win32') return
    this.pruneGroups()
    this.reapGroups.add(child.pid)
    this.pruneTimer ??= setInterval(() => this.pruneGroups(), 60_000).unref()
  }

  /**
   * Drop every group with no member left. Signal 0 delivers nothing and asks
   * only whether the group exists: ESRCH is "no process has this pgid", the
   * one answer that frees the number. EPERM is a live member this user may not
   * signal — still a member, so the number is still held and kept.
   */
  private pruneGroups(): void {
    for (const group of this.reapGroups) {
      try {
        process.kill(-group, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') this.reapGroups.delete(group)
      }
    }
    if (this.reapGroups.size === 0 && this.pruneTimer !== undefined) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = undefined
    }
  }
}
