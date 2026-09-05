/**
 * The retention sweep, asserted against the WORLD like the rest of this store:
 * the files that should be gone are gone, and — the load-bearing half — the
 * ones that should not be are still on disk.
 *
 * The sweep is started at load and awaited at DISPOSAL, so every case here
 * mounts, disposes, and only then looks at the filesystem. That ordering is the
 * contract, not a test convenience: it is what makes shutdown quiescent.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { SPILL } from '../../core/spill/index.ts'
import { spillLocalPlugin } from './index.ts'

const DAY_MS = 24 * 60 * 60 * 1000

const dirs: string[] = []
const warnings: string[] = []
const noisyLogger: Logger = { warn: (message) => void warnings.push(message), error: () => {} }
let root: Context | undefined

afterEach(async () => {
  await root?.dispose()
  root = undefined
  warnings.length = 0
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Writes a file and back-dates it, so age is a fact of the filesystem rather than of a clock the test controls. */
function aged(path: string, ageDays: number): string {
  writeFileSync(path, 'x', 'utf8')
  const when = (Date.now() - ageDays * DAY_MS) / 1000
  utimesSync(path, when, when)
  return path
}

async function mount(spillRoot: string, cleanupPeriodDays?: number): Promise<Context> {
  root = createRoot({ logger: noisyLogger })
  root.plugin(spillLocalPlugin, cleanupPeriodDays === undefined ? { root: spillRoot } : { root: spillRoot, cleanupPeriodDays })
  await root.settle()
  return root
}

/** Mount, let the sweep finish, and drop the root. Disposal is where the sweep is awaited. */
async function swept(spillRoot: string, cleanupPeriodDays?: number): Promise<void> {
  await mount(spillRoot, cleanupPeriodDays)
  await root!.dispose()
  root = undefined
}

describe('the retention sweep', () => {
  it('removes a file older than the cutoff and keeps a young one', async () => {
    const spillRoot = tempDir('minidsh-sweep-')
    const dir = join(spillRoot, 'session-1')
    mkdirSync(dir)
    const old = aged(join(dir, 'call-1-shell.txt'), 40)
    const young = aged(join(dir, 'call-3-shell.txt'), 1)

    await swept(spillRoot, 30)

    expect(existsSync(old)).toBe(false)
    expect(existsSync(young)).toBe(true)
    expect(warnings).toEqual([])
  })

  /**
   * The boundary itself, which no "very old versus brand new" case can reach:
   * two clock reads are always milliseconds apart, so the cutoff is pinned to
   * the file's own recorded mtime instead. Only `Date` is faked — faking timers
   * would hang `settle()` and the sweep's own awaits.
   */
  it('keeps a file whose mtime is exactly the cutoff, and removes it one millisecond later', async () => {
    for (const [offsetMs, survives] of [
      [0, true],
      [1, false],
    ] as const) {
      const spillRoot = tempDir('minidsh-sweep-')
      const dir = join(spillRoot, 'session-1')
      mkdirSync(dir)
      const file = join(dir, 'call-1-shell.txt')
      writeFileSync(file, 'x', 'utf8')
      // Whole seconds, so the recorded mtime is an exact integer millisecond on
      // every filesystem this runs on — the assertion below is what says so.
      const seconds = Math.floor((Date.now() - 40 * DAY_MS) / 1000)
      utimesSync(file, seconds, seconds)
      const mtimeMs = statSync(file).mtimeMs
      expect(mtimeMs).toBe(seconds * 1000)

      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(mtimeMs + 30 * DAY_MS + offsetMs)
        await swept(spillRoot, 30)
      } finally {
        vi.useRealTimers()
      }
      expect(existsSync(file)).toBe(survives)
    }
  })

  it('prunes a session directory it emptied, and never the root', async () => {
    const spillRoot = tempDir('minidsh-sweep-')
    const emptied = join(spillRoot, 'session-1')
    const kept = join(spillRoot, 'session-2')
    mkdirSync(emptied)
    mkdirSync(kept)
    aged(join(emptied, 'call-1-shell.txt'), 40)
    aged(join(kept, 'call-1-shell.txt'), 40)
    aged(join(kept, 'call-2-shell.txt'), 1)

    await swept(spillRoot, 30)

    expect(existsSync(emptied)).toBe(false)
    expect(readdirSync(kept)).toEqual(['call-2-shell.txt'])
    expect(existsSync(spillRoot)).toBe(true)
  })

  it('touches nothing this writer could not have written', async () => {
    const spillRoot = tempDir('minidsh-sweep-')
    const outside = tempDir('minidsh-sweep-outside-')
    const treasure = aged(join(outside, 'treasure.txt'), 40)

    // A directory whose name this store never generates.
    const foreignDir = join(spillRoot, '.hidden-backup')
    mkdirSync(foreignDir)
    const inForeignDir = aged(join(foreignDir, 'call-1-shell.txt'), 40)

    const dir = join(spillRoot, 'session-1')
    mkdirSync(dir)
    // Right age, wrong shape: not a `.txt`, and a leading dot.
    const notTxt = aged(join(dir, 'call-1-shell.log'), 40)
    const dotted = aged(join(dir, '.call-1-shell.txt'), 40)
    // A nested directory: the sweep unlinks files and never recurses.
    const nested = join(dir, 'nested-dir.txt')
    mkdirSync(nested)
    aged(join(nested, 'call-1-shell.txt'), 40)

    await swept(spillRoot, 30)

    expect(existsSync(inForeignDir)).toBe(true)
    expect(existsSync(notTxt)).toBe(true)
    expect(existsSync(dotted)).toBe(true)
    expect(readdirSync(nested)).toEqual(['call-1-shell.txt'])
    expect(existsSync(treasure)).toBe(true)
  })

  it('skips a symlink instead of following it', async () => {
    const spillRoot = tempDir('minidsh-sweep-')
    const outside = tempDir('minidsh-sweep-outside-')
    const treasure = aged(join(outside, 'call-1-shell.txt'), 40)
    const dir = join(spillRoot, 'session-1')
    mkdirSync(dir)

    // Windows refuses both link kinds without Developer Mode or elevation; the
    // rule is the same one either would prove, so take whichever is available.
    let linkedDir: string | undefined = join(spillRoot, 'session-2')
    try {
      symlinkSync(outside, linkedDir, 'junction')
    } catch {
      linkedDir = undefined
    }
    let linkedFile: string | undefined = join(dir, 'call-9-shell.txt')
    try {
      symlinkSync(treasure, linkedFile, 'file')
    } catch {
      linkedFile = undefined
    }
    if (linkedDir === undefined && linkedFile === undefined) return

    await swept(spillRoot, 30)

    // Whichever link this host could make, the target is untouched: an `lstat`
    // that reported the LINK's own age, or a walk that descended it, would have
    // taken the file behind it.
    expect(existsSync(treasure)).toBe(true)
    if (linkedFile !== undefined) expect(existsSync(linkedFile)).toBe(true)
  })

  it('sweeps nothing when the period is zero', async () => {
    const spillRoot = tempDir('minidsh-sweep-')
    const dir = join(spillRoot, 'session-1')
    mkdirSync(dir)
    const ancient = aged(join(dir, 'call-1-shell.txt'), 4000)

    await swept(spillRoot, 0)

    expect(existsSync(ancient)).toBe(true)
  })

  it('provides the store and warns about nothing when the root is not there', async () => {
    const spillRoot = tempDir('minidsh-sweep-')
    // A store nothing ever wrote to is the normal case, not a failure to report.
    const mounted = await mount(join(spillRoot, 'never-written'), 30)
    expect(mounted.get(SPILL)).toBeDefined()
    await mounted.dispose()
    root = undefined
    expect(warnings).toEqual([])
  })
})
