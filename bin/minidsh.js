#!/usr/bin/env node
// Entry for the `minidsh` bin. The runtime is TypeScript executed natively by
// Node >= 24 (type stripping); there is no build step.
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning') return
  process.stderr.write(`${warning.name}: ${warning.message}\n`)
})
const { main } = await import('../src/app/cli.ts')
process.exitCode = await main(process.argv.slice(2))
