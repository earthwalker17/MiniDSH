/**
 * A minimal workspace boundary for the editor: a `str_replace_editor` mutation
 * whose target resolves outside the session cwd is denied. This is a SEAM
 * DEMONSTRATION, not a real boundary — the shell is unconfined in S1, so an
 * editor/shell asymmetry exists (see ARCHITECTURE.md §13); S3 replaces this
 * with per-call sandbox policy shared by fs and shell.
 */
import { relative as posixRelative } from 'node:path/posix'
import { relative as winRelative } from 'node:path/win32'
import type { Plugin } from '../../kernel/index.ts'
import { FS, type Fs } from '../../core/fs/index.ts'
import { TOOLS_PRE_EXECUTE, type PreToolDecision } from '../../core/tools/index.ts'

const MUTATING = new Set(['create', 'str_replace', 'insert'])

/** True when `target` is inside `root` (case-insensitive on win32). */
function isInside(root: string, target: string): boolean {
  const win = process.platform === 'win32'
  const rel = win ? winRelative(root.toLowerCase(), target.toLowerCase()) : posixRelative(root, target)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !/^[a-z]:/i.test(rel))
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
