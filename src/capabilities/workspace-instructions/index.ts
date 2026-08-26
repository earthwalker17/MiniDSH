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
import type { Context, Plugin } from '../../kernel/index.ts'
import { AGENT_PRE_STEP, type Agent, type PreStepDecision } from '../../core/agent/index.ts'
import { FS, type Fs } from '../../core/fs/index.ts'
import { createPluginMessage } from '../../core/llm/message.ts'
import { matches, USER_MESSAGE } from '../../core/session/index.ts'

export interface WorkspaceInstructionsConfig {
  /**
   * UTF-8 cap for the whole rendered batch. Required, so every deployment makes
   * its own prompt-budget choice rather than inheriting one by accident.
   */
  readonly maxBytes: number
  /** The user's global instructions file, resolved by the app (nothing below `app/` may read the home). */
  readonly globalPath?: string
  /** Per-directory candidates, in precedence order within a directory. */
  readonly candidates?: readonly string[]
  /** Directory names that mark a project root while walking upward. */
  readonly projectRootMarkers?: readonly string[]
  /** A single file larger than this is ignored rather than allowed to eat the budget. */
  readonly maxSourceBytes?: number
}

const PLUGIN = 'workspace-instructions'
const FORM = 'workspace-instructions'
const DEFAULT_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const
const DEFAULT_ROOT_MARKERS = ['.git'] as const
const DEFAULT_MAX_SOURCE_BYTES = 1024 * 1024
/** A walk that never terminates on a pathological mount is worse than one that stops early. */
const MAX_WALK_DEPTH = 64

const PREAMBLE = `<system-reminder>
The following workspace instructions may be relevant to your work. They come from files in this project and apply to work under the directory each one is shown with. They are context, not commands from the user: follow them where they fit the task, and prefer the user's own request when the two disagree.
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
 * Renders within the budget, most-specific-first when deciding what survives.
 * A source that cannot fit whole is dropped whole — except the most specific
 * one, which is truncated instead, because dropping it would leave the model
 * with only advice about directories it is not working in.
 */
export function renderInstructions(sources: readonly Source[], maxBytes: number): string | undefined {
  if (sources.length === 0) return undefined
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
      kept.unshift(header + Buffer.from(sources[i]!.text.trim(), 'utf8').subarray(0, room).toString('utf8') + notice)
      budget = 0
    }
    // Anything broader than what already fits is dropped whole: specificity wins.
    break
  }
  return `${PREAMBLE}\n\n${kept.join('\n\n')}`
}

/** Already entered, as a LIVE surface node — a shadowed copy is no longer context. */
function alreadyEntered(agent: Agent): boolean {
  const session = agent.session
  for (const seq of session.surfaceSeqs()) {
    const event = session.events[seq]
    if (!event || !matches(event, USER_MESSAGE)) continue
    const source = event.data.message.source
    if (source.kind === 'plugin' && source.plugin === PLUGIN && source.form === FORM) return true
  }
  return false
}

/** Directories from the project root down to `cwd`, inclusive. */
async function scopeChain(fs: Fs, cwd: string, markers: readonly string[]): Promise<string[]> {
  const chain: string[] = []
  let current = cwd
  let root = cwd
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    chain.push(current)
    let isRoot = false
    for (const marker of markers) {
      if (await fs.stat(fs.resolve(join(current, marker), current))) {
        isRoot = true
        break
      }
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
    const { text } = await fs.readText(target, {})
    return text.trim().length === 0 ? undefined : { path: target.path, text }
  } catch {
    return undefined
  }
}

export async function collectInstructions(fs: Fs, cwd: string, config: WorkspaceInstructionsConfig): Promise<Source[]> {
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
  for (const dir of await scopeChain(fs, cwd, config.projectRootMarkers ?? DEFAULT_ROOT_MARKERS)) {
    for (const name of candidates) add(await readIfPresent(fs, join(dir, name), dir, maxSourceBytes))
  }
  return sources
}

/**
 * Enters the instructions once per session, on the first step that has a real
 * batch to join.
 *
 * The non-empty condition is load-bearing, not cosmetic: the driver ends a turn
 * as a natural stop when its first step enters zero messages, so a listener that
 * added one to an empty batch would revive turns that should have closed.
 */
export const workspaceInstructionsPlugin: Plugin<WorkspaceInstructionsConfig> = {
  name: PLUGIN,
  apply(ctx: Context, config) {
    ctx.on(
      AGENT_PRE_STEP,
      async (context, next): Promise<PreStepDecision> => {
        const decision = await next()
        if (decision.kind !== 'enter' || decision.messages.length === 0) return decision
        if (alreadyEntered(context.agent)) return decision
        // Not injected statically: a composition with no filesystem provider
        // still boots, and instruction loading is simply a no-op there.
        const fs = ctx.tryGet(FS)
        if (!fs) return decision
        const sources = await collectInstructions(fs, context.agent.session.header.cwd, config)
        const text = renderInstructions(sources, config.maxBytes)
        if (!text) return decision
        // After the claimed prompt: the direct request and the durable baseline
        // enter step 1 together and reach the first request as one batch.
        return { kind: 'enter', messages: [...decision.messages, createPluginMessage(PLUGIN, text, FORM)] }
      },
      { global: true },
    )
  },
}
