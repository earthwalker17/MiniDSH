/**
 * The runtime's environment, built from main's, and the one thing main's own
 * environment must say (`exemptLoopbackFromProxy`). No Electron, so both are
 * tested on any host.
 *
 * Owns: what main passes on to the runtime (and, through the runtime's own
 * rule in core/process.ts, to an agent's shell), and that main's loopback
 * requests go around an environment proxy. Must not own: secrets (the
 * runtime's credentials plane) or anything the runtime scrubs itself.
 *
 *   - The bundled Node's directory is APPENDED to PATH: a person's own `node`
 *     is found first, and a machine without one still runs the bundled office
 *     and pdf skills (they run `node <script>`).
 *   - Electron's own run-as-Node switch never reaches the runtime.
 *   - Inside an AppImage, AppRun prepends its mount (`$APPDIR/...`) to PATH,
 *     LD_LIBRARY_PATH, XDG_DATA_DIRS and friends and exports its own names:
 *     an agent's git or compiler would then load the bundle's libraries before
 *     the system's. Those entries and names are removed (S22.2 review).
 */
import { delimiter as hostDelimiter } from 'node:path'

const APPIMAGE_NAMES = ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']
const SEARCH_PATHS = ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR', 'QT_PLUGIN_PATH', 'PERLLIB', 'PYTHONPATH', 'GST_PLUGIN_SYSTEM_PATH', 'GST_PLUGIN_SYSTEM_PATH_1_0']

/**
 * Main's own requests (the sign-in, the inspection) go to 127.0.0.1 carrying
 * the launch token and the cookie, and an environment proxy must never see
 * them: Node honours `NODE_USE_ENV_PROXY` with `HTTP_PROXY`. Its proxy agent
 * reads the LOWERCASE `no_proxy` first and the uppercase only when that one
 * is unset, so on a host whose environment is case-sensitive a `no_proxy`
 * that lacks loopback, even an empty one, would win over anything written to
 * `NO_PROXY` alone. Both spellings are therefore made to exempt it.
 *
 * A spelling that was NOT set takes the other one's entries first. Created
 * holding loopback alone, it would shadow them for every reader that prefers
 * it: this environment is also the runtime's and every agent shell's, and a
 * person whose `NO_PROXY=corp.example` kept their git and curl off the proxy
 * would have found a new `no_proxy=127.0.0.1` sending them through it.
 *
 * Changes `env` in place (it is `process.env`, where Windows keeps one
 * variable under both spellings: the second pass then finds the entry already
 * there).
 */
export function exemptLoopbackFromProxy(env: NodeJS.ProcessEnv): void {
  const entriesOf = (value: string | undefined): string[] | undefined =>
    value === undefined
      ? undefined
      : value
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
  const upper = entriesOf(env.NO_PROXY)
  const lower = entriesOf(env.no_proxy)
  for (const [name, own, other] of [
    ['NO_PROXY', upper, lower],
    ['no_proxy', lower, upper],
  ] as const) {
    const entries = [...(own ?? other ?? [])]
    if (!entries.includes('127.0.0.1')) entries.push('127.0.0.1')
    env[name] = entries.join(',')
  }
}

export function runtimeEnv(base: NodeJS.ProcessEnv, nodeDir: string, delimiter: string = hostDelimiter): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  delete env.ELECTRON_RUN_AS_NODE
  const appDir = env.APPIMAGE !== undefined ? env.APPDIR : undefined
  if (appDir !== undefined && appDir.length > 1) {
    for (const name of SEARCH_PATHS) {
      const value = env[name]
      if (value === undefined) continue
      const kept = value.split(delimiter).filter((entry) => entry !== '' && entry !== appDir && !entry.startsWith(`${appDir}/`))
      if (kept.length > 0) env[name] = kept.join(delimiter)
      else delete env[name]
    }
    for (const name of APPIMAGE_NAMES) delete env[name]
  }
  // Windows spells it `Path`; whichever spelling is there is the one extended.
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  const current = env[key]
  env[key] = current ? `${current}${delimiter}${nodeDir}` : nodeDir
  return env
}
