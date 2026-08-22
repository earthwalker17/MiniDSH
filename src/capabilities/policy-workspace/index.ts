/**
 * A minimal workspace boundary for the editor: a `str_replace_editor` mutation
 * whose target resolves outside the session cwd is denied. This is a SEAM
 * DEMONSTRATION, not a real boundary — the shell is unconfined in S1, so an
 * editor/shell asymmetry exists (see ARCHITECTURE.md §13); S3 replaces this
 * with per-call sandbox policy shared by fs and shell.
 */
import { relative as posixRelative } from 'node:path/posix'
import { parse as winParse, relative as winRelative } from 'node:path/win32'
import type { Plugin } from '../../kernel/index.ts'
import { FS, type Fs } from '../../core/fs/index.ts'
import { TOOLS_PRE_EXECUTE, type PreToolDecision } from '../../core/tools/index.ts'

const MUTATING = new Set(['create', 'str_replace', 'insert'])

/**
 * True when `target` is inside `root` (case-insensitive on win32).
 *
 * Path roots must match first: `path.relative` between different roots (a UNC
 * share vs a drive, or two different drives) returns the target verbatim, which
 * would otherwise read as "inside".
 */
export function isInside(root: string, target: string): boolean {
  if (process.platform === 'win32') {
    const rootParsed = winParse(root)
    const targetParsed = winParse(target)
    if (rootParsed.root.toLowerCase() !== targetParsed.root.toLowerCase()) return false
    const rel = winRelative(root.toLowerCase(), target.toLowerCase())
    return rel === '' || (!rel.startsWith('..') && !winParse(rel).root)
  }
  const rel = posixRelative(root, target)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))
}

export const policyWorkspacePlugin: Plugin = {
  name: 'policy-workspace',
  inject: [FS],
  apply(ctx) {
    const fs: Fs = ctx.get(FS)
    ctx.on(TOOLS_PRE_EXECUTE, async (execution, next): Promise<PreToolDecision> => {
      if (execution.name !== 'str_replace_editor' || !execution.agent) return next()
      const args = execution.arguments as { command?: string; path?: string }
      if (!args.command || !MUTATING.has(args.command) || typeof args.path !== 'string') return next()
      const cwd = execution.agent.session.header.cwd
      const target = fs.resolve(args.path, cwd)
      const root = fs.workspaceRoot(execution.agent.session)
      if (!isInside(root, target.path)) {
        return { kind: 'deny', reason: `FS_OUTSIDE_WORKSPACE: "${args.path}" is outside the workspace root ${root}` }
      }
      return next()
    })
  },
}
