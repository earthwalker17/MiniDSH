/**
 * Dependency-direction gate. Enforces the layer topology from ARCHITECTURE.md:
 * kernel imports nothing internal; core imports kernel + core (but nothing but
 * app/test-support imports core/loop); capabilities import kernel + core (never
 * each other or app); app imports anything; test-support imports anything.
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

const IMPORT = /(?:import|export)[^'"]*?from\s*['"](\.[^'"]+)['"]/g

function main(): void {
  const violations: string[] = []
  for (const file of walk(SRC)) {
    const relFile = relative(SRC, file)
    const importer = layerOf(relFile)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(IMPORT)) {
      const spec = match[1]!
      const targetAbs = resolve(dirname(file), spec)
      const targetRel = relative(SRC, targetAbs)
      if (targetRel.startsWith('..')) continue // outside src
      const target = layerOf(targetRel)

      const fail = (why: string): void => void violations.push(`${relFile} -> ${spec}: ${why}`)

      if (importer === 'kernel' && target !== 'kernel') fail('kernel may import nothing internal')
      if (importer === 'core') {
        if (target !== 'kernel' && target !== 'core') fail('core may import only kernel and core')
        if (inLoop(targetRel) && !inLoop(relFile)) fail('core/loop is swappable; only app/test-support may import it')
      }
      if (importer === 'capabilities') {
        if (target === 'app') fail('capabilities must not import app')
        else if (target === 'capabilities' && capabilityOf(relFile) !== capabilityOf(targetRel)) fail('capabilities must not import other capabilities')
        else if (target === 'other') fail('unexpected import target')
      }
      if ((importer === 'app' || importer === 'test-support') && inLoop(targetRel)) {
        // allowed — these layers own the driver choice
      }
    }
  }

  if (violations.length > 0) {
    process.stderr.write(`dependency-direction violations:\n${violations.map((v) => `  ${v}`).join('\n')}\n`)
    process.exit(1)
  }
  process.stdout.write('check-deps: dependency direction OK\n')
}

main()
