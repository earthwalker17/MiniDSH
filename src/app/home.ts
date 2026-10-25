import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalPath } from '../core/sandbox/paths.ts'
import type { SkillRoot } from '../capabilities/skills/index.ts'

/**
 * MiniDSH home: `$MINIDSH_HOME` or `~/.minidsh`. Holds all durable user data.
 *
 * Absolute, always, against the directory the process started in: every path
 * below is handed to plugins as config, and a relative one was resolved by
 * each reader against its OWN base — spill against the process, the global
 * `AGENTS.md` against the SESSION's cwd, so a repository could supply the
 * user's "global" instructions (S20.5 review). S19 resolved only the skill
 * roots; this resolves the home once, for everything derived from it.
 */
export function resolveHome(): string {
  const configured = process.env.MINIDSH_HOME
  return resolve(configured && configured.length > 0 ? configured : join(homedir(), '.minidsh'))
}

export function sessionsDir(): string {
  return join(resolveHome(), 'sessions')
}

/**
 * Oversized tool output, saved per session. Beside the logs rather than in the
 * OS temp directory: a durable `tool/result` naming a path is a lie once a
 * reboot deletes it.
 */
export function spillDir(): string {
  return join(resolveHome(), 'spill')
}

/**
 * Content-addressed image objects. Under the durable home, like the logs that
 * reference them and unlike a temp directory: an attachment is CONTENT — a log
 * names it as something the model saw — so nothing may sweep it, and it must
 * still resolve after a reboot.
 */
export function attachmentsDir(): string {
  return join(resolveHome(), 'attachments')
}

/**
 * Where `tool-browser` makes each launch's private profile. An AFFORDANCE,
 * not content: a profile lives for one browser and is removed when it closes;
 * one a killed host left behind is swept by the next launch on this host once
 * its owner is provably dead (`tool-browser/launch.ts`). Per user, under the
 * home, rather than a shared `/tmp` another user's harness could hold.
 * Absolute, because the browser is handed the path and has its own idea of a
 * working directory.
 */
export function browserProfilesDir(): string {
  return resolve(resolveHome(), 'browser')
}

/** Declarative composition layer: patch rows + named agent presets. */
export function compositionPath(): string {
  return join(resolveHome(), 'composition.json')
}

/**
 * The user's global instruction file. Model-facing CONTEXT only — it can no
 * more change this harness's authority than a repository's AGENTS.md can.
 */
export function globalInstructionsPath(): string {
  return join(resolveHome(), 'AGENTS.md')
}

/** User settings layer (agent defaults). Never authority, never composition. */
export function settingsPath(): string {
  return join(resolveHome(), 'settings.json')
}

/** Named secrets store: `{ "NAME": "value" }`. Only the names ever leave this file. */
export function credentialsPath(): string {
  return join(resolveHome(), 'credentials.json')
}

/**
 * The deployment's skill roots: the user's own under the home, then the
 * package's bundled `skills/`. The workspace's `.agents/skills` and
 * `.claude/skills` are not here — the capability derives those from each
 * session's cwd — and neither are other tools' home folders, which a person
 * adds through the `skills` row's `roots` when they want them.
 *
 * The bundled path is relative to THIS module, and `../../skills` names the
 * package root's `skills/` from `src/app` and from the emitted `dist/app`
 * alike, so a checkout and an installed tarball find the same directory.
 *
 * A root the app passes on and a capability never derives: nothing below
 * `app/` may resolve the home for itself.
 *
 * Both are ABSOLUTE and CANONICAL. `MINIDSH_HOME=../home` is a relative home,
 * and the row refuses a relative root, so `join` alone failed every boot (the
 * review caught it on the CI tarball step's own command line). And the roots
 * are in the composition a session records: spelled as launched, the same
 * install hashed differently under another path casing and re-recorded a
 * composition that had not changed.
 */
export function skillRootsFor(home: string): SkillRoot[] {
  return [
    { path: canonical(resolve(home, 'skills')), origin: 'user' },
    { path: canonical(fileURLToPath(new URL('../../skills', import.meta.url))), origin: 'bundled' },
  ]
}

/** The host's own spelling where it will give one; a path it will not resolve keeps the absolute spelling. */
function canonical(path: string): string {
  try {
    return canonicalPath(path)
  } catch {
    return path
  }
}

/** The whole layout as the boot options that carry it — one value, resolved once per command. */
export interface HomeLayout {
  readonly sessionsRoot: string
  readonly spillRoot: string
  readonly attachmentsRoot: string
  readonly browserProfileRoot: string
  readonly globalInstructionsPath: string
  readonly credentialsPath: string
  /**
   * The same file `settingsPath()` names, carried down as plugin config because
   * the settings store now WRITES it at runtime. The boot-time read stays in
   * the app; nothing below `app` may resolve the home for itself.
   */
  readonly settingsStorePath: string
  /** Filled into a `skills` row that names no roots of its own, after layering (`app/config.ts` `withSkillRoots`). */
  readonly skillRoots: readonly SkillRoot[]
}

export function homeLayout(): HomeLayout {
  return {
    sessionsRoot: sessionsDir(),
    spillRoot: spillDir(),
    attachmentsRoot: attachmentsDir(),
    browserProfileRoot: browserProfilesDir(),
    globalInstructionsPath: globalInstructionsPath(),
    credentialsPath: credentialsPath(),
    settingsStorePath: settingsPath(),
    skillRoots: skillRootsFor(resolveHome()),
  }
}
