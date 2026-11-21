/**
 * Skills as data: `SKILL.md` directories under configured roots, listed to the
 * model as OPTIONAL context and read with the tools it already has.
 *
 * The runtime knows no particular skill, adds no tool, no event kind, no
 * service and no authority. A skill enters the conversation as one durable
 * plugin `user/message` (`plugin: 'skills'`, `form: 'list'`) — the same class
 * of record as AGENTS.md, so "model-visible ⟺ logged" holds without a new
 * kind — and USING one is an ordinary `tool/call` that reads a listed path.
 * A skill's script is an ordinary shell command under the session's sandbox,
 * acceptance and consent; nothing here can grant it more.
 *
 * **Re-read on every prompt, appended only on a change.** On each non-empty
 * `agent/pre-step` batch the roots are scanned and rendered, and the render is
 * compared with the newest LIVE list message; a replacement is appended only
 * when they differ. So a resumed or forked session with the same skills
 * appends nothing, an edited description appends exactly one replacement, a
 * compaction that shadowed the list re-enters it (the fold reads the live
 * surface, as `workspace-instructions` does and for the same reason), and the
 * last skill's removal appends ONE retirement line that is then itself the
 * newest list. This is DSH's own re-check, without DSH's `skill` tool.
 * An EMPTY batch is filled in one case only: a step after a turn's first,
 * whose compaction just shadowed the list. A tool loop's steps all have empty
 * batches, so without that the list stayed gone for the rest of the turn.
 *
 * **Deployment-global, one instance per root.** Two instances would each find
 * the other's list newest and append on every prompt, so a second instance on
 * the same root is refused, and so is a scoped (agent-preset) mount, whose
 * list would race the root's. Registered WITHOUT `global: true`: an unscoped
 * listener already hears every agent's dispatch, delegated children included,
 * and a child is a session that may use a skill like any other.
 */
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { Context, Plugin } from '../../kernel/index.ts'
import { AGENT_PRE_STEP, type Agent, type PreStepDecision } from '../../core/agent/index.ts'
import { FS } from '../../core/fs/index.ts'
import { createPluginMessage, messageText } from '../../core/llm/message.ts'
import type { MessageSource } from '../../core/llm/types.ts'
import { matches, USER_MESSAGE } from '../../core/session/index.ts'
import { printableText } from '../../core/text.ts'
import { discoverSkills, type SkillRoot } from './discover.ts'
import { renderSkillList, RETIREMENT } from './render.ts'

export { discoverSkills, DEFAULT_WORKSPACE_DIRS, DEFAULT_MAX_SKILL_BYTES, MAX_ENTRIES_PER_ROOT } from './discover.ts'
export type { DiscoveryConfig, ScannedRoot, SkillDiscovery, SkillEntry, SkillOrigin, SkillRoot, SkippedSkill } from './discover.ts'
export { fitSkillList, oneLine, renderSkillList, RETIREMENT, SKILL_LIST_PREAMBLE } from './render.ts'
export { isSkillName, parseSkillFile } from './frontmatter.ts'

export interface SkillsConfig {
  /**
   * UTF-8 cap for the whole rendered list. Required, so every deployment makes
   * its own prompt-budget choice rather than inheriting one by accident.
   */
  readonly maxBytes: number
  /**
   * `user` and `bundled` roots. OMITTED means the deployment's own — the app
   * fills them after layering — and `[]` means none: a patch that only meant
   * to set `exclude` replaces the whole row config, and must not silently
   * drop every root with it.
   */
  readonly roots?: readonly SkillRoot[] | undefined
  /** Searched in each directory from the cwd up to the project root (default `.agents/skills`, `.claude/skills`). */
  readonly workspaceDirs?: readonly string[] | undefined
  /** Directory names that mark a project root while walking upward (default `.git`). */
  readonly projectRootMarkers?: readonly string[] | undefined
  /** Skill names never listed, whichever root holds them. */
  readonly exclude?: readonly string[] | undefined
  /** A `SKILL.md` larger than this is skipped rather than read (default 256 KiB). */
  readonly maxSkillBytes?: number | undefined
}

/**
 * Roots are ABSOLUTE. A relative one would resolve against the session's cwd,
 * so a repository directory would be read under the `user` or `bundled` label
 * and could replace a skill the operator installed — exactly what a workspace
 * root is never allowed to do.
 */
const configSchema = z.strictObject({
  maxBytes: z.number().positive(),
  roots: z
    .array(
      z.strictObject({
        path: z.string().min(1).refine(isAbsolute, 'a skill root must be an absolute path'),
        origin: z.enum(['user', 'bundled']),
      }),
    )
    .optional(),
  workspaceDirs: z.array(z.string().min(1)).optional(),
  projectRootMarkers: z.array(z.string().min(1)).optional(),
  exclude: z.array(z.string().min(1)).optional(),
  maxSkillBytes: z.number().int().positive().optional(),
})

const PLUGIN = 'skills'
const FORM = 'list'

/** Roots that already carry an instance, keyed by the kernel's root state; an entry dies with its instance. */
const mountedRoots = new WeakSet<object>()

/**
 * The text of the newest list message on the LIVE surface, or `undefined`.
 *
 * Live, not logged: shadowed events stay in the log forever, so a fold over
 * the log would keep "seeing" a list a compaction already removed from the
 * model's view, and the skills would silently stop being offered exactly when
 * a session got long. A retirement line is a list too, so it is found here.
 */
function newestList(agent: Agent): string | undefined {
  const session = agent.session
  let newest: string | undefined
  for (const seq of session.surfaceSeqs()) {
    const event = session.events[seq]
    if (event && matches(event, USER_MESSAGE) && isList(event.data.message)) newest = messageText(event.data.message)
  }
  return newest
}

function isList(message: { readonly source: MessageSource }): boolean {
  const source = message.source
  return source.kind === 'plugin' && source.plugin === PLUGIN && source.form === FORM
}

/**
 * A list entered at some point in this session's log, live or not. With no
 * list on the live surface it says why: one entered and gone was shadowed by a
 * compaction, since nothing else takes a node off the surface.
 */
function everListed(agent: Agent): boolean {
  return agent.session.facts.some((event) => matches(event, USER_MESSAGE) && isList(event.data.message))
}

export const skillsPlugin: Plugin<SkillsConfig> = {
  name: PLUGIN,
  config: configSchema,
  apply(ctx: Context, config) {
    if (ctx.scope !== undefined) {
      throw new Error('skills: the skill list is deployment-global and cannot be mounted on a scoped context (an agent preset); mount it once at the root')
    }
    const root = ctx.root
    if (mountedRoots.has(root)) {
      throw new Error('skills: this root already mounts a skills instance; two would each read the other\'s list as stale and append one on every prompt')
    }
    ctx.effect(() => {
      mountedRoots.add(root)
      return () => void mountedRoots.delete(root)
    }, 'skills: one instance per root')

    // Operator diagnostics, once per instance: a skipped path is the
    // operator's business (a shadowed repo skill, a broken front-matter), never
    // the model's — the model is not told what it was not offered. Both halves
    // are text a repository wrote (a path, a quoted front-matter line), bound
    // for the operator's terminal: neutralized as `core/text.ts` says.
    const warned = new Set<string>()
    const warn = (skipped: readonly { path: string; reason: string }[]): void => {
      for (const { path, reason } of skipped) {
        const key = `${path}\0${reason}`
        if (warned.has(key)) continue
        warned.add(key)
        ctx.logger.warn(`skills: ${printableText(path)} is not listed: ${printableText(reason)}`)
      }
    }

    ctx.on(AGENT_PRE_STEP, async (context, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      if (decision.messages.length === 0) {
        // The FIRST step's empty batch is never filled: the driver ends a turn
        // as a natural stop when its first step enters nothing, and a list
        // added there would revive a turn that should have closed.
        if (context.step === 1) return decision
        // A later step's empty batch is every step of a tool loop; that step
        // runs whatever enters, so adding to it revives nothing. The roots are
        // still not scanned at every step: only a list a compaction just
        // shadowed comes back here, so the model keeps it for the rest of the
        // turn. A changed skill is found with the next prompt, as before.
        if (newestList(context.agent) !== undefined || !everListed(context.agent)) return decision
      }
      // A composition with no filesystem provider still boots; the list is then simply absent.
      const fs = ctx.tryGet(FS)
      if (!fs) return decision
      try {
        const found = await discoverSkills(fs, context.agent.session.header.cwd, config)
        warn(found.skipped)
        // What the model already sees stands until a scan can say for certain
        // what is there; an EACCES is not "every skill was removed".
        if (!found.complete) return decision
        const newest = newestList(context.agent)
        // Retire only when nothing is installed: a budget too small for even
        // the preamble is a deployment's misconfiguration, not "no skills".
        const desired = found.listed.length > 0 ? renderSkillList(found.listed, config.maxBytes) : newest !== undefined ? RETIREMENT : undefined
        if (desired === undefined || desired === newest) return decision
        // LAST in the batch: this row is the outermost pre-step layer, so the
        // batch reads [prompt, AGENTS.md, skill list] and a list that changed
        // mid-session follows the prompt that found the change. On a tool-loop
        // step there is no prompt, and the order is the same without it.
        return { kind: 'enter', messages: [...decision.messages, createPluginMessage(PLUGIN, desired, FORM)] }
      } catch {
        /**
         * Discovery degrades to "no change"; it must never fail the turn.
         * `fs.resolve` throws BY DESIGN on a path whose identity the host will
         * not disclose, and a throw out of `agent/pre-step` reaches the driver
         * AFTER the claim was committed — the prompt would be durably consumed
         * and never entered, and since the cause is a property of the roots,
         * every later prompt would die the same way.
         */
        return decision
      }
    })
  },
}
