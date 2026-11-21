/**
 * Reads the fuses back out of a packed app and refuses it unless the four
 * that keep Electron's main process from running anyone's code are off:
 *
 *   node desktop/scripts/check-fuses.ts <the packed app's executable>
 *
 * "Electron main runs no user code" is a security invariant (ARCHITECTURE §9)
 * that rested on a block of configuration in `package.ts` and on nothing
 * else: no step read a fuse back. An electron-builder that renamed or ignored
 * the option, or a `true` typed by mistake, would have shipped with every leg
 * green, and `ELECTRON_RUN_AS_NODE=1` would have turned the installed app
 * into a Node interpreter for whoever set it. Every desktop leg runs this on
 * the artifact it packed (`.github/actions/desktop-leg`).
 *
 * The wire, as Electron defines it: the binary holds one sentinel string,
 * then a byte of wire version (1), a byte of length, then one byte per fuse,
 * '0' off, '1' on, 'r' removed from this Electron. A macOS universal binary
 * holds one wire per architecture, so EVERY wire found is held to the rule.
 * On macOS the wire is in the framework the launcher loads, not the launcher.
 *
 * No dependency on purpose: the reader is a few lines, and what it checks is
 * the output of the library that would otherwise be asked to check itself.
 * Importing this module reads nothing (`import.meta.main`); the test in
 * `scripts/check-fuses.test.ts` drives the reader with made-up binaries.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'

/** The wire's fuses in order, by electron-builder's option names (`electronFuses` in package.ts). A fuse past the end is one a newer Electron added. */
export const FUSE_NAMES = [
  'runAsNode',
  'enableCookieEncryption',
  'enableNodeOptionsEnvironmentVariable',
  'enableNodeCliInspectArguments',
  'enableEmbeddedAsarIntegrityValidation',
  'onlyLoadAppFromAsar',
  'loadBrowserProcessSpecificV8Snapshot',
  'grantFileProtocolExtraPrivileges',
] as const

/**
 * The four that must be off, and why each is one: the first three turn the
 * app into a Node interpreter or attach a debugger to main (through an
 * environment variable or an argument, which any local process can set), and
 * the last gives a `file:` page reach the shell's own scheme was made to
 * avoid. `scripts/release-pins.test.ts` holds package.ts to this same list.
 */
export const FUSES_THAT_MUST_BE_OFF = ['runAsNode', 'enableNodeOptionsEnvironmentVariable', 'enableNodeCliInspectArguments', 'grantFileProtocolExtraPrivileges'] as const

const WIRE_VERSION = 1
const OFF = 0x30
const ON = 0x31
const REMOVED = 0x72

const stateName = (state: number): string => (state === OFF ? 'off' : state === ON ? 'ON' : state === REMOVED ? 'removed' : `the unknown state 0x${state.toString(16).padStart(2, '0')}`)

export interface FuseWire {
  /** Where the wire's first fuse sits in the file. */
  readonly offset: number
  /** One byte per fuse, in wire order. */
  readonly fuses: readonly number[]
}

/** Every fuse wire in a binary. Throws on a wire this reader does not know how to read, rather than guess at it. */
export function readFuseWires(binary: Buffer): FuseWire[] {
  const sentinel = Buffer.from(FUSE_SENTINEL, 'latin1')
  const wires: FuseWire[] = []
  for (let at = binary.indexOf(sentinel); at >= 0; at = binary.indexOf(sentinel, at + sentinel.length)) {
    const head = at + sentinel.length
    const version = binary[head]
    const length = binary[head + 1]
    if (version === undefined || length === undefined) throw new Error(`the file ends inside the fuse wire at byte ${at}`)
    if (version !== WIRE_VERSION) throw new Error(`the fuse wire at byte ${at} is version ${version}, and this reader knows version ${WIRE_VERSION}`)
    const fuses = [...binary.subarray(head + 2, head + 2 + length)]
    if (fuses.length !== length) throw new Error(`the fuse wire at byte ${at} says it has ${length} fuses, and the file ends after ${fuses.length}`)
    wires.push({ offset: head + 2, fuses })
  }
  return wires
}

/** One line per wire, every fuse named with its state: the record a CI log keeps. */
export function describeWires(wires: readonly FuseWire[]): string[] {
  return wires.map((wire, index) => `wire ${index + 1} of ${wires.length}: ${wire.fuses.map((state, fuse) => `${FUSE_NAMES[fuse] ?? `fuse${fuse}`}=${stateName(state)}`).join(' ')}`)
}

/** What is wrong with a binary's fuses, a sentence each; empty when every fuse that must be off is off in every wire. */
export function fuseProblems(binary: Buffer): string[] {
  let wires: FuseWire[]
  try {
    wires = readFuseWires(binary)
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)]
  }
  if (wires.length === 0) return ['no fuse wire: the sentinel is not in this file, so it is not an Electron binary whose fuses can be read']
  const problems: string[] = []
  for (const [index, wire] of wires.entries()) {
    for (const name of FUSES_THAT_MUST_BE_OFF) {
      const state = wire.fuses[FUSE_NAMES.indexOf(name)]
      // Anything but a plain "off" is refused, a removed fuse included: what
      // Electron does in its place is a question for a person, not a default.
      if (state === undefined) problems.push(`wire ${index + 1} has ${wire.fuses.length} fuses and no ${name}`)
      else if (state !== OFF) problems.push(`${name} is ${stateName(state)} in wire ${index + 1}, and must be off`)
    }
  }
  return problems
}

/** The file that holds the wire, given the executable a person launches. */
export function fuseFile(executable: string): string {
  const bundle = /^(.*\.app)[\\/]Contents[\\/]MacOS[\\/][^\\/]+$/.exec(executable)
  return bundle === null ? executable : join(bundle[1]!, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework')
}

if (import.meta.main) {
  const executable = process.argv[2]
  if (executable === undefined) {
    process.stderr.write('usage: check-fuses.ts <the packed app\'s executable>\n')
    process.exit(1)
  }
  const file = fuseFile(resolve(executable))
  const binary = readFileSync(file)
  const problems = fuseProblems(binary)
  if (problems.length > 0) {
    process.stderr.write(`desktop fuses: ${file}\n${problems.map((problem) => `  ${problem}`).join('\n')}\n`)
    process.exit(1)
  }
  process.stdout.write(`desktop fuses: ${file}\n${describeWires(readFuseWires(binary)).map((line) => `  ${line}`).join('\n')}\n  ${FUSES_THAT_MUST_BE_OFF.join(', ')}: off, as required\n`)
}
