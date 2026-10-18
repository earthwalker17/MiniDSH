/**
 * A process the harness spawns for itself: the environment it gets and how its
 * tree dies.
 *
 * Two spawners need the same two rules — the shell world (`shell-stdio`: the
 * persistent child, one-shots and jobs) and the browser (`tool-browser`), and
 * capabilities may not import each other. Forking either rule would let them
 * drift: the environment rule is an authority-adjacent decision (S16.5), and
 * the kill rules carry measured platform facts (`taskkill` latency, a tree
 * reachable only while its root lives). So they live here, once, as helpers
 * with no service: which names are SECRET stays `core/credentials`'
 * (`declaredRefs`), passed in by each caller at each spawn.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'

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
 */
export function killAndWait(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.killed) return Promise.resolve()
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<void>((resolve) => (timer = setTimeout(resolve, process.platform === 'win32' ? 10_000 : 2_000)))
  return Promise.race([Promise.all([exited, killTree(child)]).then(() => undefined), bound]).finally(() => clearTimeout(timer))
}
