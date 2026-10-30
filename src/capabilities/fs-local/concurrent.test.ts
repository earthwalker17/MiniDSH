/**
 * S21: parallel children of one step write through one provider in one
 * process. The version check, the truncate and the write are separate awaits,
 * so without the per-path lock two writers holding the same version both
 * passed the check and the second silently erased the first — each told
 * "Edited" — and a read overlapping a write could see the truncated file.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { FS, type Fs } from '../../core/fs/index.ts'
import { sandboxPlugin } from '../../core/sandbox/index.ts'
import { fsLocalPlugin } from './index.ts'

const silent: Logger = { warn: () => {}, error: () => {} }
const dirs: string[] = []
let root: Context | undefined

afterEach(async () => {
  await root?.dispose()
  root = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function localFs(): Promise<{ fs: Fs; workspace: string }> {
  const workspace = mkdtempSync(join(tmpdir(), 'minidsh-concurrent-'))
  dirs.push(workspace)
  root = createRoot({ logger: silent })
  root.plugin(sandboxPlugin, { mode: 'workspace-write', workspaceRoot: workspace })
  root.plugin(fsLocalPlugin)
  await root.settle()
  return { fs: root.get(FS), workspace }
}

describe('fs-local orders its own callers per file', () => {
  it('lets exactly one of two writers holding the same version win, and the file holds only its edit', async () => {
    const { fs, workspace } = await localFs()
    writeFileSync(join(workspace, 'shared.txt'), 'original\n')
    const target = fs.resolve('shared.txt', workspace)
    const { version } = await fs.readText(target, {})
    const settled = await Promise.allSettled([
      fs.writeText(target, 'edit from the first child\n', { kind: 'replaceIfVersion', version }, {}),
      fs.writeText(target, 'edit from the second child, which is longer\n', { kind: 'replaceIfVersion', version }, {}),
    ])
    const won = settled.filter((outcome) => outcome.status === 'fulfilled')
    const lost = settled.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(lost[0]!.reason).toMatchObject({ code: 'FS_STALE_VERSION' })
    const text = readFileSync(join(workspace, 'shared.txt'), 'utf8')
    expect(settled[0]!.status === 'fulfilled' ? 'edit from the first child\n' : 'edit from the second child, which is longer\n').toBe(text)
  })

  it('never lets a read see a file another caller is midway through writing', async () => {
    const { fs, workspace } = await localFs()
    const before = 'b'.repeat(256 * 1024)
    const after = 'a'.repeat(512 * 1024)
    writeFileSync(join(workspace, 'big.txt'), before)
    const target = fs.resolve('big.txt', workspace)
    const { version } = await fs.readText(target, {})
    for (let round = 0; round < 5; round++) {
      const current = readFileSync(join(workspace, 'big.txt'), 'utf8')
      const next = current === before ? after : before
      const { version: now } = round === 0 ? { version } : await fs.readText(target, {})
      const [, read] = await Promise.all([fs.writeText(target, next, { kind: 'replaceIfVersion', version: now }, {}), fs.readText(target, {})])
      expect([before, after]).toContain(read.text)
    }
  })
})
