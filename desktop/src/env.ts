/**
 * The runtime's environment, built from main's. Pure, so tested on any host.
 *
 * Owns: what main passes on to the runtime (and, through the runtime's own
 * rule in core/process.ts, to an agent's shell). Must not own: secrets (the
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
