/**
 * The macOS confinement dialect: Seatbelt, through `sandbox-exec`.
 *
 * The binary is marked DEPRECATED in its own man page and is still what every
 * comparable harness uses; it is present on current macOS and applies to the
 * whole process tree, so confining the persistent shell confines every command
 * it later runs. Unlike bwrap it does not change the filesystem VIEW: paths
 * outside the allow-list stay visible and readable, and only writes are
 * refused. That difference is deliberate and observable, and it is why the
 * cross-platform assertion is "no host file outside the ceiling changed"
 * rather than "the same error came back".
 */
import type { SandboxExecutionPolicy } from '../../../core/sandbox/index.ts'
import { writableRoots } from '../../../core/sandbox/index.ts'

export const SEATBELT_BIN = 'sandbox-exec'

/**
 * Character devices a shell genuinely writes to. None of them is a host file:
 * writing to `/dev/null` or `/dev/tty` leaves nothing on disk, so allowing
 * them does not widen the ceiling, and `(deny file-write*)` without them
 * breaks `> /dev/null` in the first command anyone runs.
 *
 * A deliberate widening over DSH, which allows `/dev/null` alone: DSH confines
 * a fresh `bash -c` per command, and this confines a PERSISTENT interactive
 * shell, which has more of the standard descriptors open. Written as literals
 * rather than a `/dev/` subpath, because that subpath would also grant the raw
 * disk devices.
 */
const DEVICE_LITERALS: readonly string[] = [
  '/dev/null',
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/tty',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/dtracehelper',
]

/**
 * `sandbox-exec` argv: the profile plus one `-D` parameter per ceiling root.
 *
 * `(allow default)` then `(deny file-write*)` then the holes — so reads,
 * network and exec stay open and only file effects are governed, which is
 * exactly what `SandboxMode` claims to be about.
 *
 * Roots go in as PARAMETERS, never interpolated into the profile text. A
 * workspace path containing a quote or a backslash would otherwise close the
 * SBPL string literal early and silently widen the grant — a path the model
 * does not choose, but the user does. (DSH interpolates and escapes; a
 * parameter needs no escaper to be right.)
 */
export function seatbeltArgs(policy: SandboxExecutionPolicy): string[] {
  const roots = writableRoots(policy)
  const forms = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${DEVICE_LITERALS.map((path) => `(literal "${path}")`).join(' ')})`,
  ]
  const params: string[] = []
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map((_, index) => `(subpath (param "WRITABLE_ROOT_${index}"))`).join(' ')})`)
    roots.forEach((root, index) => params.push(`-DWRITABLE_ROOT_${index}=${root}`))
  }
  return ['-p', forms.join(' '), ...params]
}

/** What a write refused by this mechanism says, in its own words. */
export const SEATBELT_DENIALS: readonly string[] = ['operation not permitted']

/** What `sandbox-exec` itself says when it cannot start; the command never ran. */
export const SEATBELT_RUNNER_FAILURES: readonly string[] = ['sandbox-exec:']
