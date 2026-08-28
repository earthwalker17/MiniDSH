/**
 * Source-shape gates. Two rules, one script:
 *
 * 1. Dependency direction, from ARCHITECTURE.md: kernel imports nothing
 *    internal; core imports kernel + core (but nothing but app/test-support
 *    imports core/loop); capabilities import kernel + core (never each other or
 *    app); app imports anything; test-support imports anything. Static,
 *    dynamic (`import('…')`), side-effect and inline-type imports all count.
 *
 * 2. Payload discipline: outside tests and test-support, an event payload is
 *    read through `matches(event, KIND)`, never `event.data as {…}`. A cast
 *    hides a renamed field from the type checker; the S5.5 audit found the
 *    terminal printing `~NaNk` for exactly that reason.
 *
 * Test files are exempt (they mount real compositions across layers).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

type Layer = 'kernel' | 'core' | 'capabilities' | 'app' | 'test-support' | 'other'

const SRC = resolve(import.meta.dirname, '..', 'src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full)
  }
  return out
}

function layerOf(relPath: string): Layer {
  const top = relPath.split(/[\\/]/)[0]
  if (top === 'kernel' || top === 'core' || top === 'capabilities' || top === 'app' || top === 'test-support') return top
  return 'other'
}

function capabilityOf(relPath: string): string | undefined {
  const parts = relPath.split(/[\\/]/)
  return parts[0] === 'capabilities' ? parts[1] : undefined
}

function inLoop(relPath: string): boolean {
  return relPath.replace(/\\/g, '/').startsWith('core/loop/')
}

/** `import … from './x'`, `export … from './x'`, `import './x'`, `import('./x')`, and `import('./x').T`. */
const IMPORTS = [/(?:import|export)[^'"]*?from\s*['"](\.[^'"]+)['"]/g, /import\s+['"](\.[^'"]+)['"]/g, /import\(\s*['"](\.[^'"]+)['"]\s*\)/g]

const PAYLOAD_CAST = /\.data as \{/

function main(): void {
  const violations: string[] = []
  for (const file of walk(SRC)) {
    const relFile = relative(SRC, file)
    const importer = layerOf(relFile)
    const source = readFileSync(file, 'utf8')
    const fail = (why: string): void => void violations.push(`${relFile}: ${why}`)

    const specs = new Set<string>()
    for (const pattern of IMPORTS) for (const match of source.matchAll(pattern)) specs.add(match[1]!)
    for (const spec of specs) {
      const targetAbs = resolve(dirname(file), spec)
      const targetRel = relative(SRC, targetAbs)
      if (targetRel.startsWith('..')) continue // outside src
      const target = layerOf(targetRel)
      const why = (message: string): void => fail(`-> ${spec}: ${message}`)

      if (importer === 'kernel' && target !== 'kernel') why('kernel may import nothing internal')
      if (importer === 'core') {
        if (target !== 'kernel' && target !== 'core') why('core may import only kernel and core')
        if (inLoop(targetRel) && !inLoop(relFile)) why('core/loop is swappable; only app/test-support may import it')
      }
      if (importer === 'capabilities') {
        if (target === 'app') why('capabilities must not import app')
        else if (target === 'capabilities' && capabilityOf(relFile) !== capabilityOf(targetRel)) why('capabilities must not import other capabilities')
        else if (inLoop(targetRel)) why('core/loop is swappable; only app/test-support may import it')
        else if (target === 'other') why('unexpected import target')
      }
    }

    if (importer !== 'test-support' && PAYLOAD_CAST.test(source)) {
      fail('reads an event payload through `event.data as {…}`; narrow with matches(event, KIND) so a renamed field is a type error')
    }
  }

  if (violations.length > 0) {
    process.stderr.write(`source-shape violations:\n${violations.map((v) => `  ${v}`).join('\n')}\n`)
    process.exit(1)
  }
  process.stdout.write('check-deps: dependency direction and payload discipline OK\n')
}

main()
