/**
 * The in-process filesystem fence. Every assertion is about the WORLD: a
 * denied write must leave nothing on disk, not merely return an error.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, type Context, type Logger } from '../../kernel/index.ts'
import { FS, type Fs } from '../../core/fs/index.ts'
import { sandboxPlugin, type SandboxMode } from '../../core/sandbox/index.ts'
import { fsLocalPlugin } from './index.ts'

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

/** A bare root: the policy source and the provider, nothing else. */
async function mountFs(workspaceRoot: string, mode: SandboxMode): Promise<Fs> {
  root = createRoot({ logger: silent })
  root.plugin(sandboxPlugin, { mode, workspaceRoot })
  root.plugin(fsLocalPlugin)
  await root.settle()
  return root.get(FS)
}

describe('the filesystem fence', () => {
  it('writes inside the workspace and refuses one outside it, leaving no trace', async () => {
    const workspace = tempDir('minidsh-ws-')
    const elsewhere = tempDir('minidsh-out-')
    const fs = await mountFs(workspace, 'workspace-write')

    await fs.writeText(fs.resolve('inside.txt', workspace), 'ok', { kind: 'unconditional' }, {})
    expect(readFileSync(join(workspace, 'inside.txt'), 'utf8')).toBe('ok')

    const outside = join(elsewhere, 'nested', 'escape.txt')
    await expect(fs.writeText(fs.resolve(outside, workspace), 'nope', { kind: 'unconditional' }, {})).rejects.toThrowError(/FS_SANDBOX_DENIED|outside/)
    expect(existsSync(outside)).toBe(false)
    // The parent directory is an effect too, and it must not have been created.
    expect(existsSync(join(elsewhere, 'nested'))).toBe(false)
  })

  it('carries the code that names the denial, so the durable record is legible', async () => {
    const workspace = tempDir('minidsh-ws-')
    const elsewhere = tempDir('minidsh-out-')
    const fs = await mountFs(workspace, 'workspace-write')
    const thrown = (await fs
      .writeText(fs.resolve(join(elsewhere, 'x.txt'), workspace), 'nope', { kind: 'unconditional' }, {})
      .then(
        () => undefined,
        (error: unknown) => error,
      )) as { code?: string; message?: string } | undefined
    expect(thrown?.code).toBe('FS_SANDBOX_DENIED')
    expect(thrown?.message).toContain('workspace-write')
  })

  it('refuses every mutation under read-only, including one inside the workspace', async () => {
    const workspace = tempDir('minidsh-ws-')
    const fs = await mountFs(workspace, 'read-only')
    const target = join(workspace, 'inside.txt')
    await expect(fs.writeText(fs.resolve(target, workspace), 'nope', { kind: 'unconditional' }, {})).rejects.toThrowError(/read-only/)
    expect(existsSync(target)).toBe(false)
  })

  it('never fences a read: the mode vocabulary governs file EFFECTS only', async () => {
    const workspace = tempDir('minidsh-ws-')
    const elsewhere = tempDir('minidsh-out-')
    writeFileSync(join(elsewhere, 'readable.txt'), 'visible', 'utf8')
    const fs = await mountFs(workspace, 'read-only')
    const read = await fs.readText(fs.resolve(join(elsewhere, 'readable.txt'), workspace), {})
    expect(read.text).toBe('visible')
  })

  it('delegates unfenced under danger-full-access', async () => {
    const workspace = tempDir('minidsh-ws-')
    const elsewhere = tempDir('minidsh-out-')
    const fs = await mountFs(workspace, 'danger-full-access')
    const target = join(elsewhere, 'allowed.txt')
    await fs.writeText(fs.resolve(target, workspace), 'yes', { kind: 'unconditional' }, {})
    expect(readFileSync(target, 'utf8')).toBe('yes')
  })

  it('has no boundary to enforce without a policy source, so the provider refuses to load', async () => {
    root = createRoot({ logger: silent })
    root.plugin(fsLocalPlugin)
    const report = await root.settle()
    expect(report.pending.map((entry) => entry.name)).toContain('fs-local')
  })
})
