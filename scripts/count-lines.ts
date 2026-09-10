/**
 * The numbers docs/ARCHITECTURE.md §14 cites, generated rather than typed, with a
 * statement of what each one counts — three hand-typed counts had drifted
 * three different ways by S8.5. Run: `node scripts/count-lines.ts`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SRC = resolve(import.meta.dirname, '..', 'src')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const lines = (file: string): number => readFileSync(file, 'utf8').split('\n').length
const files = walk(SRC).map((file) => file.replace(/\\/g, '/'))
const isTest = (file: string): boolean => /\.(e2e\.)?test\.ts$/.test(file)
const isSupport = (file: string): boolean => file.includes('/test-support/')
const isClient = (file: string): boolean => file.includes('/app/web/') && !file.endsWith('.ts')

const impl = files.filter((file) => file.endsWith('.ts') && !isTest(file) && !isSupport(file))
const client = files.filter(isClient)
const tests = files.filter((file) => isTest(file) || (isSupport(file) && file.endsWith('.ts')))
const sum = (list: string[]): number => list.reduce((total, file) => total + lines(file), 0)

process.stdout.write(
  [
    `implementation: ${sum(impl).toLocaleString('en-US')} lines of TypeScript in ${impl.length} files under src/ (excluding tests and test-support)`,
    `browser client: ${sum(client).toLocaleString('en-US')} lines of plain JS/HTML/CSS in ${client.length} files under src/app/web/`,
    `tests and harness: ${sum(tests).toLocaleString('en-US')} lines in ${tests.length} files (*.test.ts, *.e2e.test.ts, test-support)`,
    `e2e arcs: ${files.filter((file) => file.endsWith('.e2e.test.ts')).length}`,
    '',
  ].join('\n'),
)
