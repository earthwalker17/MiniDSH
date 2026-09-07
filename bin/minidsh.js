#!/usr/bin/env node
// The `minidsh` bin. A checkout runs the TypeScript source natively (Node >= 24
// strips types); an INSTALLED package runs the emitted `dist/`, because Node
// refuses to strip types under node_modules. Which one runs is decided by the
// package's SHAPE — `src/` is not in the tarball — never by which is newer, so
// a stale `dist/` left beside a checkout by `npm pack` is never what
// `pnpm minidsh` runs.
import { existsSync } from 'node:fs'

const major = Number(process.versions.node.split('.')[0])
if (major < 24) {
  process.stderr.write(`minidsh needs Node 24 or newer; this is ${process.version}\n`)
  process.exit(2)
}
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning') return
  process.stderr.write(`${warning.name}: ${warning.message}\n`)
})
const source = new URL('../src/app/cli.ts', import.meta.url)
const entry = existsSync(source) ? source : new URL('../dist/app/cli.js', import.meta.url)
const { main } = await import(entry.href)
process.exitCode = await main(process.argv.slice(2))
