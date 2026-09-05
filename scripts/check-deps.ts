/**
 * Source-shape gates. Three rules, one script:
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
 * 3. Core is acyclic at FILE level. Core packages depend on each other freely
 *    at package level (agent ↔ sandbox, session ↔ llm, …); what keeps that
 *    sound is that each package's vocabulary (`events.ts`, `types.ts`) sits
 *    below its service, so no FILE's value imports ever close a loop. That was
 *    a convention until S8.5; this rule pins it. Type-only imports are erased
 *    and do not count.
 *
 * Test files are exempt (they mount real compositions across layers).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { collectImports, findCycle } from './deps-graph.ts'

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

const posix = (path: string): string => path.replace(/\\/g, '/')

function layerOf(relPath: string): Layer {
  const top = posix(relPath).split('/')[0]
  if (top === 'kernel' || top === 'core' || top === 'capabilities' || top === 'app' || top === 'test-support') return top
  return 'other'
}

function capabilityOf(relPath: string): string | undefined {
  const parts = posix(relPath).split('/')
  return parts[0] === 'capabilities' ? parts[1] : undefined
}

function inLoop(relPath: string): boolean {
  return posix(relPath).startsWith('core/loop/')
}

/** Any typed cast of a payload — object literal or named type; `as unknown` is the honest read of a possibly-forged one. */
const PAYLOAD_CAST = /\.data as (?!unknown\b)/

function main(): void {
  const violations: string[] = []
  /** File-level value-import graph over `src/core`, for the acyclicity rule. */
  const coreGraph = new Map<string, Set<string>>()
  for (const file of walk(SRC)) {
    const relFile = posix(relative(SRC, file))
    const importer = layerOf(relFile)
    const source = readFileSync(file, 'utf8')
    const fail = (why: string): void => void violations.push(`${relFile}: ${why}`)
    if (importer === 'core') coreGraph.set(relFile, new Set())

    const seen = new Set<string>()
    for (const ref of collectImports(source)) {
      const targetAbs = resolve(dirname(file), ref.spec)
      const targetRel = posix(relative(SRC, targetAbs))
      if (targetRel.startsWith('..')) continue // outside src
      const target = layerOf(targetRel)
      if (importer === 'core' && target === 'core' && !ref.typeOnly && targetRel !== relFile) coreGraph.get(relFile)!.add(targetRel)
      if (seen.has(ref.spec)) continue
      seen.add(ref.spec)
      const why = (message: string): void => fail(`-> ${ref.spec}: ${message}`)

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
      fail('reads an event payload through `event.data as <type>`; narrow with matches(event, KIND) so a renamed field is a type error')
    }
  }

  const cycle = findCycle(coreGraph)
  if (cycle) violations.push(`core is not acyclic at file level: ${cycle.join(' -> ')} (move the shared vocabulary below the service, into an events.ts/types.ts)`)

  if (violations.length > 0) {
    process.stderr.write(`source-shape violations:\n${violations.map((v) => `  ${v}`).join('\n')}\n`)
    process.exit(1)
  }
  process.stdout.write(`check-deps: dependency direction, payload discipline and core acyclicity OK (${coreGraph.size} core files)\n`)
}

main()
