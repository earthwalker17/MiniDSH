/**
 * Local-disk filesystem provider, fenced in process.
 *
 * Reads and writes emit `fs/observed` so the read-before-edit policy can track
 * state; `writeText` enforces the resolved write intent (createIfAbsent /
 * replaceIfVersion / unconditional) AND the session sandbox policy.
 *
 * The fence is a check in TRUSTED code over a MODEL-CONTROLLED path: the
 * operations are the seam own (open, mkdir, write) and only the target is
 * untrusted, so canonicalize-then-contain is the complete answer for this
 * surface. Kernel-grade isolation of untrusted CODE stays the shell problem.
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, dirname, resolve as resolvePath } from 'node:path'
import type { Plugin } from '../../kernel/index.ts'
import type { Context } from '../../kernel/index.ts'
import {
  FS,
  FS_OBSERVED,
  FsError,
  type DirEntry,
  type Fs,
  type FsActor,
  type FsInfo,
  type FsTarget,
  type FsWriteIntent,
} from '../../core/fs/index.ts'
import { allowsWrite, canonicalPath, SANDBOX, type Sandbox } from '../../core/sandbox/index.ts'

function versionOf(info: { mtimeMs: number; size: number }): string {
  return `${info.mtimeMs.toFixed(3)}:${info.size}`
}

class LocalFs implements Fs {
  private readonly ctx: Context
  private readonly sandbox: Sandbox
  constructor(ctx: Context, sandbox: Sandbox) {
    this.ctx = ctx
    this.sandbox = sandbox
  }

  resolve(path: string, cwd: string): FsTarget {
    const abs = isAbsolute(path) ? path : resolvePath(cwd, path)
    return { path: canonicalPath(abs), displayPath: path }
  }

  async stat(target: FsTarget): Promise<FsInfo | undefined> {
    try {
      const info = await stat(target.path)
      return { type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', version: versionOf(info), size: info.size }
    } catch {
      return undefined
    }
  }

  async readText(target: FsTarget, actor: FsActor): Promise<{ text: string; version: string }> {
    let text: string
    try {
      text = await readFile(target.path, 'utf8')
    } catch {
      throw new FsError('FS_NOT_FOUND', `cannot read "${target.displayPath}"`)
    }
    const info = await stat(target.path)
    const version = versionOf(info)
    this.scopeOf(actor).emit(FS_OBSERVED, target, { kind: 'present', version }, actor)
    return { text, version }
  }

  /** `fs/*` events about an agent's operation are dispatched in that agent's scope. */
  private scopeOf(actor: FsActor): Context {
    return actor.agent?.ctx ?? this.ctx
  }

  async writeText(target: FsTarget, text: string, intent: FsWriteIntent, actor: FsActor): Promise<{ version: string }> {
    // Fenced before ANY effect — creating parent directories is already one.
    const fenced = this.fence(target, actor)
    const current = await this.stat(fenced)
    if (intent.kind === 'createIfAbsent' && current) throw new FsError('FS_EXISTS', `"${target.displayPath}" already exists`)
    if (intent.kind === 'replaceIfVersion') {
      if (!current) throw new FsError('FS_NOT_FOUND', `"${target.displayPath}" no longer exists`)
      if (current.version !== intent.version) throw new FsError('FS_STALE_VERSION', `"${target.displayPath}" changed since it was read`)
    }
    await mkdir(dirname(fenced.path), { recursive: true })
    // Again immediately before the write: an ancestor symlink may have been
    // swapped in the meantime, and only the last check governs the effect.
    const written = this.fence(fenced, actor)
    await writeFile(written.path, text, 'utf8')
    const info = await stat(written.path)
    const version = versionOf(info)
    this.scopeOf(actor).emit(FS_OBSERVED, written, { kind: 'present', version }, actor)
    return { version }
  }

  async listDir(target: FsTarget): Promise<DirEntry[]> {
    const entries = await readdir(target.path, { withFileTypes: true })
    return entries.map((entry) => ({ name: entry.name, type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other' }))
  }

  /** Canonicalize, then contain: returns the target the caller may actually act on. */
  private fence(target: FsTarget, actor: FsActor): FsTarget {
    const resolved: FsTarget = { ...target, path: canonicalPath(target.path) }
    const policy = this.sandbox.resolve(actor.agent ? { session: actor.agent.session } : {})
    if (allowsWrite(policy, resolved.path)) return resolved
    throw new FsError(
      'FS_SANDBOX_DENIED',
      `"${target.displayPath}" is outside what "${policy.mode}" mode may modify` +
        (policy.mode === 'workspace-write' ? ` (workspace ${policy.workspaceRoot})` : ''),
    )
  }
}

/** Provides `ctx.fs` backed by the local disk. The fence is not optional: without a policy source there is no boundary. */
export const fsLocalPlugin: Plugin = {
  name: 'fs-local',
  inject: [SANDBOX],
  apply(ctx) {
    ctx.provide(FS, new LocalFs(ctx, ctx.get(SANDBOX)))
  },
}
