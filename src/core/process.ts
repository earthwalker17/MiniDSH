/**
 * A process the harness spawns for itself: how it is started, the environment
 * it gets and how its tree dies.
 *
 * Two spawners need the same three rules — the shell world (`shell-stdio`: the
 * persistent child, one-shots and jobs) and the browser (`tool-browser`), and
 * capabilities may not import each other. Forking any rule would let them
 * drift: the start rule is what keeps a refused spawn from crashing the host
 * (it did, at four sites, until S20.5), the environment rule is an
 * authority-adjacent decision (S16.5), and the kill rules carry measured
 * platform facts (`taskkill` latency, a tree reachable only while its root
 * lives). So they live here, once, as helpers with no service: which names are
 * SECRET stays `core/credentials`' (`declaredRefs`), passed in by each caller
 * at each spawn.
 */
import { ChildProcess, spawn, type SpawnOptions } from 'node:child_process'
import { join } from 'node:path'

/** `spawn`'s one shape every harness spawner uses; a test passes its own to stage what Node does under load. */
export type Spawner = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

/** A child, and whether it became a process. */
export interface Spawning {
  readonly child: ChildProcess
  /**
   * Resolves on `'spawn'`; rejects with the spawn's own error (its `code` is
   * what `spawnRefusal` reads). Already marked handled, so a caller that
   * never awaits it — a disposal racing the start — raises nothing.
   */
  readonly spawned: Promise<void>
}

/**
 * Start a child so that nothing it does can take the host down.
 *
 * Synchronous on purpose: a caller that must register the child somewhere
 * disposal finds it (a job's reap set, `shell-stdio` start) does so in the
 * same tick as the spawn, THEN awaits `spawned`, and only then touches a pipe.
 * Three facts, each measured on Node 24.19, are why that order is the only
 * safe one:
 *
 *   - **A refused spawn reports on the NEXT tick.** ENOENT, EACCES and EAGAIN
 *     arrive as an `'error'` event after `spawn` has returned, and an
 *     `'error'` with no listener crashes the process. So the listener is
 *     attached here, before the caller can run a line, and stays: a child
 *     that errs later (a signal it cannot be sent) is heard too.
 *   - **Out of descriptors, the child has NO PIPES.** On EMFILE or ENFILE
 *     Node returns before building `stdio`, so `pid`, `stdio`, `stdout` and
 *     the rest are `undefined`, and the `'error'` follows a tick later. Every
 *     spawner read a pipe first (`child.stdout.setEncoding`, `child.stdio[3]`)
 *     and threw a TypeError while that `'error'` crashed the host — the review
 *     reproduced it under `ulimit -n` for the shell, its one-shots, its jobs
 *     and the browser. Such a child is treated as never spawned, whatever it
 *     emits.
 *   - **A pipe errs on its own.** A write still queued to a child that died
 *     raises EPIPE (POSIX) or `write EOF` (Windows) on its stdin; a command
 *     over ~48 KB cancelled while pwsh was still starting crashed the host
 *     that way. Every pipe that exists gets a listener, and the error carries
 *     nothing a caller needs: a dead child is read from its exit.
 *
 * A spawn Node refuses SYNCHRONOUSLY (a NUL byte in an argument, ENOMEM, an
 * argv past the OS limit) is given the same shape it gives EMFILE — a child
 * with no pid and no pipes whose `spawned` rejects — so every caller has one
 * failure path, not two.
 */
export function spawnChild(command: string, args: readonly string[], options: SpawnOptions, spawner: Spawner = spawn): Spawning {
  let child: ChildProcess
  try {
    child = spawner(command, args, options)
  } catch (error) {
    const spawned = Promise.reject(error)
    spawned.catch(heard)
    return { child: new ChildProcess(), spawned }
  }
  // Read now, not at 'spawn': Node's pipeless child waits for its 'error'.
  const pipeless = child.stdio === undefined
  const spawned = new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.once('spawn', () => (pipeless ? reject(new Error(`spawn ${command}: the child has no pipes`)) : resolve()))
  })
  spawned.catch(heard)
  for (const stream of child.stdio ?? []) stream?.on('error', heard)
  return { child, spawned }
}

/** A listener whose only job is to be one: an `'error'` nobody hears crashes the process. */
const heard = (): void => {}

/**
 * Why a spawn was refused, in the only terms a caller acts on. A TRANSIENT
 * refusal is the host's MOMENT — out of descriptors or processes, out of
 * memory — so the same spawn may work a second later, and nothing may be
 * remembered or told to install anything. A MISSING one is the host's FACT:
 * the binary is not there, or not runnable. A COMMAND one is the arguments':
 * too long for one argv (E2BIG, ENAMETOOLONG on Windows past 32,767
 * characters) or carrying a NUL Node will not pass — the same spawn fails the
 * same way under any mode, so nothing about the host may be said of it.
 */
export function spawnRefusal(error: unknown): 'transient' | 'missing' | 'command' | 'other' {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EMFILE' || code === 'ENFILE' || code === 'EAGAIN' || code === 'ENOMEM') return 'transient'
  if (code === 'ENOENT' || code === 'EACCES') return 'missing'
  if (code === 'E2BIG' || code === 'ENAMETOOLONG' || code === 'ERR_INVALID_ARG_VALUE' || code === 'ERR_INVALID_ARG_TYPE') return 'command'
  return 'other'
}

/** What a transient refusal tells the model: nothing ran, the host is at a limit, and the remedy is time. */
export function transientSpawnText(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code ?? 'EAGAIN'
  return `could not be started (${code}): this host is out of file descriptors or processes for the moment, so nothing ran; the same call can be tried again once the load passes`
}

/**
 * The environment a child gets: the harness's, minus what MiniDSH itself
 * owns, plus whatever the caller adds.
 *
 * Two removals, one rule each. **Secrecy**: the credential references this
 * deployment DECLARED (`ctx.credentials`, the only thing that can know a row
 * renamed its own `apiKeyEnv`) — exactly those, and nothing for merely
 * looking like one. `GOOGLE_APPLICATION_CREDENTIALS`, a `MOONSHOT_API_KEY` no
 * mounted row reads, a `PASSWORD` in the user's profile all pass: they are the
 * user's, not the harness's, and the shell child is the user's shell. A key is
 * withheld exactly while a row that declares it is MOUNTED — `OPENAI_API_KEY`
 * since the OpenAI adapter became a shipped row (S18), `TAVILY_API_KEY` only
 * where the opt-in search row is. (S16.5
 * deleted the `/KEY|TOKEN|SECRET|PASSWORD/i` heuristic upstream still ships:
 * a variable withheld for its NAME broke ordinary work — a path-valued
 * `*_CREDENTIALS` first — while withholding no credential MiniDSH consumes.)
 * **Identity**: `MINIDSH_*`, so a command cannot read — or nest a harness
 * against — this process's own home and route. That is the one withheld name
 * that is not a credential, kept on purpose.
 *
 * On win32 names are compared case-insensitively, because the environment
 * is: `credentials-local` resolves `process.env[ref]`, which finds
 * `Deepseek_Api_Key` for `DEEPSEEK_API_KEY` there, and a scrub comparing
 * exact spellings handed that very value to every child.
 *
 * The caller's overlay merges AFTER: today that is the confinement's `envFor`
 * (the `TMPDIR` a profile granted). And the limit is real and stated (§13):
 * this withholds VARIABLES, not credentials. Reads are never fenced, so
 * `~/.minidsh/credentials.json` is still readable, and the network is open.
 * Defence in depth, not a boundary.
 */
export function childEnvironment(declared: readonly string[], overlay: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const fold = process.platform === 'win32' ? (name: string): string => name.toUpperCase() : (name: string): string => name
  const withheld = new Set(declared.map(fold))
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (withheld.has(fold(name)) || name.toUpperCase().startsWith('MINIDSH_')) continue
    env[name] = value
  }
  return { ...env, ...overlay }
}

/**
 * Kill a child AND what it started, where the platform can say so.
 *
 * A child spawned `detached` on POSIX leads its own process group, so a
 * negative pid signals the group — the difference between reaping a shell and
 * reaping a shell that backgrounded something. On Windows there are no
 * groups, so `taskkill /T` walks the tree by parent link — which works only
 * while the root is ALIVE, so it runs first and the single-child kill is the
 * fallback, never alongside it. It is run by absolute path: a `taskkill` on
 * PATH is whatever the PATH says. Resolves when the killer itself is done.
 */
export function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return Promise.resolve()
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return Promise.resolve()
    } catch {
      // No group (never detached): the single-child kill below.
    }
    child.kill('SIGKILL')
    return Promise.resolve()
  }
  const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  return new Promise((resolve) => {
    const fallback = (): void => {
      if (child.exitCode === null) child.kill('SIGKILL')
      resolve()
    }
    const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    killer.once('error', fallback)
    killer.once('exit', (code) => (code === 0 ? resolve() : fallback()))
  })
}

/**
 * Kills a child and waits for it, AND the killer, to finish — on Windows the
 * tree's descendants hold the workspace directory until they are gone, which
 * is the lock this wait exists to release. Bounded: a process that will not
 * die is reported by whoever needed it dead, not waited on forever. The bound
 * is longer on Windows because the tree kill there is a PROCESS (`taskkill`),
 * ~0.3 s on an idle host and seconds on a loaded one (measured 2026-10-15):
 * returning before it finished handed the caller a directory still locked.
 * A child with no pid never became a process (`spawnChild`), so there is
 * nothing to wait for: its `'exit'` never comes.
 */
export function killAndWait(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.killed || child.pid === undefined) return Promise.resolve()
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<void>((resolve) => (timer = setTimeout(resolve, process.platform === 'win32' ? 10_000 : 2_000)))
  return Promise.race([Promise.all([exited, killTree(child)]).then(() => undefined), bound]).finally(() => clearTimeout(timer))
}
