/**
 * Path identity for the authority plane.
 *
 * ONE canonicalization and ONE containment rule for the whole system: the
 * in-process filesystem fence and any future execution-confinement backend
 * both derive their allow-list from here, so "the editor cannot write the temp
 * directory but the shell can" asymmetries cannot arise between them. Both
 * functions used to exist privately in `fs-local` and `policy-workspace`.
 */
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { relative as posixRelative } from 'node:path/posix'
import { parse as winParse, relative as winRelative } from 'node:path/win32'

/**
 * Canonicalizes an existing path, or the nearest existing ancestor for a path
 * yet to be created. Symlinks are resolved for the longest existing prefix
 * BEFORE lexical normalization, so `symlink/..` agrees with what `chdir` and
 * `spawn` actually resolve.
 */
export function canonicalPath(path: string): string {
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
