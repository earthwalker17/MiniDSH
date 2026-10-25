/**
 * Local-disk filesystem provider, fenced in process.
 *
 * TEXT reads and writes emit `fs/observed` so the read-before-edit policy can
 * track state; `readBytes` deliberately does NOT, because a byte read is not a
 * content observation and an observation is a licence to overwrite — see the
 * Definition. `writeText` enforces the resolved write intent (createIfAbsent /
 * replaceIfVersion / unconditional) AND the session sandbox policy.
 *
 * The fence is a check in TRUSTED code over a MODEL-CONTROLLED path: the
 * operations are the seam's own (open, mkdir, write) and only the target is
 * untrusted, so canonicalize-then-contain answers a path. It does not answer
 * a CONCURRENT process that swaps a link in under the path between the check
 * and the open, which is why a write is verified through its open handle
 * (`writeText`). Kernel-grade isolation of untrusted CODE stays the shell's.
 */
import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, readdir, readlink, stat, type FileHandle } from 'node:fs/promises'
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
  type FsReadOptions,
  type FsTarget,
  type FsWriteIntent,
} from '../../core/fs/index.ts'
import { EFFECT_RECORDED } from '../../core/effects/index.ts'
import { allowsWrite, canonicalPath, SANDBOX, type Sandbox, type SandboxExecutionPolicy } from '../../core/sandbox/index.ts'

function versionOf(info: { mtimeMs: number; size: number }): string {
  return `${info.mtimeMs.toFixed(3)}:${info.size}`
}

/** The ceiling of a read that names none: no path a model or a repository names may cost the host more. */
const DEFAULT_MAX_READ_BYTES = 64 * 1024 * 1024
const READ_CHUNK_BYTES = 1024 * 1024
/**
 * `O_NONBLOCK` so opening a FIFO returns at once rather than waiting for a
 * writer that may never come; the handle's own `stat` then refuses it. Windows
 * has no FIFO in the filesystem and no such flag.
 */
const READ_FLAGS = process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NONBLOCK

/**
 * The one read path (`FsReadOptions`, core/fs): open, require a regular file
 * of the OPEN handle (no race with a swap after a stat), and stop at the bound
 * by counting what arrives — a procfs file reports size 0 and streams forever.
 * The version comes from the same handle, so it describes the bytes returned.
 */
async function boundedRead(target: FsTarget, options: FsReadOptions): Promise<{ bytes: Uint8Array; version: string; complete: boolean }> {
  const maxBytes = Math.min(options.maxBytes ?? DEFAULT_MAX_READ_BYTES, DEFAULT_MAX_READ_BYTES)
  let handle: FileHandle
  try {
    handle = await open(target.path, READ_FLAGS)
  } catch {
    throw new FsError('FS_NOT_FOUND', `cannot read "${target.displayPath}"`)
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new FsError('FS_NOT_A_FILE', `"${target.displayPath}" is not a regular file`)
    const chunks: Buffer[] = []
    let total = 0
    // Whole chunks, so a read may pass the bound by at most one: a procfs file
    // such as `pagemap` refuses (EINVAL) a read whose length is not a multiple
    // of its record size, and a bound-sized last read would hit exactly that.
    // One scratch buffer, and only what each read returned copied out: a view
    // into a fresh chunk per read pinned 1 MiB for every short read, and a
    // seq_file such as `/proc/kallsyms` answers ~4 KiB at a time (2 GB held
    // for an 8 MiB bound, S20.5 review).
    const scratch = Buffer.allocUnsafe(READ_CHUNK_BYTES)
    while (total <= maxBytes) {
      let bytesRead: number
      try {
        ;({ bytesRead } = await handle.read(scratch, 0, READ_CHUNK_BYTES, null))
      } catch (error) {
        throw new FsError('FS_IO', `cannot read "${target.displayPath}" (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`)
      }
      if (bytesRead === 0) break
      chunks.push(Buffer.from(scratch.subarray(0, bytesRead)))
      total += bytesRead
    }
    const bytes = Buffer.concat(chunks, total)
    const version = versionOf(info)
    if (total <= maxBytes) return { bytes, version, complete: true }
    if (options.partial !== true) throw new FsError('FS_TOO_LARGE', `"${target.displayPath}" is larger than ${maxBytes} bytes`)
    return { bytes: bytes.subarray(0, maxBytes), version, complete: false }
  } finally {
    await handle.close()
  }
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
      const uid = process.getuid?.()
      return {
        type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
        version: versionOf(info),
        size: info.size,
        // Root owns every file in effect: a container's root working on a
        // repository bind-mounted from its host must still find that root.
        ...(uid === undefined ? {} : { ownedByMe: uid === 0 || info.uid === uid }),
      }
    } catch {
      return undefined
    }
  }

  async readText(target: FsTarget, actor: FsActor, options: FsReadOptions = {}): Promise<{ text: string; version: string; complete: boolean }> {
    const { bytes, version, complete } = await boundedRead(target, options)
    // `stream: true` holds back a multi-byte character the bound cut in half
    // instead of rendering half of it as U+FFFD; `ignoreBOM` keeps a BOM as
    // the text's first character, as `toString('utf8')` did, so an edit
    // writes it back (S20.5 review: edits were stripping it).
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes, { stream: !complete })
    this.scopeOf(actor).emit(FS_OBSERVED, target, { kind: 'present', version }, actor)
    return { text, version, complete }
  }

  /** Bytes, and deliberately no `fs/observed` — see the Definition. */
  async readBytes(target: FsTarget, _actor: FsActor, options: FsReadOptions = {}): Promise<{ bytes: Uint8Array; version: string; complete: boolean }> {
    return boundedRead(target, options)
  }

  /** `fs/*` events about an agent's operation are dispatched in that agent's scope. */
  private scopeOf(actor: FsActor): Context {
    return actor.agent?.ctx ?? this.ctx
  }

  /**
   * Fence, then act through what the fence approved — not through the name.
   *
   * A check on a name and a later open of that name are two moments, and a
   * process inside the workspace (a confined job may make links there) can
   * swap a directory for a link to outside between them: the S20.5 audit
   * landed 24 of 25 accepted writes outside that way. Node has no
   * `openat`/`RESOLVE_BENEATH`, so this cannot be one atomic step; instead
   * every effect is verified after it is taken and before a byte moves:
   *
   * - each missing directory is fenced as its own level, made alone, and must
   *   then be a directory, not a link someone put in its place;
   * - the file is opened without truncation (`O_NOFOLLOW` where the platform
   *   has it, `O_EXCL` for a create), its path canonicalized again, and the
   *   open handle must be the inode that path now names, inside the fence;
   * - the version check and the write both go through that handle.
   *
   * What remains (ARCHITECTURE §13): a swap timed into those windows can leave
   * an EMPTY directory or file outside, never content; a hard link is still
   * not detectable.
   */
  async writeText(target: FsTarget, text: string, intent: FsWriteIntent, actor: FsActor): Promise<{ version: string }> {
    // Fenced before ANY effect — creating parent directories is already one.
    const fenced = this.fence(target, actor)
    if (intent.kind === 'replaceIfVersion' && !(await this.stat(fenced))) throw new FsError('FS_NOT_FOUND', `"${target.displayPath}" no longer exists`)
    await this.makeParents(fenced, actor)
    const flags =
      constants.O_WRONLY |
      (intent.kind === 'replaceIfVersion' ? 0 : constants.O_CREAT) |
      (intent.kind === 'createIfAbsent' ? constants.O_EXCL : 0) |
      (constants.O_NOFOLLOW ?? 0)
    let handle: FileHandle
    try {
      handle = await open(fenced.path, flags, 0o666)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') throw new FsError('FS_EXISTS', `"${target.displayPath}" already exists`)
      if (code === 'ENOENT') throw new FsError('FS_NOT_FOUND', `"${target.displayPath}" no longer exists`)
      // ELOOP: the last component became a link after the fence (O_NOFOLLOW).
      if (code === 'ELOOP') throw this.moved(target)
      throw new FsError('FS_IO', `cannot write "${target.displayPath}" (${code ?? 'unknown error'})`)
    }
    let written: FsTarget
    let version: string
    try {
      const held = await handle.stat({ bigint: true })
      if (!held.isFile()) throw new FsError('FS_NOT_A_FILE', `"${target.displayPath}" is not a regular file`)
      written = await this.verifyHeld(handle, held, fenced, actor)
      if (intent.kind === 'replaceIfVersion' && versionOf(await handle.stat()) !== intent.version) {
        throw new FsError('FS_STALE_VERSION', `"${target.displayPath}" changed since it was read`)
      }
      await handle.truncate(0)
      await handle.writeFile(text, 'utf8')
      // Before the version read, which can fail on a write that already landed
      // and would then throw past the record as well as past the caller.
      this.record(written, text, actor)
      version = versionOf(await handle.stat())
    } finally {
      await handle.close()
    }
    this.scopeOf(actor).emit(FS_OBSERVED, written, { kind: 'present', version }, actor)
    return { version }
  }

  /**
   * Where the open handle really is, contained. Linux names the file a handle
   * holds (`/proc/self/fd`), which no swap can falsify: the one sound answer,
   * and Linux is where a confined job can race the fence. Elsewhere only names
   * can be asked, so the check is by name: canonicalize, compare the handle's
   * inode with the one the name reaches, canonicalize again. A swap timed
   * between those three can still pass (§13), which on Windows needs a
   * process that could write outside anyway (no backend confines one) and on
   * macOS a confined job racing the editor.
   */
  private async verifyHeld(handle: FileHandle, held: BigIntStats, fenced: FsTarget, actor: FsActor): Promise<FsTarget> {
    const real = process.platform === 'linux' ? await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined) : undefined
    if (real !== undefined) {
      // Unlinked is a fact of the inode, not of the name: `/proc` appends
      // " (deleted)" to an unlinked file's path, and a file may really be
      // named that (S20.5 review).
      const now = await handle.stat({ bigint: true })
      const path = now.nlink === 0n ? undefined : real
      if (path === undefined || !allowsWrite(this.policyFor(actor), path)) throw this.moved(fenced)
      return { ...fenced, path }
    }
    const first = this.fence(fenced, actor)
    const named = await stat(first.path, { bigint: true }).catch(() => undefined)
    const second = this.fence(fenced, actor)
    if (named === undefined || named.dev !== held.dev || named.ino !== held.ino || second.path !== first.path) throw this.moved(fenced)
    return first
  }

  /** Each missing ancestor fenced, made alone, and checked to be the directory the fence approved. */
  private async makeParents(target: FsTarget, actor: FsActor): Promise<void> {
    const missing: string[] = []
    for (let dir = dirname(target.path); ; ) {
      if (await lstat(dir).then(() => true, () => false)) break
      missing.unshift(dir)
      const up = dirname(dir)
      if (up === dir) break
      dir = up
    }
    for (const dir of missing) {
      const level = this.fence({ path: dir, displayPath: target.displayPath }, actor)
      try {
        await mkdir(level.path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new FsError('FS_IO', `cannot create a directory for "${target.displayPath}" (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`)
      }
      const made = await lstat(level.path).catch(() => undefined)
      if (!made?.isDirectory()) throw this.moved(target)
    }
  }

  private moved(target: FsTarget): FsError {
    return new FsError('FS_SANDBOX_DENIED', `"${target.displayPath}" changed while it was being written (a directory or link was swapped under it), so no content was written; an empty file may remain where it was opened`)
  }

  /**
   * The effect, on the record: the CANONICAL path the fence approved, the
   * byte length written and a hash of those exact bytes — enough for a
   * resumed session to read the file back and tell a landed write from a lost
   * one. Never `target.displayPath`, which is the model's own spelling and
   * stays where model text belongs, in the `tool/call` arguments.
   *
   * After the write, so its presence is proof and its absence is not. It is
   * evidence, never a barrier: a session closed under an abandoned body, or a
   * pre-commit invariant that rejects the append, must not fail a write that
   * has already landed on the disk.
   */
  private record(target: FsTarget, text: string, actor: FsActor): void {
    if (!actor.agent || actor.callId === undefined) return
    try {
      actor.agent.session.append(EFFECT_RECORDED, {
        callId: actor.callId,
        effect: 'fs-write',
        path: target.path,
        bytes: Buffer.byteLength(text, 'utf8'),
        sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
      })
    } catch (error) {
      this.ctx.logger.warn(`fs-local: the effect record for ${target.path} was not appended`, error)
    }
  }

  async listDir(target: FsTarget): Promise<DirEntry[]> {
    const entries = await readdir(target.path, { withFileTypes: true })
    return entries.map((entry) => ({ name: entry.name, type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other' }))
  }

  /** Canonicalize, then contain: returns the target the caller may actually act on. */
  private policyFor(actor: FsActor): SandboxExecutionPolicy {
    return this.sandbox.resolve(actor.agent ? { session: actor.agent.session } : {})
  }

  private fence(target: FsTarget, actor: FsActor): FsTarget {
    const resolved: FsTarget = { ...target, path: canonicalPath(target.path) }
    const policy = this.policyFor(actor)
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
