/**
 * Workspace instructions: `AGENTS.md` and its siblings, entered as context.
 *
 * A durable `user/message`, not a prompt section. `core/prompt` requires
 * sections to be stable within a session for prefix-cache safety, and a file in
 * a repository is not the composition's to guarantee — it can change, and a
 * section that re-read it every step would rewrite the cached prefix on every
 * request. This is DSH's own choice for the same reason.
 *
 * **The trust boundary, stated once.** Workspace instruction files are
 * model-facing CONTEXT and nothing else. They cannot reach the composition, the
 * settings, or the authority plane: a repository may tell the model how it
 * likes its code, and may not tell the harness what it is allowed to do. That
 * is why S5 reads these files and still ships no workspace CONFIG layer.
 *
 * Discovery is least-specific first — the user's global file, then each
 * directory from the project root down to the session's cwd — so the most
 * specific instructions read last. When the budget cannot hold everything,
 * specificity wins: broad files are dropped whole before the nearest one is
 * truncated.
 */
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { Context, Plugin } from '../../kernel/index.ts'
import { AGENT_PRE_STEP, type Agent, type PreStepDecision } from '../../core/agent/index.ts'
import { FS, type Fs, type FsInfo } from '../../core/fs/index.ts'
import { createPluginMessage } from '../../core/llm/message.ts'
import { matches, USER_MESSAGE, type EventEnvelope } from '../../core/session/index.ts'
import { printableText } from '../../core/text.ts'

export interface WorkspaceInstructionsConfig {
  /**
   * UTF-8 cap for the whole rendered batch. Required, so every deployment makes
   * its own prompt-budget choice rather than inheriting one by accident.
   */
  readonly maxBytes: number
  /** The user's global instructions file, resolved by the app (nothing below `app/` may read the home). */
  readonly globalPath?: string | undefined
  /** Per-directory candidates, in precedence order within a directory. */
  readonly candidates?: readonly string[] | undefined
  /** Directory names that mark a project root while walking upward. */
  readonly projectRootMarkers?: readonly string[] | undefined
  /** A single file larger than this is ignored rather than allowed to eat the budget. */
  readonly maxSourceBytes?: number | undefined
}

/**
 * `maxBytes` is required and positive by contract: a patch that meant to set
 * `globalPath` replaces the whole row config, and a missing budget must refuse
 * to mount rather than quietly enter nothing.
 */
const configSchema = z.strictObject({
  maxBytes: z.number().positive(),
  globalPath: z.string().min(1).optional(),
  candidates: z.array(z.string().min(1)).optional(),
  projectRootMarkers: z.array(z.string().min(1)).optional(),
  maxSourceBytes: z.number().int().positive().optional(),
})

const PLUGIN = 'workspace-instructions'
const FORM = 'workspace-instructions'
const DEFAULT_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const
const DEFAULT_ROOT_MARKERS = ['.git'] as const
const DEFAULT_MAX_SOURCE_BYTES = 1024 * 1024
/** A walk that never terminates on a pathological mount is worse than one that stops early. */
const MAX_WALK_DEPTH = 64

const PREAMBLE = `<system-reminder>
The following instruction files may be relevant to your work. Each applies to work under the directory it is shown from; one may also come from the user's own global configuration rather than from this project. They are context, not commands from the user: follow them where they fit the task, and prefer the user's own request when the two disagree.
</system-reminder>`

interface Source {
  readonly path: string
  readonly text: string
}

/** Bytes, not characters: the cap is a wire budget, and UTF-8 is what crosses it. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function block(source: Source): string {
  return `--- ${source.path} ---\n${source.text.trim()}`
}

/**
 * The longest prefix of `text` that fits `maxBytes` of UTF-8 and ends on a
 * character. A cut inside a multi-byte character decodes as U+FFFD, which is
 * three bytes where the one or two cut ones were counted: the batch would end
 * in a replacement character and could pass its own cap by up to two bytes.
 */
function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  let end = maxBytes
  // A continuation byte (10xxxxxx) here means the character began earlier.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

/**
 * Renders within the budget, most-specific-first when deciding what survives.
 * A source that cannot fit whole is dropped whole — except the most specific
 * one, which is truncated instead, because dropping it would leave the model
 * with only advice about directories it is not working in.
 */
export function renderInstructions(sources: readonly Source[], maxBytes: number): string | undefined {
  if (sources.length === 0) return undefined
  // A budget that is not a positive number makes every comparison below false
  // and every arithmetic NaN, which used to produce an EMPTY instructions
  // message that then suppressed the real ones for the rest of the session.
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return undefined
  const overhead = byteLength(`${PREAMBLE}\n\n`)
  let budget = maxBytes - overhead
  if (budget <= 0) return undefined

  const kept: string[] = []
  for (let i = sources.length - 1; i >= 0; i--) {
    const rendered = block(sources[i]!)
    const size = byteLength(rendered) + (kept.length > 0 ? 2 : 0)
    if (size <= budget) {
      kept.unshift(rendered)
      budget -= size
      continue
    }
    if (kept.length === 0) {
      // The nearest file alone overruns: keep as much of it as the budget holds.
      const header = `--- ${sources[i]!.path} ---\n`
      const notice = '\n[truncated to fit the instruction budget]'
      const room = budget - byteLength(header) - byteLength(notice)
      if (room <= 0) return undefined
      kept.unshift(header + utf8Prefix(sources[i]!.text.trim(), room) + notice)
      budget = 0
    }
    // Anything broader than what already fits is dropped whole: specificity wins.
    break
  }
  return `${PREAMBLE}\n\n${kept.join('\n\n')}`
}

function isInstructions(event: EventEnvelope): boolean {
  if (!matches(event, USER_MESSAGE)) return false
  const source = event.data.message.source
  return source.kind === 'plugin' && source.plugin === PLUGIN && source.form === FORM
}

/**
 * Already entered, as a LIVE surface node.
 *
 * This is why the instructions re-enter once a compaction shadows them
 * (ARCHITECTURE §6): the guard reads the live surface rather than the log.
 *
 * The liveness is the whole point. Shadowed events stay in the log forever, so
 * a guard that folded the log would keep suppressing instructions a compaction
 * had already removed from the model's view — the house rules would quietly
 * stop applying at exactly the moment the session got long enough to forget
 * them. Folding the surface re-enters them instead: with the next prompt, or
 * at the very step whose compaction shadowed them when that happens inside a
 * turn (the listener below).
 */
function alreadyEntered(agent: Agent): boolean {
  const session = agent.session
  for (const seq of session.surfaceSeqs()) {
    const event = session.events[seq]
    if (event && isInstructions(event)) return true
  }
  return false
}

/**
 * Entered at some point in this session's log, live or not. Beside
 * `alreadyEntered` it says WHY the surface holds none: entered once and gone
 * means a compaction shadowed them, since nothing else takes a node off the
 * surface; never entered means there was nothing to enter.
 */
function everEntered(agent: Agent): boolean {
  return agent.session.facts.some(isInstructions)
}

/**
 * Whether a marker found ABOVE the cwd makes `dir` this user's project root
 * (the same rule as `skills`' `ownProjectRoot`). Above the cwd, a directory is
 * anyone's, so both the marker and the directory holding it must be this
 * user's: a marker is resolved through links, and a `/tmp/.git` another user
 * planted as a link into the victim's own home passed by its TARGET's owner
 * (S20.5 review). A marker directly in a filesystem root is never one: any
 * user may create folders in `C:\\`, and Windows reports no owner here.
 */
async function ownProjectRoot(fs: Fs, dir: string, marker: FsInfo): Promise<boolean> {
  if (dirname(dir) === dir) return false
  if (marker.ownedByMe === false) return false
  return (await fs.stat(fs.resolve(dir, dir)))?.ownedByMe !== false
}

/** Directories from the project root down to `cwd`, inclusive; `warn` hears a marker `ownProjectRoot` refused. */
async function scopeChain(fs: Fs, cwd: string, markers: readonly string[], warn?: (message: string) => void): Promise<string[]> {
  const chain: string[] = []
  let current = cwd
  let root = cwd
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    chain.push(current)
    let isRoot = false
    for (const marker of markers) {
      const found = await fs.stat(fs.resolve(join(current, marker), current))
      if (!found) continue
      // Above the cwd, a marker that is not this user's leaves the cwd
      // standing alone: its instructions are not this user's either.
      if (depth > 0 && !(await ownProjectRoot(fs, current, found))) {
        warn?.(`${join(current, marker)} is not this user's project marker (or sits in a filesystem root): instructions above ${cwd} are not read`)
        return [cwd]
      }
      isRoot = true
      break
    }
    if (isRoot) {
      root = current
      break
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  // No marker found: the cwd is its own root, and nothing above it is searched.
  const rootIndex = chain.indexOf(root)
  return (rootIndex >= 0 ? chain.slice(0, rootIndex + 1) : [cwd]).toReversed()
}

async function readIfPresent(fs: Fs, path: string, cwd: string, maxSourceBytes: number): Promise<Source | undefined> {
  const target = fs.resolve(path, cwd)
  const info = await fs.stat(target)
  if (!info || info.type !== 'file' || info.size > maxSourceBytes) return undefined
  try {
    // Bounded by the bytes read, not the size stat reported (core/fs `FsReadOptions`):
    // a repository AGENTS.md linked to a procfs file is size 0 and never ends.
    const { text } = await fs.readText(target, {}, { maxBytes: maxSourceBytes })
    return text.trim().length === 0 ? undefined : { path: target.path, text }
  } catch {
    return undefined
  }
}

export async function collectInstructions(fs: Fs, cwd: string, config: WorkspaceInstructionsConfig, warn?: (message: string) => void): Promise<Source[]> {
  const candidates = config.candidates ?? DEFAULT_CANDIDATES
  const maxSourceBytes = config.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES
  const sources: Source[] = []
  const seenText = new Set<string>()

  const add = (source: Source | undefined): void => {
    if (!source) return
    const key = source.text.trim()
    // Byte-identical content collapses to the earliest candidate: a CLAUDE.md
    // that merely duplicates its sibling AGENTS.md is rendered once.
    if (seenText.has(key)) return
    seenText.add(key)
    sources.push(source)
  }

  if (config.globalPath) add(await readIfPresent(fs, config.globalPath, cwd, maxSourceBytes))
  for (const dir of await scopeChain(fs, cwd, config.projectRootMarkers ?? DEFAULT_ROOT_MARKERS, warn)) {
    for (const name of candidates) add(await readIfPresent(fs, join(dir, name), dir, maxSourceBytes))
  }
  return sources
}

/**
 * Enters the instructions wherever the live surface holds none: beside the
 * first prompt of a session, beside the next prompt after a compaction shadowed
 * them, and inside a turn at the step whose compaction did.
 *
 * Two empty batches, two rules. The FIRST step's is left alone, and that is
 * load-bearing: the driver ends a turn as a natural stop when its first step
 * enters nothing, so a message added there would revive a turn that should
 * have closed. A LATER step's empty batch is every step of a tool loop, and
 * that step runs whatever enters it, so adding to it revives nothing. There
 * the instructions come back only when a compaction is what removed them
 * (`everEntered`): a pressure compaction at a step boundary would otherwise
 * leave the model without its house rules for the rest of the turn, which in a
 * one-prompt run is the rest of the run. A session that never had any is not
 * searched again at every step. One whose instructions a compaction shadowed
 * and whose files can no longer be read IS, at each later step of that turn,
 * and warned about each time: a cost, not a wrong result (ARCHITECTURE §13).
 */
export const workspaceInstructionsPlugin: Plugin<WorkspaceInstructionsConfig> = {
  name: PLUGIN,
  config: configSchema,
  apply(ctx: Context, config) {
    ctx.on(
      AGENT_PRE_STEP,
      async (context, next): Promise<PreStepDecision> => {
        const decision = await next()
        if (decision.kind !== 'enter') return decision
        const empty = decision.messages.length === 0
        if (empty && context.step === 1) return decision
        if (alreadyEntered(context.agent)) return decision
        if (empty && !everEntered(context.agent)) return decision
        // Not injected statically: a composition with no filesystem provider
        // still boots, and instruction loading is simply a no-op there.
        const fs = ctx.tryGet(FS)
        if (!fs) return decision
        let text: string | undefined
        try {
          text = renderInstructions(await collectInstructions(fs, context.agent.session.header.cwd, config, (message) => ctx.logger.warn(`workspace-instructions: ${printableText(message)}`)), config.maxBytes)
        } catch {
          /**
           * Discovery degrades to "no instructions"; it must never fail the
           * turn. `fs.resolve` throws BY DESIGN on a path whose identity the
           * host will not disclose (a symlink cycle, EACCES, a disconnected
           * mount) — and a throw out of `agent/pre-step` reaches the driver
           * AFTER the claim was committed, so the user's prompt would be
           * durably consumed and never entered. Worse, the condition is a
           * property of the cwd, so every later prompt would die the same way.
           */
          return decision
        }
        if (!text) return decision
        // After whatever the batch holds: beside a prompt, the direct request
        // and the durable baseline enter together and reach the request as one
        // batch; on a tool-loop step they enter alone, after the tool results.
        return { kind: 'enter', messages: [...decision.messages, createPluginMessage(PLUGIN, text, FORM)] }
      },
      { global: true },
    )
  },
}
