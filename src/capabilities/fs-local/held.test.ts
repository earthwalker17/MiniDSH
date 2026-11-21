/**
 * The open-handle check, made deterministic: `writeText` opens the file, and
 * only then is it decided whether what was opened is what the fence approved
 * (`verifyHeld`). The race this closes needs a second process timed into that
 * gap (`race.test.ts`, Linux only), and a race proves nothing on the run it
 * misses. Here the gap is held open instead: the one syscall in question,
 * `open`, is wrapped so the world changes after the handle exists and before
 * it is judged. Everything else is the real provider on the real disk.
 *
 * That also reaches the branch `race.test.ts` never can. Linux judges the
 * handle through `/proc/self/fd` and returns; every Windows and macOS write is
 * judged by NAME (canonicalize, compare the handle's inode with the one the
 * name reaches), and that comparison had no test on any platform.
 */
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { FS, type Fs } from '../../core/fs/index.ts'
import { canonicalPath, sandboxPlugin } from '../../core/sandbox/index.ts'
import { fsLocalPlugin } from './index.ts'

/** What the test does to the world between a write's open and its check; `undefined` leaves `open` as it is. */
const gap = vi.hoisted(() => ({ afterOpen: undefined as ((path: string) => void) | undefined }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const open: typeof real.open = async (...args) => {
    const handle = await real.open(...args)
    gap.afterOpen?.(String(args[0]))
    return handle
  }
  return { ...real, open }
})

const silent: Logger = { warn: () => {}, error: () => {} }
let base: string | undefined
let root: Context | undefined

afterEach(async () => {
  gap.afterOpen = undefined
  await root?.dispose()
  root = undefined
  if (base) rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  base = undefined
})

/** A workspace with `d/f.txt` in it and a directory outside it, on one volume. */
async function world(): Promise<{ fs: Fs; ws: string; outside: string; file: string }> {
  base = canonicalPath(mkdtempSync(join(tmpdir(), 'minidsh-held-')))
  const ws = join(base, 'ws')
  const outside = join(base, 'outside')
  mkdirSync(join(ws, 'd'), { recursive: true })
  mkdirSync(outside)
  const file = join(ws, 'd', 'f.txt')
  writeFileSync(file, 'original')
  root = createRoot({ logger: silent })
  root.plugin(sandboxPlugin, { mode: 'workspace-write', workspaceRoot: ws })
  root.plugin(fsLocalPlugin)
  await root.settle()
  return { fs: root.get(FS), ws, outside, file }
}

/** Arms the gap for the write's own open of `path`, once, and reports whether it was reached. */
function onceOpened(path: string, change: () => void): { reached: () => boolean } {
  let reached = false
  gap.afterOpen = (opened) => {
    if (reached || opened !== path) return
    reached = true
    change()
  }
  return { reached: () => reached }
}

describe('fs-local judges the file it opened, not the name it opened it by', () => {
  it('refuses when the opened file has been moved outside and another now has its name, and writes to neither', async () => {
    const { fs, ws, outside, file } = await world()
    const target = fs.resolve('d/f.txt', ws)
    const moved = join(outside, 'moved.txt')
    // The handle now holds a file OUTSIDE the workspace, while the name the
    // fence approved names a different file inside it: a check of the name
    // alone passes, and the write would land outside.
    const swap = onceOpened(target.path, () => {
      renameSync(file, moved)
      writeFileSync(file, 'decoy')
    })
    await expect(fs.writeText(target, 'WRITTEN', { kind: 'unconditional' }, {})).rejects.toMatchObject({
      code: 'FS_SANDBOX_DENIED',
      message: expect.stringContaining('changed while it was being written'),
    })
    // The positive control: the swap happened in the gap, not before or after it.
    expect(swap.reached(), 'the write never opened the file, so nothing was put to the test').toBe(true)
    expect(readFileSync(moved, 'utf8'), 'content reached the file that is now outside the workspace').toBe('original')
    expect(readFileSync(file, 'utf8')).toBe('decoy')
  })

  it('refuses when the opened file no longer has a name at all', async () => {
    const { fs, ws, file } = await world()
    const target = fs.resolve('d/f.txt', ws)
    const swap = onceOpened(target.path, () => rmSync(file))
    await expect(fs.writeText(target, 'WRITTEN', { kind: 'unconditional' }, {})).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(swap.reached()).toBe(true)
  })

  // The race `race.test.ts` runs against a second process, here on cue: the
  // directory the file was opened in becomes a link to outside. Windows will
  // not rename a directory that holds an open file, so it cannot be staged there.
  it.skipIf(process.platform === 'win32')('refuses when the directory it was opened in has become a link to outside', async () => {
    const { fs, ws, outside } = await world()
    const target = fs.resolve('d/f.txt', ws)
    const swap = onceOpened(target.path, () => {
      renameSync(join(ws, 'd'), join(outside, 'd'))
      symlinkSync(join(outside, 'd'), join(ws, 'd'), 'dir')
    })
    await expect(fs.writeText(target, 'WRITTEN', { kind: 'unconditional' }, {})).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    expect(swap.reached()).toBe(true)
    expect(readFileSync(join(outside, 'd', 'f.txt'), 'utf8'), 'content reached a file outside the workspace').toBe('original')
  })

  // And the gap, left alone, changes nothing: the wrapper is not what refuses.
  it('writes the file when nothing moved', async () => {
    const { fs, ws, file } = await world()
    const target = fs.resolve('d/f.txt', ws)
    const swap = onceOpened(target.path, () => {})
    await fs.writeText(target, 'WRITTEN', { kind: 'unconditional' }, {})
    expect(swap.reached()).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('WRITTEN')
  })
})
