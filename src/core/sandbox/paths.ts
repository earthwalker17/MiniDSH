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
 *
 * A HARD link is not a link to follow: it passes containment by name, and a
 * write through one lands on the outside inode (ARCHITECTURE §13). Detecting
 * it needs inode identity per write, and an `nlink > 1` refusal would deny
 * every pnpm-installed file, which the store hard-links. Both confinement
 * backends share the shape, measured (`shell-stdio/confine.test.ts`,
 * 2026-09-26/27): they confine by path, write through a pre-existing link,
 * and refuse to create one across the boundary or to write the outside name.
 */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { relative as posixRelative } from 'node:path/posix'
import { parse as winParse } from 'node:path/win32'

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
 * True when `target` is inside `root`. Both must be CANONICAL (`canonicalPath`):
 * every existing component then carries the spelling the disk resolved, so
 * containment is an exact comparison of names, never a case fold of them.
 *
 * Why no fold on win32, where names are case-insensitive: NTFS compares through
 * its own upcase table, and JavaScript's `toLowerCase` is not that table. The
 * Kelvin sign folds to "k" in JS and is a different letter on disk, so a fence
 * that lowercased both sides accepted `..\desKtop-work\x` as inside
 * `desktop-work` while the write created a sibling directory outside it
 * (S20.5, measured). An existing component already arrives in its on-disk
 * spelling, and a missing one cannot equal an existing sibling by another
 * spelling, so the exact comparison refuses nothing that is really inside.
 * A caller that passes a raw spelling is refused, which is the safe direction.
 * Only the root (a drive letter, a UNC server and share) is compared without
 * case, as Windows itself does.
 *
 * Path roots must match first: between different roots (a UNC share and a
 * drive, two drives) nothing below them can be compared.
 */
export function isInside(root: string, target: string): boolean {
  if (process.platform === 'win32') {
    const rootParsed = winParse(root)
    const targetParsed = winParse(target)
    if (rootParsed.root.toLowerCase() !== targetParsed.root.toLowerCase()) return false
    const base = belowRoot(root, rootParsed.root)
    const rest = belowRoot(target, targetParsed.root)
    return base === '' || rest === base || rest.startsWith(`${base}\\`)
  }
  const rel = posixRelative(root, target)
  // `..` as a whole first SEGMENT, never as a prefix: `..env.bak` is a name.
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('/'))
}

/** A win32 path's part below its root, one separator style, no trailing separator. */
function belowRoot(path: string, root: string): string {
  return path.slice(root.length).replaceAll('/', '\\').replace(/\\+$/, '')
}
