/**
 * A read of a path a model or a repository names is bounded by the bytes that
 * arrive, never by the size `stat` reports (core/fs `FsReadOptions`). The S20.5
 * audit OOM-killed a host through a repository `SKILL.md` linked to
 * `/proc/self/pagemap`: a regular file of size 0 whose read never ends.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { FS, type Fs } from '../../core/fs/index.ts'
import { sandboxPlugin } from '../../core/sandbox/index.ts'
import { discoverSkills } from '../skills/discover.ts'
import { fsLocalPlugin } from './index.ts'

const silent: Logger = { warn: () => {}, error: () => {} }
const dirs: string[] = []
let root: Context | undefined

afterEach(async () => {
  await root?.dispose()
  root = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'minidsh-read-'))
  dirs.push(dir)
  return dir
}

async function localFs(workspace: string): Promise<Fs> {
  root = createRoot({ logger: silent })
  root.plugin(sandboxPlugin, { mode: 'workspace-write', workspaceRoot: workspace })
  root.plugin(fsLocalPlugin)
  await root.settle()
  return root.get(FS)
}

describe('fs-local reads are bounded by the bytes they read', () => {
  it('refuses a file past the bound, or returns its prefix when asked to', async () => {
    const workspace = tempDir()
    writeFileSync(join(workspace, 'big.txt'), 'x'.repeat(10_000))
    const fs = await localFs(workspace)
    const target = fs.resolve('big.txt', workspace)
    await expect(fs.readBytes(target, {}, { maxBytes: 4_096 })).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    await expect(fs.readText(target, {}, { maxBytes: 4_096 })).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
    const prefix = await fs.readText(target, {}, { maxBytes: 4_096, partial: true })
    expect(prefix.complete).toBe(false)
    expect(prefix.text).toHaveLength(4_096)
    const whole = await fs.readText(target, {}, { maxBytes: 10_000 })
    expect(whole.complete).toBe(true)
    expect(whole.text).toHaveLength(10_000)
  })

  it('never splits a character at the bound of a partial read', async () => {
    const workspace = tempDir()
    // 'é' is two bytes: a bound of 3 lands inside the second one.
    writeFileSync(join(workspace, 'accents.txt'), 'éé')
    const fs = await localFs(workspace)
    const { text, complete } = await fs.readText(fs.resolve('accents.txt', workspace), {}, { maxBytes: 3, partial: true })
    expect(complete).toBe(false)
    expect(text).toBe('é')
  })

  it.skipIf(process.platform === 'win32')('refuses a FIFO at once instead of waiting for a writer', async () => {
    const workspace = tempDir()
    execFileSync('mkfifo', [join(workspace, 'pipe')])
    const fs = await localFs(workspace)
    const started = Date.now()
    await expect(fs.readBytes(fs.resolve('pipe', workspace), {})).rejects.toMatchObject({ code: 'FS_NOT_A_FILE' })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it.skipIf(process.platform !== 'linux')('stops a procfs file that reports size 0 and never ends', async () => {
    const workspace = tempDir()
    const fs = await localFs(workspace)
    await expect(fs.readBytes(fs.resolve('/proc/self/pagemap', workspace), {}, { maxBytes: 65_536 })).rejects.toMatchObject({ code: 'FS_TOO_LARGE' })
  })

  it.skipIf(process.platform !== 'linux')('skips a repository SKILL.md linked to procfs, and the scan completes', async () => {
    const workspace = tempDir()
    mkdirSync(join(workspace, '.git'))
    mkdirSync(join(workspace, '.agents', 'skills', 'trap'), { recursive: true })
    symlinkSync('/proc/self/pagemap', join(workspace, '.agents', 'skills', 'trap', 'SKILL.md'))
    const fs = await localFs(workspace)
    const scan = await discoverSkills(fs, workspace, { roots: [] })
    expect(scan.skipped.map((skip) => skip.reason)).toContain(`larger than ${256 * 1024} bytes`)
  })
})
