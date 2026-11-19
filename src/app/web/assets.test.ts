/**
 * The browser client's packaging guard: `WEB_ASSETS` (scripts/build.ts) must
 * equal EXACTLY what the page loads.
 *
 * A checkout serves `src/app/web/` itself, so a module the page imports and
 * the list forgets works in every test and every CI leg and 404s for installed
 * users only — a blank page (the build's own check compares the directory to
 * the list, which an asset nobody listed AND nobody committed slips past, and
 * which says nothing about a listed file the page no longer loads). So the set
 * is derived here the way a browser derives it: index.html's own references,
 * then the static ES import graph from every script it reaches (and from
 * `theme.js` where one exists), then each stylesheet's `@import`/`url()`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WEB_ASSETS } from '../../../scripts/build.ts'
import { collectImports } from '../../../scripts/deps-graph.ts'

const WEB = import.meta.dirname

/** A reference the page makes, as a flat asset name — or why it cannot be one. */
function assetName(reference: string, from: string): string | undefined {
  // Fragments (an inline SVG's `<use href="#…">`), inline data and other
  // origins are not files this host serves.
  if (/^(#|data:|blob:|[a-z][a-z0-9+.-]*:)/i.test(reference)) return undefined
  const name = reference.replace(/[?#].*$/, '').replace(/^\.?\//, '')
  // The host serves one flat directory (`app/web.ts`): a nested path would 404.
  if (name.length === 0 || name.includes('/')) throw new Error(`${from} references "${reference}", which is not a flat asset this host serves`)
  return name
}

/** What one file makes the browser fetch next. */
function referencesOf(name: string): string[] {
  const text = readFileSync(join(WEB, name), 'utf8')
  const found: (string | undefined)[] = []
  if (name.endsWith('.html')) {
    for (const match of text.matchAll(/\s(?:src|href)\s*=\s*["']([^"']+)["']/gi)) found.push(assetName(match[1]!, name))
  } else if (name.endsWith('.js')) {
    // The same extractor `check-deps` reads with: a JSDoc type import is a
    // comment, never a fetch, and is not counted.
    for (const ref of collectImports(text)) if (!ref.typeOnly) found.push(assetName(ref.spec, name))
  } else if (name.endsWith('.css')) {
    for (const match of text.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)/g)) found.push(assetName(match[1]!, name))
    for (const match of text.matchAll(/url\(\s*["']?([^"')]+?)["']?\s*\)/g)) found.push(assetName(match[1]!, name))
  }
  return found.filter((one): one is string => one !== undefined)
}

/** Every asset the page loads, each with the file that first reached it. */
function reachable(): Map<string, string> {
  const reached = new Map<string, string>([['index.html', 'the page itself']])
  const roots = ['index.html', 'app.js', ...(existsSync(join(WEB, 'theme.js')) ? ['theme.js'] : [])]
  for (const root of roots) if (!reached.has(root)) reached.set(root, 'a root of the client')
  const queue = [...reached.keys()]
  while (queue.length > 0) {
    const name = queue.shift()!
    if (!existsSync(join(WEB, name))) throw new Error(`${reached.get(name)} loads "${name}", which does not exist in src/app/web`)
    for (const next of referencesOf(name)) {
      if (reached.has(next)) continue
      reached.set(next, name)
      queue.push(next)
    }
  }
  return reached
}

describe('the browser client ships exactly what it loads', () => {
  it('WEB_ASSETS equals index.html references plus the static import graph — nothing missing, nothing extra', () => {
    const reached = reachable()
    const listed = new Set<string>(WEB_ASSETS)
    const missing = [...reached.keys()].filter((name) => !listed.has(name)).map((name) => `${name} (loaded by ${reached.get(name)})`)
    const extra = [...listed].filter((name) => !reached.has(name))
    expect(missing, `the page loads these, and WEB_ASSETS in scripts/build.ts does not ship them: ${missing.join(', ')}`).toEqual([])
    expect(extra, `WEB_ASSETS ships these, and nothing the page loads reaches them: ${extra.join(', ')}`).toEqual([])
  })

  it('ships every browser module the terminal imports, so an installed terminal can load it', () => {
    // Since S22.1 the full-screen terminal draws the browser's presentation
    // model: `dist/app/terminal/*.js` imports `../web/<name>.js`, which exists
    // in an install only because the build copies it as a browser asset.
    const terminal = join(WEB, '..', 'terminal')
    const listed = new Set<string>(WEB_ASSETS)
    const imported = new Set<string>()
    for (const file of readdirSync(terminal).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
      for (const ref of collectImports(readFileSync(join(terminal, file), 'utf8'))) {
        const match = /^\.\.\/web\/([\w.-]+\.js)$/.exec(ref.spec)
        if (match && !ref.typeOnly) imported.add(match[1]!)
      }
    }
    expect(imported.size, 'the terminal no longer imports a browser module: this guard is checking nothing').toBeGreaterThan(0)
    expect([...imported].filter((name) => !listed.has(name))).toEqual([])
  })

  it('reads a reference the way the browser does, and refuses one this host could not serve', () => {
    expect(assetName('/style.css', 'index.html')).toBe('style.css')
    expect(assetName('./rows.js', 'app.js')).toBe('rows.js')
    expect(assetName('#icon-run', 'index.html')).toBeUndefined()
    expect(assetName('data:image/png;base64,AAAA', 'style.css')).toBeUndefined()
    expect(() => assetName('../core/x.js', 'app.js')).toThrow(/not a flat asset/)
    expect(() => assetName('/fonts/a.woff2', 'style.css')).toThrow(/not a flat asset/)
  })
})
