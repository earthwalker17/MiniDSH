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
 * What it reads is the command's TEXT, so it sees a path only where the text
 * names one. Every word of a deleting statement is tried as a path, a bare
 * `wt` as much as `./wt`, against each directory the statement could be
 * running in: the session's, one an earlier `cd` on the same line moved to,
 * and `git -C <dir>`. Git Bash's spellings of a Windows path are read as that
 * shell reads them. A path held in a variable, or made by a glob, is not
 * seen: that is the limit of reading text, and the reason rule 1 comes first.
 *
 * Exit 2 blocks the call and returns the reason to the agent.
 * `scripts/guard-repo.test.ts` feeds it tool inputs and reads the exit code;
 * the hook only ever inspects a command, so nothing in that test deletes.
 */
import { lstatSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Verbs that CREATE a link. Matched per statement, so a grep that merely
 * mentions one is not a link. A verb counts at the start of a statement, after
 * a space, or right after a quote: `cmd //c "mklink …"` is still a mklink.
 */
const LINK_VERBS = [
  /(^|[\s;&|({"'])mklink\b/i,
  // New-Item, or its alias `ni`, asked for a link type under any spelling of
  // the parameter: `-ItemType`, its alias `-Type`, or a prefix PowerShell accepts.
  /(^|[\s;&|({"'])(new-item|ni)\b[^\n]*\b(symboliclink|junction|hardlink)\b/i,
  /(^|[\s;&|({"'])ln\s+(-[a-z]*s|--symbolic)/i,
  /(^|[\s;&|({"'])junction(\.exe)?\s/i,
]

/** Verbs that delete a directory TREE, and would therefore follow a link inside it. */
const RECURSIVE_DELETES = [
  // `git worktree remove`, with or without `-C <dir>` before the subcommand.
  /(^|[\s;&|({"'])git\b[^\n]*\bworktree\s+remove\b/i,
  // rm with a recursive flag anywhere among its arguments: -r, -R, -rf, -fr, --recursive.
  /(^|[\s;&|({"'])rm\b[^\n]*?\s(-[a-z]*r[a-z]*|--recursive)(?=[\s"']|$)/i,
  // PowerShell's Remove-Item and its aliases, `-Recurse` abbreviated as PowerShell allows (`-r`, `-rec`).
  /(^|[\s;&|({"'])(remove-item|ri|del|erase|rd|rmdir)\b[^\n]*?\s-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?=[\s:"']|$)/i,
  /(^|[\s;&|({"'])(rd|rmdir)\b[^\n]*?\s\/s\b/i,
]

/** `cd <dir>` in any of its spellings: where the rest of the line runs. */
const CHANGE_DIRECTORY = /^[\s({]*(?:cd|chdir|pushd|set-location|sl|push-location)\s+(?:\/d\s+|--\s+|-(?:literal)?path\s+)?(?:"([^"]*)"|'([^']*)'|(\S+))/i

/** One command line as separate statements, so a verb in one is not attributed to a path in another. */
function statements(command) {
  return command
    .split(/\n|&&|\|\||[;|]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/**
 * Every word of a statement that could name a path: quoted runs and bare
 * words alike, a comma list taken apart. A quoted run is taken whole (a path
 * with a space in it) AND word by word (a command handed to another shell,
 * `bash -c "rm -rf wt"`). Flags are left out, and so is anything with a
 * variable in it, whose value this cannot know.
 */
function pathTokens(statement) {
  const tokens = []
  const take = (text) => {
    for (const piece of text.split(',')) {
      const word = piece.trim().replace(/^[({]+|[)}]+$/g, '').replace(/[\\/]+$/, '')
      if (word.length === 0 || word.startsWith('-') || word.includes('$')) continue
      tokens.push(word)
    }
  }
  for (const match of statement.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const quoted = match[1] ?? match[2]
    take(quoted ?? match[3] ?? '')
    if (quoted !== undefined && /\s/.test(quoted)) for (const inner of quoted.split(/\s+/)) take(inner)
  }
  return tokens
}

/**
 * A path as the shell that will run the command reads it, from `base`. Git
 * Bash on Windows spells `C:\x` as `/c/x`, the temp folder as `/tmp` and the
 * home folder as `~`; Node would read the first as `\c\x` on the current drive
 * and find nothing there.
 */
function located(base, word) {
  let path = word
  if (path === '~' || /^~[\\/]/.test(path)) path = join(homedir(), path.slice(1))
  else if (process.platform === 'win32') {
    const drive = /^\/([a-z])(?:\/(.*))?$/i.exec(path)
    if (drive) path = `${drive[1]}:/${drive[2] ?? ''}`
    else if (path === '/tmp' || path.startsWith('/tmp/')) path = join(tmpdir(), path.slice(4))
  }
  return resolve(base, path)
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
/** Where the statement being read runs: the session's directory, until a `cd` on this line moves it. */
let cwd = typeof input?.cwd === 'string' ? input.cwd : process.cwd()

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

  const moved = CHANGE_DIRECTORY.exec(statement)
  if (moved) {
    const to = moved[1] ?? moved[2] ?? moved[3] ?? ''
    // A directory this cannot know (a variable, `cd -`) leaves the last known one standing.
    if (to.length > 0 && !to.includes('$') && !to.startsWith('-')) cwd = located(cwd, to.replace(/[)}]+$/, ''))
    continue
  }

  if (!RECURSIVE_DELETES.some((pattern) => pattern.test(statement))) continue
  // `git -C <dir> …` runs in that directory, whatever the shell's own is.
  const bases = [cwd, ...[...statement.matchAll(/\s-C\s+(?:"([^"]*)"|'([^']*)'|(\S+))/g)].map((match) => located(cwd, match[1] ?? match[2] ?? match[3] ?? ''))]
  const candidates = new Set(pathTokens(statement).flatMap((word) => bases.map((base) => located(base, word))))
  for (const candidate of candidates) {
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
