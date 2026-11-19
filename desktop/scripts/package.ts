/**
 * Builds the MiniDSH desktop app for THIS host's platform:
 *
 *   node desktop/scripts/package.ts            # the installer (Windows NSIS, Linux AppImage, macOS zip)
 *   node desktop/scripts/package.ts --dir      # the unpacked app only (fast; what the E2E drives)
 *
 * Run `pnpm install` at the root and `pnpm --dir desktop install` first.
 *
 * What goes in, and why each is shaped so:
 *   - The RUNTIME is the root's own `pnpm pack` tarball, installed by npm with
 *     `--omit=dev` into a staging prefix: exactly the shape `npm install -g
 *     minidsh` gives a person, with real files and not pnpm's links (a link
 *     would work on the build host and nowhere else). No `src/`, so
 *     `bin/minidsh.js` runs the emitted `dist/`.
 *   - The NODE that runs it is the official build, SHA-256-pinned below, not
 *     Electron's own Node: the RunAsNode fuse can then stay off, the agent's
 *     shell gets a real `node` for the bundled skills, and the runtime's `fs`
 *     is never Electron's asar-patched one reading a workspace's `.asar` files.
 *   - The APP is the emitted `desktop/src` (main + pure modules), the
 *     sandboxed preload and the shell pages, in an asar.
 *
 * The desktop's version is the root's, and its Electron is the root's pinned
 * devDependency: one release identity, asserted here.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DESKTOP = resolve(import.meta.dirname, '..')
const ROOT = resolve(DESKTOP, '..')
const BUILD = join(DESKTOP, 'build')
const APP_ID = 'io.github.earthwalker17.minidsh'

/** The newest Node 24 security release at S22.2 (2026-11-10); the same Node Electron 45.3.4 embeds. */
const NODE_VERSION = '24.22.3'
const NODE_SHA256: Readonly<Record<string, string>> = {
  'win32-x64': 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f',
  'linux-x64': '4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb',
  'darwin-arm64': 'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd',
  'darwin-x64': '977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7',
}

function fail(message: string): never {
  process.stderr.write(`desktop package: ${message}\n`)
  process.exit(1)
}

function run(command: string, args: readonly string[], cwd: string): void {
  // pnpm and npm are `.cmd` shims on Windows, which Node runs only through a
  // shell; every argument here is ours, none is input.
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited ${result.status ?? result.signal}`)
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function walk(dir: string, visit: (path: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    visit(full)
    const stat = lstatSync(full)
    if (stat.isDirectory() && !stat.isSymbolicLink()) walk(full, visit)
  }
}

// ---------------------------------------------------------------- identity

const rootPackage = readJson(join(ROOT, 'package.json'))
const desktopPackage = readJson(join(DESKTOP, 'package.json'))
const version = String(rootPackage.version)
if (desktopPackage.version !== version) fail(`desktop/package.json is ${String(desktopPackage.version)} but the runtime is ${version}: they release as one`)
const electronVersion = String((rootPackage.devDependencies as Record<string, string>).electron)
if (!/^\d+\.\d+\.\d+$/.test(electronVersion)) fail(`the root's electron devDependency must be an exact version, not ${electronVersion}`)

const dirOnly = process.argv.includes('--dir')
const platformKey = `${process.platform}-${process.arch}`
const nodeSha = NODE_SHA256[platformKey] ?? fail(`no pinned Node build for ${platformKey}`)

// ---------------------------------------------------------------- the runtime

function stageRuntime(): void {
  const pack = join(BUILD, 'pack')
  rmSync(pack, { recursive: true, force: true })
  mkdirSync(pack, { recursive: true })
  run('pnpm', ['pack', '--pack-destination', pack], ROOT)
  const tarball = readdirSync(pack).find((name) => name.endsWith('.tgz')) ?? fail('pnpm pack wrote no tarball')
  const stage = join(BUILD, 'runtime')
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  writeFileSync(join(stage, 'package.json'), '{ "private": true }\n')
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', '--ignore-scripts', join(pack, tarball)], stage)
  const minidsh = join(stage, 'node_modules', 'minidsh')
  for (const required of ['bin/minidsh.js', 'dist/app/cli.js', 'package.json', 'skills']) {
    if (!existsSync(join(minidsh, required))) fail(`the staged runtime lacks ${required}`)
  }
  if (existsSync(join(minidsh, 'src'))) fail('the staged runtime holds src/: bin/minidsh.js would run TypeScript under node_modules')
  if (readJson(join(minidsh, 'package.json')).version !== version) fail('the staged runtime is not this checkout\'s version')
  // Every browser asset the page loads is in the emit (the same list the
  // installed-package smoke checks).
  const webAssets = readFileSync(join(ROOT, 'scripts', 'build.ts'), 'utf8').match(/export const WEB_ASSETS = \[([\s\S]*?)\]/)?.[1]
  const assets = [...(webAssets ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]!)
  if (assets.length < 10) fail('could not read WEB_ASSETS from scripts/build.ts')
  for (const asset of assets) if (!existsSync(join(minidsh, 'dist', 'app', 'web', asset))) fail(`the staged runtime lacks the browser asset ${asset}`)
  // A link (pnpm's, a junction) works on the build host only.
  walk(join(stage, 'node_modules'), (path) => {
    if (lstatSync(path).isSymbolicLink()) fail(`the staged runtime holds a link: ${path}`)
  })
  process.stdout.write(`desktop package: runtime ${version} staged (${assets.length} browser assets)\n`)
}

// ---------------------------------------------------------------- node

function stageNode(): void {
  const cache = join(BUILD, 'cache')
  mkdirSync(cache, { recursive: true })
  const base = `node-v${NODE_VERSION}-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`
  const archive = `${base}.${process.platform === 'win32' ? 'zip' : process.platform === 'linux' ? 'tar.xz' : 'tar.gz'}`
  const file = join(cache, archive)
  if (!existsSync(file)) run('curl', ['-fsSL', '--retry', '3', '-o', file, `https://nodejs.org/dist/v${NODE_VERSION}/${archive}`], cache)
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (digest !== nodeSha) {
    rmSync(file, { force: true })
    fail(`${archive} has SHA-256 ${digest}, not the pinned ${nodeSha}`)
  }
  const unpacked = join(cache, base)
  rmSync(unpacked, { recursive: true, force: true })
  // bsdtar reads zip as well as tar. On Windows it is System32's by full path:
  // a Git for Windows tar earlier on PATH is GNU tar, which reads `C:` as a
  // remote host and zip not at all.
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  run(tar, ['-xf', archive], cache)
  const target = join(BUILD, 'node')
  rmSync(target, { recursive: true, force: true })
  if (process.platform === 'win32') {
    mkdirSync(target, { recursive: true })
    cpSync(join(unpacked, 'node.exe'), join(target, 'node.exe'))
  } else {
    mkdirSync(join(target, 'bin'), { recursive: true })
    cpSync(join(unpacked, 'bin', 'node'), join(target, 'bin', 'node'))
  }
  cpSync(join(unpacked, 'LICENSE'), join(target, 'LICENSE'))
  process.stdout.write(`desktop package: node ${NODE_VERSION} (${platformKey}) verified\n`)
}

// ---------------------------------------------------------------- the app

function stageApp(): void {
  const app = join(BUILD, 'app')
  rmSync(app, { recursive: true, force: true })
  const tsc = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(DESKTOP, 'tsconfig.build.json')], { cwd: ROOT, stdio: 'inherit' })
  if (tsc.status !== 0) fail(`tsc exited ${tsc.status ?? tsc.signal}`)
  cpSync(join(DESKTOP, 'src', 'preload.cjs'), join(app, 'lib', 'preload.cjs'))
  cpSync(join(DESKTOP, 'shell'), join(app, 'shell'), { recursive: true })
  const emitted = readdirSync(join(app, 'lib'))
  if (!emitted.includes('main.js')) fail('the emit has no lib/main.js')
  for (const name of emitted) {
    if (name.endsWith('.js') && /from\s*['"]\.[^'"]*\.ts['"]/.test(readFileSync(join(app, 'lib', name), 'utf8'))) fail(`a .ts import survived the emit in lib/${name}`)
  }
  writeFileSync(
    join(app, 'package.json'),
    `${JSON.stringify(
      {
        name: 'minidsh-desktop',
        productName: 'MiniDSH',
        version,
        description: String(desktopPackage.description),
        author: String(desktopPackage.author),
        license: 'MIT',
        homepage: String(desktopPackage.homepage),
        type: 'module',
        main: 'lib/main.js',
      },
      null,
      2,
    )}\n`,
  )
}

// ---------------------------------------------------------------- electron-builder

/** The slice of electron-builder's API this script calls: loaded from desktop/node_modules, so the root's typecheck needs none of its types. */
interface Builder {
  readonly Platform: Readonly<Record<'WINDOWS' | 'MAC' | 'LINUX', { createTarget(): unknown }>>
  build(options: { targets: unknown; config: Record<string, unknown>; publish: 'never' }): Promise<string[]>
}

async function bundle(): Promise<void> {
  const builder = (await import(pathToFileURL(join(DESKTOP, 'node_modules', 'electron-builder', 'out', 'index.js')).href)) as Builder
  // Signing switches on with the standard electron-builder environment and
  // nothing else: CSC_LINK / WIN_CSC_LINK (+ password) on Windows, a Developer
  // ID on macOS. Without one, Windows builds are unsigned and macOS builds are
  // ad-hoc signed ('-'), which keeps the fuse-modified binary runnable.
  const signed = Boolean(process.env.CSC_LINK || process.env.WIN_CSC_LINK)
  const config: Record<string, unknown> = {
    appId: APP_ID,
    productName: 'MiniDSH',
    copyright: 'Copyright © 2026 MiniDSH contributors (MIT)',
    electronVersion,
    directories: { app: join(BUILD, 'app'), output: join(BUILD, 'dist'), buildResources: join(DESKTOP, 'resources') },
    asar: true,
    // The main process imports electron and node:* alone. electron-builder
    // would otherwise walk up to the repository root and pack ITS production
    // dependencies (zod) into the asar; the runtime has its own copy below.
    files: ['**/*', '!node_modules{,/**/*}'],
    npmRebuild: false,
    extraResources: [
      { from: join(BUILD, 'runtime', 'node_modules'), to: 'runtime/node_modules' },
      { from: join(BUILD, 'node'), to: 'node' },
      { from: join(DESKTOP, 'resources', 'icon.png'), to: 'icon.png' },
    ],
    // The main process runs no user code; nothing may turn it into a Node
    // interpreter or attach a debugger to it, and `file:` pages get no extra
    // reach (the shell is served from its own scheme).
    electronFuses: {
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      grantFileProtocolExtraPrivileges: false,
    },
    win: {
      target: [{ target: dirOnly ? 'dir' : 'nsis', arch: ['x64'] }],
      icon: 'icon.png',
      artifactName: 'MiniDSH-Setup-${version}.${ext}',
    },
    nsis: {
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      deleteAppDataOnUninstall: false,
      include: join(DESKTOP, 'installer.nsh'),
      shortcutName: 'MiniDSH',
      uninstallDisplayName: 'MiniDSH ${version}',
      // No updater reads a blockmap (updates are a release page, S22.2).
      differentialPackage: false,
    },
    linux: {
      target: [{ target: dirOnly ? 'dir' : 'AppImage', arch: ['x64'] }],
      icon: 'icon.png',
      category: 'Development',
      synopsis: 'A small, local-first coding-agent harness',
      artifactName: 'MiniDSH-${version}-${arch}.${ext}',
      executableName: 'minidsh-desktop',
    },
    mac: {
      target: [{ target: dirOnly ? 'dir' : 'zip', arch: [process.arch === 'arm64' ? 'arm64' : 'x64'] }],
      icon: 'icon.png',
      category: 'public.app-category.developer-tools',
      artifactName: 'MiniDSH-${version}-mac-${arch}.${ext}',
      ...(signed || process.env.CSC_NAME ? {} : { identity: '-' }),
    },
    publish: null,
  }
  const platform = process.platform === 'win32' ? builder.Platform.WINDOWS : process.platform === 'darwin' ? builder.Platform.MAC : builder.Platform.LINUX
  const artifacts = await builder.build({ targets: platform.createTarget(), config, publish: 'never' })
  for (const artifact of artifacts) {
    if (existsSync(artifact) && statSync(artifact).isFile()) process.stdout.write(`desktop package: ${artifact} (${(statSync(artifact).size / 1024 / 1024).toFixed(1)} MiB)\n`)
  }
}

if (!existsSync(join(DESKTOP, 'node_modules', 'electron-builder'))) fail('run `pnpm --dir desktop install` first')
stageRuntime()
stageNode()
stageApp()
await bundle()
