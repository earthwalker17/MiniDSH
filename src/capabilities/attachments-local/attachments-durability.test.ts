/**
 * The store's one rule, observed: `saveImage` returns only after the object is
 * durable. A real directory cannot show that, because a file reads back the
 * same whether or not it was synced, so `node:fs` is wrapped to record the
 * ORDER of the calls that make it true: the staging file synced, then renamed
 * into place, then (POSIX) the directory entry synced.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as Fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const control = vi.hoisted(() => ({
  /** Each sync and rename, named by what it was asked to act on, in the order asked. */
  log: [] as string[],
  /** Path of every open descriptor, so a sync can be named by its file. */
  open: new Map<number, string>(),
}))

const real = await vi.importActual<typeof Fs>('node:fs')

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>()
  return {
    ...actual,
    openSync: (path: Fs.PathLike, flags?: Fs.OpenMode, mode?: Fs.Mode) => {
      const fd = actual.openSync(path, flags ?? 'r', mode)
      control.open.set(fd, String(path))
      return fd
    },
    fsyncSync: (fd: number) => {
      const path = control.open.get(fd) ?? `fd ${fd}`
      control.log.push(`fsync ${actual.fstatSync(fd).isDirectory() ? 'directory' : 'file'} ${path}`)
      actual.fsyncSync(fd)
    },
    renameSync: (from: Fs.PathLike, to: Fs.PathLike) => {
      control.log.push(`rename ${String(from)} -> ${String(to)}`)
      actual.renameSync(from, to)
    },
  }
})

const { createHash } = await import('node:crypto')
const { createRoot } = await import('../../kernel/index.ts')
const { ATTACHMENTS } = await import('../../core/attachments/index.ts')
const { quadPng } = await import('../../test-support/images.ts')
const { attachmentsLocalPlugin } = await import('./index.ts')

type Root = Awaited<ReturnType<typeof createRoot>>
let dir: string | undefined
let root: Root | undefined

beforeEach(() => {
  control.log = []
  control.open = new Map()
})

afterEach(async () => {
  await root?.dispose()
  root = undefined
  if (dir) real.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dir = undefined
})

describe('attachments-local: durable before the reference exists', () => {
  it('syncs the staging file, renames it into place, then syncs the directory entry (POSIX)', async () => {
    dir = real.mkdtempSync(join(tmpdir(), 'minidsh-attach-durable-'))
    root = createRoot({ logger: { warn: () => {}, error: () => {} } })
    root.plugin(attachmentsLocalPlugin, { root: dir })
    await root.settle()
    const attachments = root.get(ATTACHMENTS)
    const png = quadPng(48)
    const sha256 = createHash('sha256').update(png).digest('hex')
    const bucket = join(dir, 'v1', 'objects', sha256.slice(0, 2))
    const target = join(bucket, sha256)

    const ref = await attachments.saveImage({ data: png })
    expect(ref.id).toBe(`sha256:${sha256}`)

    const renames = control.log.filter((entry) => entry.startsWith('rename '))
    expect(renames, control.log.join('\n')).toHaveLength(1)
    const staged = renames[0]!.slice('rename '.length, renames[0]!.indexOf(' -> '))
    expect(staged.startsWith(join(dir, 'v1', 'tmp', `${sha256}.`)) && staged.endsWith('.part'), staged).toBe(true)
    // A rename that lands before the content does leaves a valid-looking object
    // full of nothing, and a synced file whose directory entry never reached
    // storage is not there after a power cut. Windows cannot sync a directory:
    // there the name rests on NTFS's own metadata journal.
    expect(control.log).toEqual([
      `fsync file ${staged}`,
      `rename ${staged} -> ${target}`,
      ...(process.platform === 'win32' ? [] : [`fsync directory ${bucket}`]),
    ])
    expect(real.readFileSync(target).equals(png)).toBe(true)

    // The same bytes again: the object already there IS these bytes, so nothing is written or synced.
    control.log = []
    expect((await attachments.saveImage({ data: png })).id).toBe(ref.id)
    expect(control.log).toEqual([])
  })
})
