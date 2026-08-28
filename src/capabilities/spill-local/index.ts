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
 * durable `tool/result` naming a path is a lie once a reboot deletes it.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Plugin } from '../../kernel/index.ts'
import { SPILL, type Spill, type SpillRef, type SpillRequest } from '../../core/spill/index.ts'

export interface SpillLocalConfig {
  /** Store root; per-session subdirectories are created beneath it. */
  readonly root: string
}

const configSchema = z.strictObject({ root: z.string().min(1) })

/**
 * Anything that could escape the directory, hide the file, or surprise a shell.
 * Leading dots go too: `..` survives the character filter intact, and a name
 * beginning with one is at best invisible and at worst read as a traversal.
 */
function safeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '')
  return cleaned.length === 0 ? 'output' : cleaned.slice(0, 64)
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
  },
}
