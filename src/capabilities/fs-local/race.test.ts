/**
 * The fence against a CONCURRENT process. A check on a name and the open of
 * that name are two moments, and a process inside the workspace — on Linux, a
 * confined job may make links there — can swap a directory for a link to
 * outside between them: the S20.5 audit landed 24 of 25 accepted writes
 * outside that way. `writeText` now verifies the open handle itself
 * (`/proc/self/fd` on Linux, the one sound answer Node can get), so no byte
 * lands outside. An EMPTY file or directory may (ARCHITECTURE §13).
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { FS } from '../../core/fs/index.ts'
import { sandboxPlugin } from '../../core/sandbox/index.ts'
import { fsLocalPlugin } from './index.ts'

const silent: Logger = { warn: () => {}, error: () => {} }
let base: string | undefined
let root: Context | undefined

afterEach(async () => {
  await root?.dispose()
  root = undefined
  if (base) rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  base = undefined
})

const SWAPPER = `
const { mkdirSync, rmSync, symlinkSync } = require('node:fs')
const [d, out] = process.argv.slice(2)
for (;;) {
  try { rmSync(d, { recursive: true, force: true }) } catch {}
  try { symlinkSync(out, d, 'dir') } catch {}
  try { rmSync(d, { recursive: true, force: true }) } catch {}
  try { mkdirSync(d) } catch {}
}
`

describe.skipIf(process.platform !== 'linux')('fs-local against a process racing it', () => {
  it('lands no byte outside the workspace while a directory flips to a link and back', { timeout: 60_000 }, async () => {
    base = mkdtempSync(join(tmpdir(), 'minidsh-race-'))
    const ws = join(base, 'ws')
    const out = join(base, 'outside')
    mkdirSync(ws)
    mkdirSync(out)
    writeFileSync(join(base, 'swapper.cjs'), SWAPPER)
    root = createRoot({ logger: silent })
    root.plugin(sandboxPlugin, { mode: 'workspace-write', workspaceRoot: ws })
    root.plugin(fsLocalPlugin)
    await root.settle()
    const fs = root.get(FS)

    const swapper = spawn(process.execPath, [join(base, 'swapper.cjs'), join(ws, 'd'), out], { stdio: 'ignore' })
    let accepted = 0
    try {
      for (let i = 0; i < 2_000; i++) {
        try {
          await fs.writeText(fs.resolve(`d/f${i}.txt`, ws), 'x', { kind: 'unconditional' }, {})
          accepted++
        } catch {
          // A refusal or an error: either way nothing was written outside, which is what is checked.
        }
      }
    } finally {
      swapper.kill('SIGKILL')
      await new Promise((resolve) => swapper.once('exit', resolve))
    }
    const landed = readdirSync(out).filter((name) => statSync(join(out, name)).size > 0)
    expect(landed, `${landed.length} files with content landed outside after ${accepted} accepted writes`).toEqual([])
  })
})
