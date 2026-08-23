/**
 * Path identity for the authority plane.
 *
 * ONE canonicalization and ONE containment rule for the whole system: the
 * in-process filesystem fence and any future execution-confinement backend
 * both derive their allow-list from here, so "the editor cannot write the temp
 * directory but the shell can" asymmetries cannot arise between them.
 *
 * The contract that makes the fence sound: the path returned here is the one
 * the caller then acts on, and it contains no link the operating system could
 * still follow somewhere else. A primitive that cannot establish a path's
 * identity refuses rather than answering by name.
 */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { relative as posixRelative } from 'node:path/posix'
import { parse as winParse, relative as winRelative } from 'node:path/win32'

/** Matches the kernel's own limit closely enough; a cycle must terminate, not hang. */
const MAX_LINK_HOPS = 32

/**
 * Canonicalizes a path, following symbolic links even when their target does
 * not exist yet, and resolving the nearest existing ancestor for a path yet to
 * be created.
 *
 * `existsSync` follows links, so a DANGLING link is invisible to it — and to
 * `realpathSync`, which also refuses to resolve one. It is not invisible to
 * the `open()` a write performs, which follows it and lands on the target. So
 * links are followed here explicitly: otherwise the fence would contain a name
 * inside the workspace while the effect landed outside it.
 */
export function canonicalPath(path: string): string {
  let current = path
  const suffix: string[] = []
  let hops = 0
  for (;;) {
    // lstat, not exists: a dangling link IS an entry, and the one that matters.
    const entry = lstatSync(current, { throwIfNoEntry: false })
    if (entry?.isSymbolicLink()) {
      if (++hops > MAX_LINK_HOPS) throw new Error(`too many symbolic links while resolving "${path}"`)
      const target = readlinkSync(current)
      current = isAbsolute(target) ? target : resolvePath(dirname(current), target)
      continue
    }
    if (entry) {
      // A throw here is not recoverable by guessing: a path whose identity the
      // host will not disclose must be refused, never trusted by its spelling.
      const real = realpathSync.native(current)
      return suffix.length === 0 ? real : resolvePath(real, ...suffix)
    }
    const parent = dirname(current)
    if (parent === current) return resolvePath(path)
    // basename, not slice(parent.length + 1): a root parent ("C:\") already ends
    // in a separator, and slicing would eat the first character of the segment.
    // Nothing here exists, so no accumulated segment can itself be a link.
    suffix.unshift(basename(current))
    current = parent
  }
}

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
