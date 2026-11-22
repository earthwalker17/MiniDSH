import { spawn, type ChildProcess, type ChildProcessByStdio, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { statSync } from 'node:fs'
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
import { clip, printableText } from '../../core/text.ts'
import { confinementRemedy, NO_CONFINEMENT, type Confinement } from './confine/index.ts'

export type ShellDialect = 'bash' | 'pwsh'

const DEFAULT_TIMEOUT_MS = 300_000
const POLL_MS = 20

function shellCommand(dialect: ShellDialect, shellPath: string | undefined): { cmd: string; args: string[] } {
  if (dialect === 'pwsh') return { cmd: shellPath ?? 'pwsh', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'] }
  return { cmd: shellPath ?? 'bash', args: ['--noprofile', '--norc'] }
}

/**
 * On Windows, every pwsh this shell spawns first assigns ITSELF to a nested,
 * unnamed kill-on-close Job (S21.1), so what its command starts ends with it.
 *
 * Node already holds each child in libuv's own kill-on-close Job, but that Job
 * allows SILENT breakaway: a `Start-Process`'d program leaves it at birth and
 * outlived the job's end, a kill and even a killed host (measured 2026-11-08 on
 * this project's Windows 11 host: alive after a normal exit, after
 * `child.kill()` and after `taskkill /F` of the host node; only a `/T` walk
 * over a live parent reached it). With this prefix pwsh holds the only handle
 * to a Job without that flag, so pwsh's exit — on its own, killed, or because
 * libuv's Job killed it with the host — closes the handle and the kernel ends
 * every member: dead in all four cases, the persistent shell's restart, reset,
 * dispose and a typed `exit` included. This is the POSIX job rule (a job's end
 * kills its group) reached on Windows. Two deliberate differences from POSIX,
 * both §13: an approved one-shot's descendants end with the CALL, and the
 * persistent shell's with the shell.
 *
 * How, and why so:
 *   - Reflection.Emit P/Invoke, never `Add-Type`, which compiles through Roslyn
 *     in every cold pwsh (0.7–2.2 s, S21). Measured cost: ~+55 ms on a ~610 ms
 *     start (median of six each, 2026-11-08). No native binding, no runner
 *     process: DSH reaches the same ordering with a koffi FFI runner.
 *   - Assigned before a byte of the command runs, so nothing it starts is born
 *     outside the Job.
 *   - KILL_ON_JOB_CLOSE | BREAKAWAY_OK (0x2800) and NOT silent breakaway: an
 *     ordinary child stays in, while a program that explicitly ASKS to break
 *     away (CREATE_BREAKAWAY_FROM_JOB) still starts, as it would under libuv's
 *     Job, instead of failing with access denied. That and a process created
 *     by WMI or the Task Scheduler escape any Job (§13). Not measured: no test
 *     here creates a process that asks to break away.
 *   - The handle is a raw `IntPtr`, which no finalizer closes: a command that
 *     forces a full collection keeps its Job (measured).
 *   - In a script block of its own, and `$Error` trimmed back to what it was:
 *     the command sees no variable, function or error of this line. Exit codes
 *     were identical with and without it across ten command shapes (measured).
 *     Its own block, too, is what keeps the COMMAND out of PowerShell's
 *     suspicious-script log (`PWSH_CONTAINMENT`).
 *   - It fails SOFT. Under Constrained Language Mode (WDAC, AppLocker) it runs
 *     nothing and only warns; where any call fails, the same: one
 *     `Write-Warning` line naming `minidsh:`. A one-shot and a job then run as
 *     before, under the old taskkill tree kill (measured: the warning, then
 *     the command, exit kept). The PERSISTENT shell does not: under that mode
 *     its `wrapper` below decodes each command with a method call the mode
 *     refuses, so it runs no command at all (measured with the mode set
 *     in-session; ARCHITECTURE §13).
 *   - On a machine whose security tooling reads that log, each pwsh start
 *     still logs the BODY once (reflection over kernel32's Job calls), which
 *     such tooling may flag (§13).
 *
 * About 2.4 KB of the 32,767 characters a one-shot's or a job's argv may hold;
 * a command past what remains is refused `SHELL_COMMAND_INVALID`, as before.
 */
const CONTAINMENT_BODY =
  "$n = $Error.Count; try { " +
  "$tb = [Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly([Reflection.AssemblyName]::new('MiniDshJob'), 'Run').DefineDynamicModule('MiniDshJob').DefineType('MiniDshJob', 'Public,Class'); " +
  "function D($name, $ret, [Type[]]$params) { $tb.DefinePInvokeMethod($name, 'kernel32.dll', 'Public,Static,PinvokeImpl', [Reflection.CallingConventions]::Standard, $ret, $params, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode).SetImplementationFlags('PreserveSig') }; " +
  "D 'CreateJobObjectW' ([IntPtr]) @([IntPtr], [IntPtr]); D 'SetInformationJobObject' ([bool]) @([IntPtr], [int], [IntPtr], [uint32]); D 'AssignProcessToJobObject' ([bool]) @([IntPtr], [IntPtr]); D 'GetCurrentProcess' ([IntPtr]) @(); " +
  "$t = $tb.CreateType(); $job = $t::CreateJobObjectW([IntPtr]::Zero, [IntPtr]::Zero); if ($job -eq [IntPtr]::Zero) { throw 'CreateJobObject failed' }; " +
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on a 64-bit process and
  // 112 on a 32-bit one; LimitFlags sits at offset 16 in both.
  "$size = if ([IntPtr]::Size -eq 8) { 144 } else { 112 }; " +
  "$info = [Runtime.InteropServices.Marshal]::AllocHGlobal($size); for ($i = 0; $i -lt $size; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($info, $i, 0) }; [Runtime.InteropServices.Marshal]::WriteInt32($info, 16, 0x2800); " +
  "if (-not $t::SetInformationJobObject($job, 9, $info, $size)) { throw 'SetInformationJobObject failed' }; " +
  "if (-not $t::AssignProcessToJobObject($job, $t::GetCurrentProcess())) { throw 'AssignProcessToJobObject failed' } " +
  "} catch { Write-Warning ('minidsh: what this command starts is not contained: ' + $_.Exception.Message) }; " +
  "try { while ($Error.Count -gt $n) { $Error.RemoveAt(0) } } catch {}"

/**
 * The line itself: the body runs as a script block of its OWN, decoded from
 * base64. pwsh writes any script block it finds suspicious — and reflection
 * plus `kernel32` is exactly that — to the PowerShellCore/Operational event
 * log, which other interactive users of the machine can read; inline, the
 * whole `-Command` text was that block, so every Windows job and one-shot
 * COMMAND, secrets and all, was logged (S21.1 review, measured as event 4104).
 * Now only the body is. Under Constrained Language Mode nothing is invoked at
 * all — the type builder would be refused anyway — so the warning is the
 * whole line, and `$Error` stays exactly as the command will find it.
 */
export const PWSH_CONTAINMENT =
  `if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(CONTAINMENT_BODY, 'utf8').toString('base64')}')))) } ` +
  "else { Write-Warning ('minidsh: what this command starts is not contained: this PowerShell runs in ' + $ExecutionContext.SessionState.LanguageMode) }; "

/**
 * A child's exit code as its program gave it. Windows hands Node the code as
 * an unsigned 32-bit number, so a program that exited -4058 (npm's errno for
 * a missing package.json) read 4294963238 from a one-shot or a job, while the
 * persistent child, whose marker carries what PowerShell printed, said -4058.
 * Folded back to signed there; a POSIX code is 0 to 255 and is left alone.
 */
function exitCodeOf(code: number | null): number | null {
  return code === null || process.platform !== 'win32' ? code : code | 0
}

/** The containment line, where it applies: pwsh on Windows (a POSIX child leads its own process group instead). */
function containment(dialect: ShellDialect): string {
  return dialect === 'pwsh' && process.platform === 'win32' ? PWSH_CONTAINMENT : ''
}

/**
 * The same shell, asked to run exactly one command and exit: the one-shot
 * grant's shape, and a job's. pwsh gets the persistent child's encoding
 * line first: without it PowerShell writes its own text in the OEM code page,
 * which a host on CP936 delivered to the model as replacement characters
 * (measured 2026-10-15). Guarded, because a console setting can throw where
 * there is no console; the command's own exit code is unchanged. Then, on
 * Windows, the containment line (`PWSH_CONTAINMENT`).
 *
 * `started`, given only for a child that runs inside a confinement wrapper,
 * is a line the shell prints before it reads the command: the one-shot's and
 * the job's form of the persistent child's ready marker (`StartLine`). In
 * bash it is a line of its own, so it is printed before the command is even
 * parsed.
 */
function oneShotCommand(dialect: ShellDialect, shellPath: string | undefined, command: string, started?: string): { cmd: string; args: string[] } {
  if (dialect === 'pwsh') {
    const utf8 = 'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}; $OutputEncoding = [Text.Encoding]::UTF8; '
    const announce = started === undefined ? '' : `Write-Output '${started}'; `
    // `pwsh -Command` ends by `$?`: 0, or 1 whatever a failing native program
    // returned (`node` exiting 3 was reported as 1, measured S22.5), while the
    // persistent child reports that program's own code. On Windows every
    // approved command is a one-shot, so this is the code the model usually
    // reads. `$?` is taken FIRST: any statement of ours would replace it. An
    // `exit` or a terminating error in the command never reaches this line.
    //
    // The code is SET on the host, never `exit`ed with: `exit` ends the
    // script before PowerShell has written what it was still formatting (any
    // table: `Get-ChildItem | Select-Object ...`, a pscustomobject), so a
    // listing followed by a failing program came back empty beside a correct
    // exit code, exactly when the command failed. Measured on 16 shapes, pwsh
    // 7.6: `exit` lost lines in 5 (202 of 202 in one), `SetShouldExit` in
    // none, and both gave the same code in all 16.
    //
    // Constrained Language Mode refuses the method call ("supported only on
    // core types", measured), which would lose the code and print that error
    // after every failing command: there the keyword is what is left.
    const exitCode =
      "\n$minidshOk = $?; if (-not $minidshOk) { $minidshCode = $(if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }); if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { $Host.SetShouldExit($minidshCode) } else { exit $minidshCode } }"
    return { cmd: shellPath ?? 'pwsh', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', utf8 + containment(dialect) + announce + command + exitCode] }
  }
  return { cmd: shellPath ?? 'bash', args: ['--noprofile', '--norc', '-c', started === undefined ? command : `printf '%s\\n' '${started}'\n${command}`] }
}

/**
 * The start line of a wrapped one-shot or job, taken off the head of its
 * stdout.
 *
 * A wrapper that cannot start (bwrap refused a namespace, a bind's source is
 * gone) prints its own diagnostic and exits non-zero without running
 * anything, and that is a refusal with its own code and remedy. But the only
 * evidence used to be the text, so a command that RAN, printed `bwrap: ...`
 * and failed was reported as a wrapper that never started: refused, with an
 * install hint, and no record of having run. The shell inside the wrapper
 * now says it started, on stdout, before the command's first byte; a child
 * that printed the line ran its command, whatever it printed afterwards.
 *
 * The line is the first thing written to that pipe and far shorter than a
 * pipe's atomic write, so it arrives whole at the head of the first chunk;
 * the undecided prefix is still held until it can be told apart, and anything
 * that turns out not to be the line is passed on as the output it is.
 */
class StartLine {
  /** True once the line arrived: the shell inside the wrapper ran. */
  seen = false
  private head: string | undefined = ''
  private readonly marker: string

  constructor(marker: string) {
    this.marker = marker
  }

  /** A stdout chunk, less the start line. */
  take(chunk: string): string {
    if (this.head === undefined) return chunk
    const head = this.head + chunk
    const lineEnd = head.startsWith(this.marker) ? /^\r?\n/.exec(head.slice(this.marker.length)) : null
    if (lineEnd !== null) {
      this.seen = true
      this.head = undefined
      return head.slice(this.marker.length + lineEnd[0].length)
    }
    // Still a prefix of the line (its line end included): wait for the rest.
    if (`${this.marker}\r\n`.startsWith(head) || `${this.marker}\n`.startsWith(head)) {
      this.head = head
      return ''
    }
    this.head = undefined
    return head
  }

  /** At the stream's end: a held prefix that never became the line was output. */
  rest(): string {
    const held = this.head ?? ''
    this.head = undefined
    return held
  }
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
    // The containment line before the marker, so no command can run outside
    // the Job; a warning it prints lands before the marker too, and is kept
    // for the first command's output (`answered`).
    return `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Continue'; ${containment(dialect)}Write-Output '${ready}'\n`
  }
  return `export LC_ALL=C.UTF-8 2>/dev/null; printf '%s\\n' '${ready}'\n`
}

/**
 * One command, framed: run it, then print the marker line with its exit code.
 *
 * pwsh has no one number for "how the command ended", so the code is built
 * from what can be known. A native program's exit code is `$LASTEXITCODE`.
 * An error that TERMINATED the command (a `throw`, a parse error, a cmdlet
 * under `-ErrorAction Stop`) lands in the wrapper's own catch, and is 1: the
 * marker used to be printed after the try statement from `$?`, which is the
 * try statement's own and always true, so every such command was reported as
 * a success beside its error text (measured 2026-11-21: `throw`, `1/0` and
 * `if (` all answered 0, where a one-shot exits 1). What still cannot be
 * told is a cmdlet's NON-terminating error (`Get-Item` of a missing path):
 * `$?` after `Invoke-Expression` is Invoke-Expression's, which succeeded, so
 * that command reports 0 and its error is in the output.
 */
function wrapper(dialect: ShellDialect, base64: string, marker: string): string {
  if (dialect === 'pwsh') {
    return (
      `$global:LASTEXITCODE=$null; ` +
      `try { Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64}'))); ` +
      `Write-Output ('${marker}:' + $(if($LASTEXITCODE -ne $null){$LASTEXITCODE}else{'0'})) } ` +
      `catch { Write-Output ($_ | Out-String); Write-Output ('${marker}:' + $(if($LASTEXITCODE){$LASTEXITCODE}else{'1'})) }\n`
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

/** How much of a child's start-up output is kept: the containment warning is in its first lines, and a start-up failure quotes 200 characters. */
const STARTUP_KEEP_CHARS = 8_192

/**
 * What the persistent child printed for ONE command, bounded WHILE it prints.
 *
 * The bound used to be applied when the command ended, to a string that had
 * grown without one. A command that prints faster than it is read (`yes`, a
 * log `cat`) took that string to V8's limit, about 512 MB, inside a stream's
 * `'data'` listener: an uncaught RangeError, which ends the host and every
 * session it serves. So the first `max` characters are kept and the rest is
 * dropped as it arrives, and `overflowed` says that happened.
 *
 * Both marker lines are therefore looked for HERE, on arrival: once the text
 * is no longer kept there is nothing left for a poll to search. A chunk
 * boundary can fall inside a marker line, so the stream's last `hold`
 * characters are held back until the next chunk shows whether a line was
 * starting in them; that is all the scan needs beyond the bound.
 *
 * After the end marker nothing is kept at all: what a backgrounded process
 * prints between two commands is no command's output.
 */
class Capture {
  /** True once the command printed more than is kept. */
  overflowed = false
  /** The command's exit code, once its marker line has arrived whole. */
  exitCode: number | undefined
  /** False while a fresh child's ready line is still awaited. */
  ready: boolean
  private kept = ''
  private held = ''
  private startup = ''
  private readonly max: number
  private readonly hold: number
  private readonly readyLine: RegExp | undefined
  private readonly endLine: RegExp

  constructor(max: number, marker: string, readyMarker: string | undefined) {
    this.max = max
    this.ready = readyMarker === undefined
    this.readyLine = readyMarker === undefined ? undefined : new RegExp(`${readyMarker}\\r?\\n`)
    // The code must be followed by something that is not a digit: a chunk
    // that ended after `:1` of `:127` would otherwise end the command with
    // the wrong code.
    this.endLine = new RegExp(`${marker}:(-?\\d+)\\D`)
    // A whole marker line and room to spare: the marker, a colon, a signed
    // 32-bit code and a line end.
    this.hold = Math.max(marker.length, readyMarker?.length ?? 0) + 16
  }

  push(data: string): void {
    if (this.exitCode !== undefined) return
    let text = this.held + data
    this.held = ''
    if (!this.ready) {
      const line = this.readyLine!.exec(text)
      if (line === null) {
        text = this.holdBack(text)
        this.startup = clip(this.startup + text, STARTUP_KEEP_CHARS)
        return
      }
      this.startup = clip(this.startup + text.slice(0, line.index), STARTUP_KEEP_CHARS)
      this.ready = true
      text = text.slice(line.index + line[0].length)
    }
    const end = this.endLine.exec(text)
    if (end !== null) {
      this.keep(text.slice(0, end.index))
      this.exitCode = Number(end[1])
      return
    }
    this.keep(this.holdBack(text))
  }

  /** Everything but the last `hold` characters, which stay held; a pair is never split between the two. */
  private holdBack(text: string): string {
    let at = Math.max(0, text.length - this.hold)
    const before = text.charCodeAt(at - 1)
    if (before >= 0xd800 && before <= 0xdbff) at--
    this.held = text.slice(at)
    return text.slice(0, at)
  }

  private keep(text: string): void {
    // Nothing after the first drop: a later, shorter piece that happened to
    // fit would land out of order.
    if (this.overflowed) return
    const room = this.max - this.kept.length
    if (text.length > room) this.overflowed = true
    this.kept += clip(text, room)
  }

  /**
   * What the command printed, as far as it was kept. Once something was
   * dropped the held tail is no longer the continuation of the head, so it
   * is left out; before the ready line nothing is the command's yet.
   */
  output(): string {
    if (!this.ready) return ''
    return this.overflowed ? this.kept : this.kept + this.held
  }

  /** What the child printed before its ready line: start-up noise, or the reason it never answered. */
  startupText(): string {
    return this.ready ? this.startup : this.startup + this.held
  }
}

/**
 * Spread into `spawn` options. Always an explicit env: inheriting wholesale
 * is what this stopped doing. The overlay is the confinement's (`envFor`),
 * applied after the scrub: a value is set, and a name it maps to `undefined`
 * is taken out.
 */
function envOption(declared: readonly string[], overlay: Readonly<Record<string, string | undefined>> | undefined): { env: NodeJS.ProcessEnv } {
  const env = childEnvironment(declared, undefined)
  for (const [name, value] of Object.entries(overlay ?? {})) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
  return { env }
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
  /** A warning the live child printed before its ready marker, owed to the next command's output. */
  private startupNotice: string | undefined
  /** Where the live child's output goes: the command in flight, or the last one, which keeps nothing more. */
  private capture: Capture | undefined
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
      // A refusal here is where the tool offers an escalation, and with the
      // folder gone the approved command would fail the same way: the folder
      // is the fact to report, before anyone's consent is spent.
      const gone = this.workspaceGone()
      if (gone !== undefined) throw gone
      // The remedy rides the refusal a person or a model meets FIRST: on a
      // Linux host without bubblewrap this sentence is all they are told.
      const remedy = this.confinement.remedy === undefined ? '' : `; ${this.confinement.remedy}`
      throw new SandboxError(
        'SANDBOX_UNAVAILABLE',
        enforcement === 'none'
          ? `this host has no confinement backend, so a command cannot run under "${policy.mode}" mode${remedy}`
          : `this host enforces "${policy.mode}" only "${enforcement}", and this session requires "${accepts}"`,
      )
    }
    return enforcement
  }

  /**
   * The refusal for a session whose workspace folder is gone (deleted,
   * renamed, on a drive no longer mounted), or `undefined` while it is there.
   *
   * Node reports a missing `cwd` as the same ENOENT as a missing binary, so
   * every command of such a session answered "install bash" or "install
   * PowerShell 7", and under a wrapper SANDBOX_UNAVAILABLE "install
   * bubblewrap" with an escalation offered: a person was then asked to
   * approve a wider mode for a command that failed the same way. Always the
   * shell's code, never the sandbox's, so nothing offers an escalation.
   */
  private workspaceGone(): ShellError | undefined {
    try {
      if (statSync(this.cwd).isDirectory()) return undefined
    } catch (error) {
      // Only absence is this refusal's fact; a folder that cannot be examined is not known to be gone.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined
    }
    return new ShellError('SHELL_UNAVAILABLE', `this session's workspace folder ${this.cwd} no longer exists; nothing ran`)
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
    // A new child's output belongs to the command that is about to be given
    // it (`runOne` sets its capture in this same turn), never to the last one.
    this.capture = undefined
    // Identity-guarded: output from a killed child never lands in the live capture.
    const append = (data: string): void => {
      if (this.child === child) this.capture?.push(data)
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
    // A missing `cwd` is reported exactly as a missing binary is (ENOENT on
    // the spawn), so the folder is asked before anyone is told to install
    // what is installed (`workspaceGone`).
    if (kind === 'missing') {
      const gone = this.workspaceGone()
      if (gone !== undefined) return gone
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return this.startupFailure(cmd, wrapped, `could not be started (${code ?? (error instanceof Error ? error.message : String(error))})`)
  }

  /**
   * The child's ready line has arrived (`Capture` consumed it): what preceded
   * it is start-up noise, and what follows is the first command's.
   */
  private answered(capture: Capture): void {
    // Start-up noise is dropped — except the containment line's own warning,
    // the one thing in it a reader must not lose: this shell's descendants are
    // not contained here, so it heads the first command's output.
    const notice = capture
      .startupText()
      .split(/\r?\n/)
      .find((line) => line.includes('minidsh:'))
    // pwsh colours a warning even into a pipe; `printableText` would keep the
    // CSI parameters as literal `[33;1m` text, so the sequences go first (the
    // ESC is matched on purpose: it is the thing being removed).
    // oxlint-disable-next-line no-control-regex
    if (notice !== undefined) this.startupNotice = printableText(notice.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).trim()
    this.fresh = false
  }

  /** One coded refusal for "the thing we spawned never worked", named for what it was. */
  private startupFailure(cmd: string, wrapped: boolean, what: string): Error {
    if (wrapped) {
      return new SandboxError(
        'SANDBOX_UNAVAILABLE',
        `the confinement wrapper "${cmd}" ${what}, so a command cannot run confined on this host; ${confinementRemedy(this.confinement.id)}`,
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
    const marker = `${this.markerBase}${++this.commandSeq}`
    // One capture per command, replacing the last: whatever a backgrounded
    // process printed between the two was never this command's.
    const capture = new Capture(this.maxCaptureChars, marker, this.fresh ? this.readyMarker : undefined)
    this.capture = capture
    const base64 = Buffer.from(request.command, 'utf8').toString('base64')
    child.stdin.write(wrapper(this.dialect, base64, marker))
    const startedAt = Date.now()

    const deadline = Date.now() + (request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    for (;;) {
      if (this.fresh && capture.ready) this.answered(capture)
      if (capture.exitCode !== undefined) {
        return this.finalize(capture.output(), { exitCode: capture.exitCode, timedOut: false, reset: false, restarted, startedAt, cut: capture.overflowed }, sandbox)
      }
      // The shell itself died (e.g. the command was `exit`): report immediately
      // instead of polling until the deadline — once its pipes have delivered
      // what it wrote, which the exit can outrun.
      if (child.exitCode !== null || child.killed) {
        await Promise.race([closed, sleep(DRAIN_MS)])
        if (this.fresh && capture.ready) this.answered(capture)
        const output = capture.output()
        const code = child.exitCode
        const wrapped = this.childWrapped
        this.child = undefined
        this.childWorld = undefined
        this.capture = undefined
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
          const trimmed = capture.startupText().trim()
          const runnerFailed = wrapped && this.isRunnerFailure(trimmed)
          throw this.startupFailure(
            runnerFailed ? this.confinement.id : (this.shellPath ?? this.dialect),
            runnerFailed,
            `exited (code ${code ?? 'unknown'}) before it answered${trimmed.length > 0 ? `: ${clip(trimmed, 200)}` : ''}`,
          )
        }
        return this.finalize(output, { timedOut: false, reset: true, restarted, startedAt, cut: capture.overflowed }, sandbox)
      }
      // `durationMs` is stamped HERE, before the reset: killing and reaping
      // the child can take seconds, and charging that to the command would
      // report a 120 s deadline as "timed out, 120.9s". The output is taken
      // here too: the reset lets go of the capture.
      if (request.signal?.aborted || Date.now() > deadline) {
        const timedOut = request.signal?.aborted !== true
        const durationMs = Date.now() - startedAt
        const output = capture.output()
        return this.finalize(output, { timedOut, reset: await this.reset(), restarted, startedAt, durationMs, cut: capture.overflowed }, sandbox)
      }
      await sleep(POLL_MS)
    }
  }

  /**
   * One command, one child, under a policy that is not this session's.
   *
   * No marker framing: the process exits when the command does, so its exit
   * code IS the command's (pwsh needs a line of help to say a native
   * program's code: `oneShotCommand`) and its pipes carry the whole output. That is also
   * why an approved escalation leaves no shell state behind — a grant that
   * covers one call should not be able to.
   */
  private async runOneShot(request: ShellExecRequest, sandbox: ShellRunResult['sandbox']): Promise<ShellRunResult> {
    const { cmd, args, wrapped } = this.oneShotArgv(request.command, request.policy)
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
    const ended = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(exitCodeOf(code))))
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
      // Bounded as it arrives, for `Capture`'s reason: a string that grew
      // until the command ended is how one large output ended the host.
      let output = ''
      let cut = false
      const append = (data: string): void => {
        if (cut) return
        const room = this.maxCaptureChars - output.length
        if (data.length > room) cut = true
        output += clip(data, room)
      }
      const started = wrapped ? new StartLine(this.readyMarker) : undefined
      stdout.on('data', started === undefined ? append : (data: string) => append(started.take(data)))
      stderr.on('data', append)
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
      const code = await ended
      // A wrapper that could not start printed its own line and never ran the
      // command; the shell's own failures are not this refusal's business. A
      // child whose start line arrived ran its command (`StartLine`), and the
      // exit can outrun that line, so the pipes get their grace before a
      // command that may have run is called one that never did.
      if (started !== undefined) {
        if (code !== 0 && !started.seen) await Promise.race([closed, sleep(DRAIN_MS)])
        append(started.rest())
        if (code !== 0 && !started.seen && this.isRunnerFailure(output.trim())) {
          throw this.startupFailure(this.confinement.id, true, `exited (code ${code ?? 'unknown'}): ${clip(output.trim(), 200)}`)
        }
      }
      // `reset` is about the persistent shell, and this call never touched it.
      return this.finalize(output, { ...(code === null ? {} : { exitCode: code }), timedOut, reset: false, restarted: false, startedAt, cut }, sandbox)
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
      this.oneShotChildren.delete(child)
      this.pruneGroups()
      // The call is over, and so is its capture: a descendant the command
      // backgrounded may hold these pipes for as long as it lives, and each
      // chunk it wrote was still being read here until disposal.
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
  }

  /**
   * The argv of a one-shot or a job: the one-command shell, inside this
   * world's wrapper when the policy is a confined one. A wrapped shell is
   * also asked to announce itself (`StartLine`).
   */
  private oneShotArgv(command: string, policy: SandboxExecutionPolicy): { cmd: string; args: string[]; wrapped: boolean } {
    const announced = oneShotCommand(this.dialect, this.shellPath, command, this.readyMarker)
    const inside = this.confinement.wrap(announced.cmd, announced.args, policy)
    // Not wrapped (no backend, or a mode that is never confined): nothing can
    // fail to start but the shell itself, so it has nothing to announce.
    if (inside.cmd === announced.cmd) return { ...oneShotCommand(this.dialect, this.shellPath, command), wrapped: false }
    return { ...inside, wrapped: true }
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
    const { cmd, args, wrapped } = this.oneShotArgv(request.command, request.policy)
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
    // command that failed; the output itself goes straight to the caller, so
    // nothing of a job's is held here beyond them.
    let opening = ''
    const forward = (chunk: string): void => {
      if (chunk.length === 0) return
      if (opening.length < 2_000) opening += clip(chunk, 2_000 - opening.length)
      request.output(chunk)
    }
    const started = wrapped ? new StartLine(this.readyMarker) : undefined
    stdout.on('data', started === undefined ? forward : (chunk: string) => forward(started.take(chunk)))
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
          // By now the pipes have closed or had their grace, so a start line
          // that was written has arrived: a job that printed it RAN, whatever
          // it printed after (`StartLine`).
          if (started !== undefined) forward(started.rest())
          const failed = started !== undefined && code !== 0 && !started.seen && this.isRunnerFailure(opening.trim())
          const exitCode = exitCodeOf(code)
          resolve({
            ...(exitCode === null ? {} : { exitCode }),
            ...(signal === null ? {} : { signal }),
            ...(failed ? { failure: `the confinement runner "${this.confinement.id}" failed: ${clip(opening.trim(), 200)}` } : {}),
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
   * The conjunction is nonzero exit + wrapped + a child that never said it
   * started (the ready line, or a one-shot's `StartLine`: the callers' part)
   * + the wrapper's own diagnostic OPENING what was printed, which is where a
   * wrapper that dies before it runs anything puts it. Minus the one
   * diagnostic that is about the wrapped program rather than the wrapper:
   * `bwrap: execvp bash: No such file or directory` is a MISSING SHELL
   * reported in bwrap's voice, and calling it a sandbox failure sends the
   * model to escalate — which would spawn the same missing shell unconfined
   * and fail again, after spending someone's consent.
   */
  private isRunnerFailure(text: string): boolean {
    const opening = text.trimStart().split('\n', 1)[0]!.toLowerCase()
    if (opening.startsWith('bwrap: execvp ')) return false
    return this.confinement.runnerFailureSignatures.some((signature) => opening.startsWith(signature))
  }

  private finalize(
    raw: string,
    extra: { exitCode?: number; timedOut: boolean; reset: boolean; restarted: boolean; startedAt: number; durationMs?: number; cut: boolean },
    sandbox: ShellRunResult['sandbox'],
  ): ShellRunResult {
    const notice = this.startupNotice
    this.startupNotice = undefined
    const body = raw.replace(/^\n+/, '').replace(/\n+$/, '')
    const trimmed = notice === undefined ? body : body.length === 0 ? notice : `${notice}\n${body}`
    // A MEMORY bound, not a context bound. What the model should see is the
    // tool's decision, and it cannot make it from output the executor already
    // threw away — so everything captured is returned, and `truncated` reports
    // only that the process outran this buffer. The bound itself is applied
    // as the output arrives (`Capture`, `extra.cut`); here it is only said.
    const truncated = extra.cut || trimmed.length > this.maxCaptureChars
    const output = truncated
      ? `${clip(trimmed, this.maxCaptureChars)}\n[output stopped at ${this.maxCaptureChars} captured characters: the command printed more, and the rest was not kept]`
      : trimmed
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
    this.capture = undefined
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
