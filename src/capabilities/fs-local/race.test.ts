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
    // Every write ends one of four ways, and each is counted: a verdict about
    // "nothing landed outside" is worth only as much as the race it survived.
    //   accepted: the file was written, inside;
    //   caught:   the handle turned out to be outside (the check under test);
    //   fenced:   the name already led outside when it was resolved;
    //   other:    the directory was mid-swap, said with a code: the
    //             provider's own (FS_IO, FS_NOT_FOUND) or, where the path was
    //             being resolved as it vanished, the raw errno of that step.
    // Anything with no code at all is not the swap, and fails the case.
    const count = { accepted: 0, caught: 0, fenced: 0, other: 0 }
    const unexpected: string[] = []
    let swapperAlive = false
    const deadline = Date.now() + 40_000
    let writes = 0
    try {
      // Until the check has been seen to fire several times, not for a fixed
      // number of writes: a slow host may need more of them to hit the window.
      for (; writes < 2_000 || (count.caught < 5 && writes < 40_000 && Date.now() < deadline); writes++) {
        try {
          await fs.writeText(fs.resolve(`d/f${writes}.txt`, ws), 'x', { kind: 'unconditional' }, {})
          count.accepted++
        } catch (error) {
          const { code, message } = error as { code?: string; message?: string }
          if (code === 'FS_SANDBOX_DENIED' && message?.includes('changed while it was being written')) count.caught++
          else if (code === 'FS_SANDBOX_DENIED') count.fenced++
          else if (typeof code === 'string' && /^(FS_[A-Z_]+|E[A-Z]+)$/.test(code)) count.other++
          else unexpected.push(String(message ?? error))
        }
      }
      swapperAlive = swapper.exitCode === null && swapper.signalCode === null
    } finally {
      swapper.kill('SIGKILL')
      await new Promise((resolve) => swapper.once('exit', resolve))
    }
    const outside = readdirSync(out)
    const landed = outside.filter((name) => statSync(join(out, name)).size > 0)
    const told = `${writes} writes: ${count.accepted} accepted, ${count.caught} caught by the open-handle check, ${count.fenced} refused at the fence, ${count.other} failed mid-swap; ${outside.length} entries outside, ${landed.length} with content`
    expect(landed, told).toEqual([])
    // The controls. Without them every write could have failed, or the swapper
    // done nothing, and the line above would still hold.
    expect(unexpected, `writes failed some other way: ${told}`).toEqual([])
    expect(swapperAlive, `the swapper had stopped before the writes ended: ${told}`).toBe(true)
    expect(count.accepted, `no write was ever accepted: ${told}`).toBeGreaterThan(0)
    expect(count.caught, `the race was never exercised (no handle was found outside): ${told}`).toBeGreaterThan(0)
  })
})
