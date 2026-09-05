/**
 * The local spill store: oversized tool output as files under MiniDSH home,
 * beside the session logs and as durable as they are.
 *
 * It writes through `node:fs` rather than `ctx.fs`, and that is the point of
 * the seam rather than a hole in it: `ctx.fs` is the boundary the MODEL's
 * effects cross, and this is the harness saving its own record of what a tool
 * produced — the same trust class as `persistence-jsonl` writing the log. The
 * model never writes here. It only reads, which no sandbox mode fences.
 *
 * DSH's `spill-local` uses the OS temp directory. MiniDSH uses home, because a
 * durable `tool/result` naming a path is a lie once a reboot deletes it. That
 * divergence is also why the sweep below needs none of the trusted-directory
 * and ancestor-permission checks upstream's does: `~/.minidsh/spill` is not a
 * world-writable temp tree, so there is no planted-path surface to defend.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Context, Plugin } from '../../kernel/index.ts'
import { SPILL, type Spill, type SpillRef, type SpillRequest } from '../../core/spill/index.ts'

export interface SpillLocalConfig {
  /** Store root; per-session subdirectories are created beneath it. */
  readonly root: string
  /**
   * Days a spill file survives. The sweep runs once at load; `0` disables it.
   * One knob, and the off switch is a value of it rather than a second flag.
   */
  readonly cleanupPeriodDays?: number | undefined
}

const configSchema = z.strictObject({ root: z.string().min(1), cleanupPeriodDays: z.number().int().nonnegative().optional() })

const DEFAULT_CLEANUP_PERIOD_DAYS = 30
const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Anything that could escape the directory, hide the file, or surprise a shell.
 * Leading dots go too: `..` survives the character filter intact, and a name
 * beginning with one is at best invisible and at worst read as a traversal.
 */
function safeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '')
  return cleaned.length === 0 ? 'output' : cleaned.slice(0, 64)
}

/**
 * The sweep deletes only what THIS writer could have generated, matched by
 * exact shape rather than by prefix: `safeName`'s alphabet, its no-leading-dot
 * rule and its 64-character bound, anchored at both ends. A directory a person
 * put here by hand, a backup, a test fixture — none of them match, and none of
 * them are touched.
 */
const SWEPT_DIR = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/
/** `<safeName(callId)>-<safeName(label)>.txt`: two bounded segments and a separator. */
const SWEPT_FILE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,128}\.txt$/

/**
 * One best-effort pass over the store, started at load.
 *
 * A spill file is an AFFORDANCE, not content (ARCHITECTURE §9): the excerpt
 * beside it is already the truth of what the model was shown, so it is the one
 * store here that may expire. Everything about how it expires is defensive:
 * one cutoff snapshotted before the walk, `lstat` so a symlink is skipped and
 * never followed, regular files only, STRICTLY older than the cutoff (a file
 * exactly at it stays), `unlink` per file and a non-recursive `rmdir` of a
 * directory observed empty — never a recursive delete, and never on disposal,
 * because a fork inherits its parent's spill locators.
 */
async function sweep(root: string, cutoff: number): Promise<void> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    // A store that was never written to is the normal case, not a failure.
    return
  }
  for (const name of names) {
    if (!SWEPT_DIR.test(name)) continue
    const dir = join(root, name)
    try {
      // `lstat`, not the dirent's type: a symlink to a directory must be
      // skipped here rather than descended into somebody else's tree.
      if (!(await lstat(dir)).isDirectory()) continue
    } catch {
      continue
    }
    await sweepSession(dir, cutoff)
  }
}

/**
 * Bounded, because this is pure I/O latency: measured on this machine, a
 * serial pass over a thousand-file store with half of it expiring takes 930 ms
 * and the same pass eight at a time takes 461 ms, while an unbounded fan-out
 * over a large store would queue thousands of operations against libuv's pool
 * for no further gain.
 */
const SWEEP_CONCURRENCY = 8

async function sweepSession(dir: string, cutoff: number): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  const candidates = names.filter((name) => SWEPT_FILE.test(name))
  let remaining = names.length
  const expire = async (name: string): Promise<void> => {
    const file = join(dir, name)
    try {
      const stat = await lstat(file)
      if (!stat.isFile() || stat.mtimeMs >= cutoff) return
      await unlink(file)
      remaining--
    } catch (error) {
      // Two processes may share one home. A file the other one already removed
      // is the goal reached, not a failure worth reporting.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') remaining--
    }
  }
  for (let at = 0; at < candidates.length; at += SWEEP_CONCURRENCY) {
    await Promise.all(candidates.slice(at, at + SWEEP_CONCURRENCY).map(expire))
  }
  if (remaining > 0) return
  try {
    // Non-recursive by construction: `ENOTEMPTY` if a writer raced in, which is
    // the outcome we want in that race.
    await rmdir(dir)
  } catch {
    /* left for the next pass */
  }
}

/** The sweep, with every failure contained — the report included. A store's housekeeping may never fail a boot. */
async function sweepQuietly(ctx: Context, config: SpillLocalConfig): Promise<void> {
  const days = config.cleanupPeriodDays ?? DEFAULT_CLEANUP_PERIOD_DAYS
  if (days === 0) return
  try {
    await sweep(config.root, Date.now() - days * MS_PER_DAY)
  } catch (error) {
    try {
      ctx.logger.warn(`spill: the retention sweep did not finish: ${String(error)}`)
    } catch {
      /* nothing left to report to */
    }
  }
}

class LocalSpill implements Spill {
  private readonly root: string

  constructor(root: string) {
    this.root = root
  }

  save(request: SpillRequest): SpillRef {
    const dir = join(this.root, safeName(request.sessionId))
    // 0700 on POSIX; Windows inherits the home's ACL, which is the user's own.
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, `${safeName(request.callId)}-${safeName(request.label)}.txt`)
    writeFileSync(path, request.text, 'utf8')
    return { path, bytes: statSync(path).size }
  }

}

/** Provides `ctx.spill`. Without this row, tools bound their output and say the rest is gone. */
export const spillLocalPlugin: Plugin<SpillLocalConfig> = {
  name: 'spill-local',
  config: configSchema,
  apply(ctx, config) {
    ctx.provide(SPILL, new LocalSpill(config.root))
    // Started at load and NOT awaited here. A synchronous pass was measured on
    // this machine at 54 ms over a thousand-file store with nothing to expire
    // and 271 ms when half of it went — a delay every `minidsh chat` would pay
    // before its first prompt. Started instead, boot pays 0.5 ms and DISPOSAL
    // waits (218 ms and 461 ms for those two stores), so shutdown is quiescent
    // and a test is deterministic. One pass, not a timer: a long-lived host is
    // swept at its next start, which ARCHITECTURE §13 states rather than hides.
    const swept = sweepQuietly(ctx, config)
    ctx.effect(() => () => swept, 'spill-sweep')
  },
}
