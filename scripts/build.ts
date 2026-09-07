/**
 * The `dist/` emit: what an INSTALLED package runs.
 *
 * A checkout runs the TypeScript source natively (Node >= 24 strips types), and
 * every test does too. An installed package cannot: Node refuses to strip types
 * under `node_modules`, so `npx minidsh` over the source would fail at its first
 * import. This emits plain JavaScript with every relative `./x.ts` specifier
 * rewritten to `./x.js` (`rewriteRelativeImportExtensions`), copies the browser
 * client's hand-written assets beside `app/web.js` where `CLIENT_ROOT` expects
 * them, checks the emit's SHAPE against the source tree, and then loads the
 * emitted entry once in this process's Node with no type stripper in the path —
 * so a broken emit fails the pack, never the install.
 *
 * `prepack` runs it (`npm pack`, `npm publish`); `pnpm build` runs it by hand.
 * Nothing else does: dev and tests keep running the source, and `bin/minidsh.js`
 * picks `dist/` only where `src/` is absent, which is exactly the tarball.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')
const DIST = join(ROOT, 'dist')
const WEB = join('app', 'web')
/** The browser client ships verbatim: plain ES modules, no build step, no TypeScript. */
const WEB_ASSETS = ['index.html', 'style.css', 'app.js', 'wire.js'] as const

function fail(message: string): never {
  process.stderr.write(`build: ${message}\n`)
  process.exit(1)
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const isTest = (file: string): boolean => /\.test\.(ts|js)$/.test(file)
const isSupport = (file: string): boolean => file.includes(`${sep}test-support${sep}`)
const isWebAsset = (file: string): boolean => WEB_ASSETS.some((asset) => file.endsWith(join(WEB, asset)))

rmSync(DIST, { recursive: true, force: true })

// The compiler, resolved from node_modules rather than PATH: `prepack` runs
// under whatever package manager the publisher used, and `tsc` on PATH is not
// something npm promises.
const tsc = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(ROOT, 'tsconfig.build.json')], {
  cwd: ROOT,
  stdio: 'inherit',
})
if (tsc.status !== 0) fail(`tsc exited ${tsc.status ?? tsc.signal}`)

for (const asset of WEB_ASSETS) cpSync(join(SRC, WEB, asset), join(DIST, WEB, asset))

// What must not be in the emit: a test, the test harness, or a `.ts` specifier
// the rewrite missed — Node would fail to resolve that at the install, not here.
const emitted = walk(DIST)
const stray = emitted.filter((file) => isTest(file) || isSupport(file))
if (stray.length > 0) fail(`test code reached dist/: ${stray.join(', ')}`)
const unrewritten = emitted.filter((file) => file.endsWith('.js') && /(?:from|import\()\s*['"]\.[^'"]*\.ts['"]/.test(readFileSync(file, 'utf8')))
if (unrewritten.length > 0) fail(`a .ts import specifier survived the emit: ${unrewritten.join(', ')}`)

// Every implementation file has exactly one emitted twin: the count is what
// checks that the build's include/exclude describes the tree rather than a
// subset of it, since a module tsc never saw is a module the install lacks.
const sources = walk(SRC).filter((file) => file.endsWith('.ts') && !isTest(file) && !isSupport(file))
const modules = emitted.filter((file) => file.endsWith('.js') && !isWebAsset(file))
if (sources.length !== modules.length) fail(`${sources.length} implementation files under src/ but ${modules.length} modules in dist/`)

// The entry, loaded once in THIS Node with no type stripper in the path. It
// imports the whole default composition, so every rewritten specifier is
// resolved for real before anything is packed.
const entry = pathToFileURL(join(DIST, 'app', 'cli.js')).href
const smoke = spawnSync(
  process.execPath,
  ['--input-type=module', '-e', `const m = await import(${JSON.stringify(entry)}); if (typeof m.main !== 'function') throw new Error('dist/app/cli.js exports no main')`],
  { cwd: ROOT, stdio: 'inherit' },
)
if (smoke.status !== 0) fail('the emitted entry did not load')

process.stdout.write(`build: ${modules.length} modules + ${WEB_ASSETS.length} browser assets -> dist/\n`)
