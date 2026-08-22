/**
 * Local-disk filesystem provider. Reads and writes emit `fs/observed` so the
 * read-before-edit policy can track state; `writeText` enforces the resolved
 * write intent (createIfAbsent / replaceIfVersion / unconditional).
 */
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve as resolvePath } from 'node:path'
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
import type { Session } from '../../core/session/index.ts'

/** Canonicalizes an existing path, or the nearest existing ancestor for a path yet to be created. */
function canonical(path: string): string {
  let current = path
  const suffix: string[] = []
  for (;;) {
    if (existsSync(current)) {
      try {
        return suffix.length === 0 ? realpathSync.native(current) : resolvePath(realpathSync.native(current), ...suffix)
      } catch {
        return resolvePath(current, ...suffix)
      }
    }
    const parent = dirname(current)
    if (parent === current) return resolvePath(path)
    // basename, not slice(parent.length + 1): a root parent ("C:\") already ends
    // in a separator, and slicing would eat the first character of the segment.
    suffix.unshift(basename(current))
    current = parent
  }
}

function versionOf(info: { mtimeMs: number; size: number }): string {
  return `${info.mtimeMs.toFixed(3)}:${info.size}`
}

class LocalFs implements Fs {
  private readonly ctx: Context
  constructor(ctx: Context) {
    this.ctx = ctx
  }

  resolve(path: string, cwd: string): FsTarget {
    const abs = isAbsolute(path) ? path : resolvePath(cwd, path)
    return { path: canonical(abs), displayPath: path }
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
    const current = await this.stat(target)
    if (intent.kind === 'createIfAbsent' && current) throw new FsError('FS_EXISTS', `"${target.displayPath}" already exists`)
    if (intent.kind === 'replaceIfVersion') {
      if (!current) throw new FsError('FS_NOT_FOUND', `"${target.displayPath}" no longer exists`)
      if (current.version !== intent.version) throw new FsError('FS_STALE_VERSION', `"${target.displayPath}" changed since it was read`)
    }
    await mkdir(dirname(target.path), { recursive: true })
    await writeFile(target.path, text, 'utf8')
    const info = await stat(target.path)
    const version = versionOf(info)
    this.scopeOf(actor).emit(FS_OBSERVED, target, { kind: 'present', version }, actor)
    return { version }
  }

  async listDir(target: FsTarget): Promise<DirEntry[]> {
    const entries = await readdir(target.path, { withFileTypes: true })
    return entries.map((entry) => ({ name: entry.name, type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other' }))
  }

  workspaceRoot(session: Session): string {
    return canonical(session.header.cwd)
  }
}

/** Provides `ctx.fs` backed by the local disk. */
export const fsLocalPlugin: Plugin = {
  name: 'fs-local',
  apply(ctx) {
    ctx.provide(FS, new LocalFs(ctx))
  },
}

export { canonical as canonicalPath }
