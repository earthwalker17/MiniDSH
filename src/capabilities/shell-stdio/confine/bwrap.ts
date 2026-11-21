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
 *
 * The profile follows DeepSeek Harness's bwrap runner (`dsh-sandbox-local`,
 * https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-local/README.md)
 * flag for flag, with three additions of MiniDSH's own; the writable set it
 * grants is MiniDSH's own too (`writableRoots`).
 *
 * - **`--new-session`**, since S11.5 (the profile notes below say why).
 * - **The user runtime directory is masked** (`BwrapHost.runtimeDir`, and
 *   `BWRAP_WITHHELD_ENV`). Upstream leaves `/run/user/<uid>` visible, and a
 *   read-only bind refuses a write to a file, not a `connect()` to a socket:
 *   a confined command ran `systemd-run --user` over the session bus there,
 *   and the user's own systemd, outside every namespace, wrote a file outside
 *   the workspace for it, in workspace-write and in read-only alike (S22.5,
 *   reproduced under WSL 2). A file effect the mode forbids, reached without
 *   one forbidden write, so the profile hides the sockets that offer it.
 * - **The runtime's own install directories stay readable** under the
 *   private `/tmp` (`BwrapHost.expose`).
 *
 * What stays reachable, because the network namespace is shared and only
 * this one directory is masked: the system bus and every service behind it,
 * a docker socket for a user in the docker group, abstract sockets, and any
 * service listening on loopback (ARCHITECTURE §13).
 */
import type { SandboxExecutionPolicy } from '../../../core/sandbox/index.ts'
import { writableRoots } from '../../../core/sandbox/index.ts'

export const BWRAP_BIN = 'bwrap'

/**
 * Facts about THIS host and this installation that the profile is built
 * around. Passed in, never looked up here, so the builder stays a pure
 * function a test can read on any platform.
 */
export interface BwrapHost {
  /**
   * The user runtime directory (`/run/user/<uid>`), when this host has one:
   * where the session bus, the user systemd's private socket and a rootless
   * container engine's socket live.
   */
  readonly runtimeDir?: string | undefined
  /**
   * Directories the runtime itself is installed in (the shell row's `expose`):
   * its Node, its bundled skills. An AppImage mounts all of it under
   * `/tmp/.mount_*`, which the profile's private `/tmp` would hide from every
   * confined command.
   */
  readonly expose?: readonly string[] | undefined
}

/** Whether `path` is `root` or lies beneath it. POSIX spellings only: bwrap exists nowhere else. */
function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

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
 * - `--tmpfs <runtime dir>` in EVERY confined mode, read-only included: the
 *   sockets in it answer a `connect()` whatever the mount says (the header).
 *   Under `read-only` the mask is remounted read-only, so that mode still
 *   grants nowhere to write; under `workspace-write` it is a private scratch
 *   directory like `/tmp`, reaching no host file.
 * - `--ro-bind <path> <path>` for each of the runtime's own install
 *   directories that lies under `/tmp` or under the runtime directory, after
 *   the tmpfs that hid it and before the writable binds; and, under
 *   `read-only`, for a workspace that lies under the runtime directory, which
 *   nothing else would show. Read-only, and reads are unrestricted by
 *   design (§7): the path was readable through `--ro-bind / /` until the
 *   mask covered it, so this widens nothing. One already inside a writable
 *   root is left to that root's bind.
 *
 * No `--unshare-net`: the mode vocabulary governs file effects only. No
 * `--chdir`: the cwd is inherited and lands correctly even under the masked
 * `/tmp` (measured). No `--clearenv`: the environment is the caller's, less
 * `BWRAP_WITHHELD_ENV`.
 */
export function bwrapArgs(policy: SandboxExecutionPolicy, host: BwrapHost = {}): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--new-session']
  const roots = writableRoots(policy)
  const exposed = (host.expose ?? []).map((given) => given.replace(/(?<=.)\/+$/, ''))
  /** The exposed paths strictly beneath a mask, less those a writable root's own bind will show. */
  const beneath = (mask: string): string[] => exposed.filter((path) => path !== mask && within(mask, path) && !roots.some((root) => within(root, path)))
  if (host.runtimeDir !== undefined) {
    const mask = host.runtimeDir
    args.push('--tmpfs', mask)
    // Bound back beneath the mask, read-only, before it is sealed: what a
    // command must still READ there. Under `read-only` nothing else binds the
    // workspace, so one that lies in this directory (a GVFS mount, a portal's
    // document path) would be an empty folder to its own session; and an
    // AppImage started with TMPDIR set here has its Node and skills in it.
    // Only that subtree comes back, never the directory's sockets. A workspace
    // that IS the directory stays masked: showing it would be the mask undone.
    const kept = new Set(beneath(mask))
    if (roots.length === 0 && policy.workspaceRoot !== mask && within(mask, policy.workspaceRoot)) kept.add(policy.workspaceRoot)
    for (const path of kept) args.push('--ro-bind', path, path)
    if (roots.length === 0) args.push('--remount-ro', mask)
  }
  if (roots.length > 0) {
    args.push('--tmpfs', '/tmp')
    for (const path of beneath('/tmp')) args.push('--ro-bind', path, path)
    for (const root of roots) args.push('--bind', root, root)
  }
  return args
}

/**
 * Variables a confined child does not inherit: each names a service outside
 * the sandbox by an address the profile no longer shows. Without the bus
 * address a client falls back to `$XDG_RUNTIME_DIR/bus`, which is the masked
 * directory, and finds nothing; `XDG_RUNTIME_DIR` itself stays, naming what is
 * now an empty private directory.
 */
export const BWRAP_WITHHELD_ENV: readonly string[] = ['DBUS_SESSION_BUS_ADDRESS']

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
