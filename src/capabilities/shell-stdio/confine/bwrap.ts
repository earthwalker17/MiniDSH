/**
 * The Linux confinement dialect: bubblewrap.
 *
 * A user+mount namespace with the host root bound read-only and one writable
 * hole per ceiling root. Enforcement is the kernel's: a write outside the
 * holes fails `EROFS` before any filesystem sees it.
 *
 * Why an external binary rather than the syscalls directly: making a bound
 * root read-only means remounting every submount under it, and a mount
 * inherited from the parent user namespace may only have restrictions ADDED,
 * never removed. A walk that passes just `MS_RDONLY|MS_NOSUID|MS_NODEV` clears
 * `noexec` on the mounts that carry it and fails `EPERM` — measured on this
 * project's WSL 2 target, where 12 of 34 submounts refuse it. bwrap ORs the
 * existing flags in and gets 33 of 34 (the one refusal is a shadowed duplicate
 * mount, invisible either way). That detail is the argument against a
 * hand-rolled backend, not a footnote.
 */
import type { SandboxExecutionPolicy } from '../../../core/sandbox/index.ts'
import { writableRoots } from '../../../core/sandbox/index.ts'

export const BWRAP_BIN = 'bwrap'

/**
 * The profile, in bwrap's strictly left-to-right order.
 *
 * - `--ro-bind / /` is the boundary; everything else carves a hole in it.
 * - `--dev /dev` is mandatory, not decoration: the recursive read-only bind ORs
 *   `nodev` onto every submount, so device nodes stop opening without it. It
 *   mounts a writable tmpfs (bwrap's own man page says devtmpfs and is wrong),
 *   which is a private mount reaching no host file — inside the ceiling's rule,
 *   not an exception to it.
 * - `--unshare-pid` + `--proc /proc` is a security requirement upstream fixed
 *   as a bug: without a private PID namespace a confined command follows
 *   procfs magic links (`/proc/<pid>/root`, `/fd`, `/cwd`) straight out of the
 *   read-only bind, and `--proc` silently bind-mounts the HOST procfs when the
 *   namespace is not unshared.
 * - `--tmpfs /tmp` before the binds, because the order is what makes a
 *   workspace that lives UNDER `/tmp` work: the tmpfs masks the host temp
 *   directory and the bind then re-exposes the one root the ceiling names,
 *   with bwrap creating the mountpoint because the containing fs is writable.
 *   (A missing destination on a read-only fs is an error, which is why nothing
 *   is bound at all under `read-only`.)
 *
 * - `--new-session` closes the escape that needs no write at all. Without it
 *   the confined child keeps the harness's controlling terminal, and `--dev`
 *   puts a `/dev/tty` in front of it: `ioctl(TIOCSTI)` then pushes a line into
 *   the user's own shell, which runs it outside the sandbox under no ceiling.
 *   That is bubblewrap's documented CVE-2017-5226 shape, and its stated cost —
 *   breaking interactive use — is not a cost here, because this child is a
 *   non-interactive shell on pipes.
 *
 * No `--unshare-net`: the mode vocabulary governs file effects only. No
 * `--chdir`: the cwd is inherited and lands correctly even under the masked
 * `/tmp` (measured). No `--clearenv`: the environment is the caller's.
 */
export function bwrapArgs(policy: SandboxExecutionPolicy): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--new-session']
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    args.push('--tmpfs', '/tmp')
    for (const root of roots) args.push('--bind', root, root)
  }
  return args
}

/** What a write refused by this mechanism says, in its own words. */
export const BWRAP_DENIALS: readonly string[] = ['read-only file system']

/**
 * What bwrap ITSELF says when it cannot start — a different fact from a
 * denial, and it outranks one: the command never ran.
 */
export const BWRAP_RUNNER_FAILURES: readonly string[] = ['bwrap: ']

/**
 * The private tmpfs this profile mounts, when it mounts one.
 *
 * Returned so the wrapper can point `TMPDIR` at it: a shell that inherits
 * `TMPDIR=/home/me/tmp` would otherwise spool here-documents and compiler
 * intermediates at a path the sandbox correctly refuses, and the profile's own
 * writable `/tmp` would go unused. Nothing is widened — this is the mount the
 * profile already made.
 */
export function bwrapTempDir(policy: SandboxExecutionPolicy): string | undefined {
  return writableRoots(policy).length > 0 ? '/tmp' : undefined
}
