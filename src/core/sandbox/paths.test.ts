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

  it('leaves an ordinary path alone', () => {
    const workspace = tempDir('minidsh-ws-')
    writeFileSync(join(workspace, 'plain.txt'), 'x', 'utf8')
    const resolved = canonicalPath(join(workspace, 'plain.txt'))
    expect(isInside(canonicalPath(workspace), resolved)).toBe(true)
    // A path that does not exist yet still resolves under its existing ancestor.
    expect(isInside(canonicalPath(workspace), canonicalPath(join(workspace, 'deep', 'later.txt')))).toBe(true)
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
})
