/**
 * A PreToolUse guard for the one class of damage this repository has actually
 * suffered: a throwaway directory that borrows a real `node_modules` through a
 * filesystem link, and is then deleted by something that walks into it.
 *
 * On 2026-09-01 a review subagent did exactly that — `mklink /J` from a git
 * worktree under the scratchpad to `MiniDSH\node_modules`, then
 * `git worktree remove --force`. Git's recursive delete followed the junction
 * and wiped `node_modules/.bin` out of the live repository; it stopped there
 * only because a concurrent `vitest run` held the rest of the tree open. pnpm's
 * own state file survived, so `pnpm install --frozen-lockfile` then reported
 * "Already up to date" and repaired nothing — the fix was a full reinstall.
 * It has happened more than once.
 *
 * Model reasoning is not the boundary here (CLAUDE.md §13). The rule is
 * mechanical and narrow, and it is three shapes:
 *   1. never LINK anything to a `node_modules` tree;
 *   2. never recursively delete a path that IS a link (on Windows the delete
 *      walks through a junction instead of unlinking it);
 *   3. never recursively delete a directory that HOLDS a `node_modules` link.
 * A worktree that genuinely needs dependencies runs its own `pnpm install`;
 * this project has no build step, so most inspection needs no worktree at all.
 *
 * Exit 2 blocks the call and returns the reason to the agent.
 */
import { lstatSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/** Verbs that CREATE a link. Matched per statement, so a grep that merely mentions one is not a link. */
const LINK_VERBS = [
  /(^|[\s;&|(])mklink\b/i,
  /(^|[\s;&|(])new-item\b[^\n]*?-itemtype\s*['"]?\s*(symboliclink|junction|hardlink)/i,
  /(^|[\s;&|(])ln\s+-[a-z]*s/i,
  /(^|[\s;&|(])junction(\.exe)?\s/i,
]

/** Verbs that delete a directory TREE, and would therefore follow a link inside it. */
const RECURSIVE_DELETES = [
  /(^|[\s;&|(])git\s+worktree\s+remove\b/i,
  /(^|[\s;&|(])rm\s+(-[a-z]*\s+)*-[a-z]*r/i,
  /(^|[\s;&|(])remove-item\b[^\n]*-recurse/i,
  /(^|[\s;&|(])(rd|rmdir)\s+\/s\b/i,
]

/** One command line as separate statements, so a verb in one is not attributed to a path in another. */
function statements(command) {
  return command
    .split(/\n|&&|\|\||[;|]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/** Every path-shaped token in a statement: quoted runs, and bare non-flag words containing a separator. */
function pathTokens(statement) {
  const tokens = []
  for (const match of statement.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const value = match[1] ?? match[2] ?? match[3] ?? ''
    if (value.length === 0 || value.startsWith('-') || value.startsWith('$')) continue
    if (/[\\/]/.test(value)) tokens.push(value.replace(/[\\/]+$/, ''))
  }
  return tokens
}

/** True when the path itself is a link (junction, symlink) rather than a real directory. */
function isLink(target) {
  try {
    return lstatSync(target).isSymbolicLink()
  } catch {
    return false
  }
}

/** True when `<dir>/node_modules` exists AND is a link, so deleting `dir` walks into its target. */
function holdsLinkedModules(dir) {
  try {
    return lstatSync(join(dir, 'node_modules')).isSymbolicLink()
  } catch {
    return false
  }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function deny(lines) {
  process.stderr.write(`${lines.join('\n')}\n`)
  process.exit(2)
}

let input = {}
try {
  input = JSON.parse((await readStdin()) || '{}')
} catch {
  process.exit(0)
}
const command = input?.tool_input?.command
if (typeof command !== 'string' || command.length === 0) process.exit(0)
const cwd = typeof input?.cwd === 'string' ? input.cwd : process.cwd()

for (const statement of statements(command)) {
  if (/node_modules/i.test(statement) && LINK_VERBS.some((verb) => verb.test(statement))) {
    deny([
      'BLOCKED by .claude/hooks/guard-repo.mjs: this statement links a directory to a node_modules tree.',
      `  ${statement}`,
      "Linking this repo's node_modules into a scratch directory or a git worktree is how it was destroyed twice:",
      'the next recursive delete of that directory (git worktree remove, rm -rf, Remove-Item -Recurse) follows the',
      'link back into the live dependency tree.',
      'Instead: run `pnpm install` inside the worktree, or work without one — this project has no build step, so',
      '`git show <rev>:<path>` into a scratch copy is enough to read or diff any revision.',
    ])
  }

  if (!RECURSIVE_DELETES.some((pattern) => pattern.test(statement))) continue
  for (const token of pathTokens(statement)) {
    const candidate = isAbsolute(token) ? token : resolve(cwd, token)
    // The target itself being a link is the same hazard by a shorter path:
    // git-bash `rm -rf` walks INTO a Windows junction rather than unlinking it.
    if (isLink(candidate)) {
      deny([
        `BLOCKED by .claude/hooks/guard-repo.mjs: "${candidate}" is a filesystem LINK, and this statement deletes`,
        'directories recursively:',
        `  ${statement}`,
        'On Windows a recursive delete walks THROUGH a junction and empties its target instead of unlinking it.',
        `Unlink it instead: cmd //c rmdir "${candidate}" — that removes the junction and leaves the target alone.`,
      ])
    }
    if (!holdsLinkedModules(candidate)) continue
    deny([
      `BLOCKED by .claude/hooks/guard-repo.mjs: "${candidate}" holds a node_modules LINK, and this statement deletes`,
      'directories recursively:',
      `  ${statement}`,
      'The delete would follow that link into the real dependency tree — exactly the failure that wiped',
      'node_modules/.bin on 2026-09-01.',
      `Remove the link first — cmd //c rmdir "${candidate}/node_modules" unlinks a junction without touching its`,
      'target — confirm it is gone, and only then delete the directory.',
    ])
  }
}

process.exit(0)
