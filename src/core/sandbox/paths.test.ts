/**
 * The containment primitive. The property under test is not "it normalizes
 * paths" but "the path it returns is the one the effect lands on" — a fence
 * that contains a name the operating system would not follow is not a fence.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { FS, type Fs } from '../fs/index.ts'
import { fsLocalPlugin } from '../../capabilities/fs-local/index.ts'
import { allowsWrite, canonicalPath, isInside, sandboxPlugin } from './index.ts'

const silent: Logger = { warn: () => {}, error: () => {} }

const dirs: string[] = []
let root: Context | undefined
afterEach(async () => {
  await root?.dispose()
  root = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/**
 * Directory junctions need no privilege on Windows, where a file symlink does;
 * either kind exercises the same blind spot, so the tests take what the host
 * will give and skip only if neither works.
 */
function makeLink(target: string, link: string): boolean {
  for (const type of ['junction', 'dir'] as const) {
    try {
      symlinkSync(target, link, type)
      return true
    } catch {
      continue
    }
  }
  return false
}

const probe = tempDir('minidsh-linkprobe-')
const linksWork = makeLink(join(probe, 'nothing-here'), join(probe, 'probe-link'))
/** A drive letter with nothing mounted on it (Windows only): somewhere a junction can point that has no root. */
const absentDrive = process.platform === 'win32' ? [...'QRSTUVWXYZ'].find((letter) => !existsSync(`${letter}:\\`)) : undefined

describe.skipIf(!linksWork)('canonicalPath and links', () => {
  it('follows a DANGLING link, which existsSync and realpath both miss but a write does not', () => {
    const workspace = tempDir('minidsh-ws-')
    const elsewhere = tempDir('minidsh-out-')
    // The target does not exist, so the link is invisible to existsSync.
    expect(makeLink(join(elsewhere, 'target'), join(workspace, 'escape'))).toBe(true)
    expect(existsSync(join(workspace, 'escape'))).toBe(false)

    const resolved = canonicalPath(join(workspace, 'escape', 'owned.txt'))
    expect(isInside(canonicalPath(workspace), resolved)).toBe(false)
    expect(isInside(canonicalPath(elsewhere), resolved)).toBe(true)
    expect(allowsWrite({ mode: 'workspace-write', workspaceRoot: canonicalPath(workspace) }, resolved)).toBe(false)
  })

  it('resolves a live link to its target, so an in-workspace name pointing out is contained', () => {
    const workspace = tempDir('minidsh-ws-')
    const elsewhere = tempDir('minidsh-out-')
    mkdirSync(join(elsewhere, 'real'))
    expect(makeLink(join(elsewhere, 'real'), join(workspace, 'link'))).toBe(true)
    const resolved = canonicalPath(join(workspace, 'link', 'note.txt'))
    expect(isInside(canonicalPath(workspace), resolved)).toBe(false)
  })

  it('the fence itself refuses a write aimed through a link out of the workspace', async () => {
    const workspace = tempDir('minidsh-ws-')
    const elsewhere = tempDir('minidsh-out-')
    expect(makeLink(join(elsewhere, 'target'), join(workspace, 'escape'))).toBe(true)

    root = createRoot({ logger: silent })
    root.plugin(sandboxPlugin, { mode: 'workspace-write', workspaceRoot: workspace })
    root.plugin(fsLocalPlugin)
    await root.settle()
    const fs: Fs = root.get(FS)

    await expect(fs.writeText(fs.resolve('escape/owned.txt', workspace), 'no', { kind: 'unconditional' }, {})).rejects.toThrowError(/FS_SANDBOX_DENIED|outside/)
    expect(existsSync(join(elsewhere, 'target', 'owned.txt'))).toBe(false)
    expect(existsSync(join(elsewhere, 'target'))).toBe(false)
  })

  /**
   * The spelling a wire client can send as a new session's `cwd`. On Linux and
   * macOS nothing under `<root>/missing/..` exists, so the walk collected
   * `missing`, `..` and `link` as a tail it never examined and joined them
   * back to `<root>/link`: a link, unfollowed, that containment then accepted
   * by name where the direct spelling `<root>/link` was refused. Windows
   * resolves `..` before it looks, so there this passes with or without the
   * second walk; the POSIX run is the one that fails without it.
   */
  it('follows a link reached through `..` after a missing segment, exactly as it follows it by name', () => {
    const workspace = tempDir('minidsh-ws-')
    const elsewhere = tempDir('minidsh-out-')
    mkdirSync(join(elsewhere, 'real'))
    expect(makeLink(join(elsewhere, 'real'), join(workspace, 'link'))).toBe(true)
    const inside = canonicalPath(workspace)
    const direct = canonicalPath(join(workspace, 'link'))
    expect(isInside(inside, direct)).toBe(false)

    // Built by hand: `join` would resolve the `..` before canonicalPath saw it.
    const spellings: [spelled: string, expected: string][] = [
      [`${workspace}/missing/../link`, direct],
      [`${workspace}/missing/../link/new.txt`, join(direct, 'new.txt')],
      [`${workspace}/a/b/../../link/deep/new.txt`, join(direct, 'deep', 'new.txt')],
      // No link in the way: the same spelling of an ordinary missing file stays inside.
      [`${workspace}/missing/../plain/new.txt`, join(inside, 'plain', 'new.txt')],
    ]
    expect(spellings.map(([spelled]) => canonicalPath(spelled))).toEqual(spellings.map(([, expected]) => expected))
    expect(spellings.map(([spelled]) => isInside(inside, canonicalPath(spelled)))).toEqual([false, false, false, true])
    // The contract, stated as a fixpoint: a result has nothing left to follow.
    for (const [spelled] of spellings) expect(canonicalPath(canonicalPath(spelled)), spelled).toBe(canonicalPath(spelled))
  })

  it.skipIf(process.platform === 'win32')('follows a link whose own target is spelled that way, and stops on one that answers so forever', () => {
    const workspace = tempDir('minidsh-ws-')
    const elsewhere = tempDir('minidsh-out-')
    mkdirSync(join(elsewhere, 'real'))
    symlinkSync(join(elsewhere, 'real'), join(elsewhere, 'hop'))
    // An absolute target is taken as the link spells it, `..` included.
    symlinkSync(`${elsewhere}/missing/../hop`, join(workspace, 'via-target'))
    expect(canonicalPath(join(workspace, 'via-target', 'new.txt'))).toBe(join(canonicalPath(join(elsewhere, 'real')), 'new.txt'))
    symlinkSync(`${workspace}/missing/../again`, join(workspace, 'again'))
    expect(() => canonicalPath(join(workspace, 'again', 'x.txt'))).toThrowError(/too many symbolic links/)
  })

  // A junction may name a drive that is not there. Nothing along its target
  // exists, not even a root, and the walk then answered with the path it was
  // GIVEN, the junction's own name, inside the workspace: an unfollowed link
  // the write would follow the moment that drive appeared.
  it.skipIf(absentDrive === undefined)('follows a junction to a drive that is not there, rather than answering with its own name', () => {
    const workspace = tempDir('minidsh-ws-')
    const target = `${absentDrive}:\\nothing\\here`
    expect(makeLink(target, join(workspace, 'offline'))).toBe(true)
    const resolved = canonicalPath(join(workspace, 'offline', 'owned.txt'))
    expect(resolved).toBe(`${target}\\owned.txt`)
    expect(isInside(canonicalPath(workspace), resolved)).toBe(false)
  })

  it('leaves an ordinary path alone', () => {
    const workspace = tempDir('minidsh-ws-')
    writeFileSync(join(workspace, 'plain.txt'), 'x', 'utf8')
    const resolved = canonicalPath(join(workspace, 'plain.txt'))
    expect(isInside(canonicalPath(workspace), resolved)).toBe(true)
    // A path that does not exist yet still resolves under its existing ancestor.
    expect(isInside(canonicalPath(workspace), canonicalPath(join(workspace, 'deep', 'later.txt')))).toBe(true)
  })
})

describe('containment decides by the filesystem\'s own name identity', () => {
  // NTFS compares names through its own upcase table, in which the Kelvin
  // sign is not a "K"; JavaScript's toLowerCase folds it to "k". A fence that
  // compared by the second while the disk resolved by the first accepted
  // `..\des\u{212A}top-work\owned.txt` as inside `desktop-work` and the write
  // created a sibling directory OUTSIDE the workspace (S20.5 audit, A6-01).
  it.skipIf(process.platform !== 'win32')('refuses a homoglyph sibling the disk treats as a different directory', async () => {
    const base = tempDir('minidsh-fold-')
    const workspace = join(base, 'desktop-work')
    mkdirSync(workspace)
    const sibling = join(workspace, '..', 'des\u{212A}top-work', 'owned.txt')
    expect(isInside(canonicalPath(workspace), canonicalPath(sibling))).toBe(false)

    root = createRoot({ logger: silent })
    root.plugin(sandboxPlugin, { mode: 'workspace-write', workspaceRoot: workspace })
    root.plugin(fsLocalPlugin)
    await root.settle()
    const fs: Fs = root.get(FS)
    await expect(fs.writeText(fs.resolve(sibling, workspace), 'no', { kind: 'unconditional' }, {})).rejects.toThrowError(/FS_SANDBOX_DENIED|outside/)
    expect(existsSync(join(base, 'des\u{212A}top-work'))).toBe(false)
    // The case a person types differently is still the same directory, and inside.
    expect(isInside(canonicalPath(workspace), canonicalPath(join(base, 'DESKTOP-WORK', 'fine.txt')))).toBe(true)
  })

  it('keeps an inside name that merely begins with two dots', () => {
    const workspace = tempDir('minidsh-ws-')
    for (const name of ['..env.bak', '...', join('..hidden', 'x.txt')]) {
      expect(isInside(canonicalPath(workspace), canonicalPath(join(workspace, name))), name).toBe(true)
    }
    expect(isInside(canonicalPath(workspace), canonicalPath(join(workspace, '..', 'x.txt')))).toBe(false)
  })
})

describe('canonicalPath without links', () => {
  // The name used to promise the refusal and the body asserted the opposite
  // case, so a green result said nothing about either. The refusal itself —
  // an EXISTING entry the host will not resolve must throw rather than fall
  // back to its spelling — is not reachable portably and is pinned by stubbing
  // `fs.resolve` in `workspace-instructions/instructions.test.ts`. What IS
  // portable is the other half of the same rule, and that is what this says.
  it('resolves a missing path under its existing ancestor rather than refusing it', () => {
    const workspace = tempDir('minidsh-ws-')
    expect(() => canonicalPath(join(workspace, 'nope', 'still-fine.txt'))).not.toThrow()
    expect(isInside(canonicalPath(workspace), canonicalPath(join(workspace, 'nope', 'still-fine.txt')))).toBe(true)
  })

  // POSIX answers ENOTDIR for a name beneath a regular file, which lstat's
  // `throwIfNoEntry: false` does not cover: it was thrown raw and reached a
  // tool result as an uncoded errno line. It is a name that cannot exist, so it
  // resolves like any other missing tail (Windows answered ENOENT all along).
  it('resolves a name beneath a regular file as a missing one, on every platform', () => {
    const workspace = tempDir('minidsh-ws-')
    writeFileSync(join(workspace, 'plain.txt'), 'a file, not a directory')
    expect(canonicalPath(join(workspace, 'plain.txt', 'child', 'deeper.txt'))).toBe(join(canonicalPath(workspace), 'plain.txt', 'child', 'deeper.txt'))
  })
})
