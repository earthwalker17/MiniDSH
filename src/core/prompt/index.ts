/**
 * System-prompt assembly: an ordered named-section registry plus strict
 * `{{var}}` interpolation and the model tool schemas. Sections must be stable
 * within a session (prefix-cache safety); time-varying context goes through
 * `agent/pre-step` as a durable message, not a section. Sections and
 * variables are per-agent layered (`core/scope.ts`): a section registered
 * through an agent's context is visible to that agent alone and may shadow a
 * same-named global (a subagent persona); `system-prompt/assemble` is
 * dispatched in the agent's scope.
 */
import { serviceKey, waterfallEvent, type Context, type Disposer, type Plugin } from '../../kernel/index.ts'
import type { Agent } from '../agent/types.ts'
import { ScopedLayers } from '../scope.ts'
import { TOOLS, type Tools } from '../tools/index.ts'
import type { ToolSchema } from '../llm/types.ts'

export interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((agent: Agent | undefined) => string)
  /** When set, this section IS the entire system prompt (assembled after the waterfall). */
  readonly complete?: boolean
}

export interface AssembledPrompt {
  readonly system: string
  readonly tools: ToolSchema[]
}

/** A mutable draft listeners may add sections to before rendering. */
export interface PromptDraft {
  readonly agent: Agent | undefined
  readonly sections: PromptSection[]
}

export interface Prompt {
  section(owner: Context, section: PromptSection): Disposer
  variable(owner: Context, name: string, provider: () => string | undefined): Disposer
  assemble(agent?: Agent): Promise<AssembledPrompt>
}

export const PROMPT = serviceKey<Prompt>('prompt')
export const SYSTEM_PROMPT_ASSEMBLE = waterfallEvent<[draft: PromptDraft], Promise<PromptDraft>>('system-prompt/assemble')

const VARIABLE = /\{\{([a-z][a-z0-9_]*)\}\}/g

class PromptRegistry implements Prompt {
  private readonly sections = new ScopedLayers<PromptSection>()
  private readonly variables = new ScopedLayers<() => string | undefined>()
  private readonly ctx: Context
  constructor(ctx: Context) {
    this.ctx = ctx
  }

  section(owner: Context, section: PromptSection): Disposer {
    const layer = this.sections.layerFor(owner)
    if (layer.has(section.name)) throw new Error(`prompt section "${section.name}" is already registered in this scope`)
    layer.set(section.name, section)
    return owner.effect(() => () => {
      if (layer.get(section.name) === section) layer.delete(section.name)
    }, `prompt.section("${section.name}")`)
  }

  variable(owner: Context, name: string, provider: () => string | undefined): Disposer {
    const layer = this.variables.layerFor(owner)
    if (layer.has(name)) throw new Error(`prompt variable "${name}" is already registered in this scope`)
    layer.set(name, provider)
    return owner.effect(() => () => {
      if (layer.get(name) === provider) layer.delete(name)
    }, `prompt.variable("${name}")`)
  }

  async assemble(agent?: Agent): Promise<AssembledPrompt> {
    const draft: PromptDraft = { agent, sections: [...this.sections.view(agent).values()] }
    const finalDraft = await (agent?.ctx ?? this.ctx).waterfall(SYSTEM_PROMPT_ASSEMBLE, draft, async () => draft)
    const ordered = finalDraft.sections.toSorted((a, b) => a.order - b.order)
    const complete = ordered.filter((section) => section.complete)
    if (complete.length > 1) throw new Error(`multiple complete prompt sections: ${complete.map((s) => s.name).join(', ')}`)

    const render = (section: PromptSection): string =>
      this.interpolate(typeof section.text === 'function' ? section.text(agent) : section.text, agent)
    const system = complete.length === 1 ? render(complete[0]!) : ordered.map(render).filter((text) => text.length > 0).join('\n\n')

    const tools = this.ctx.tryGet(TOOLS)?.schemas(agent) ?? []
    return { system, tools }
  }

  private interpolate(text: string, agent: Agent | undefined): string {
    return text.replace(VARIABLE, (_match, name: string) => {
      const provider = this.variables.get(name, agent)
      if (!provider) throw new Error(`unknown prompt variable "${name}"`)
      const value = provider()
      if (value === undefined) throw new Error(`prompt variable "${name}" resolved to undefined`)
      return value
    })
  }
}

/** Provides `ctx.prompt`. */
export const promptPlugin: Plugin = {
  name: 'core-prompt',
  apply(ctx) {
    ctx.provide(PROMPT, new PromptRegistry(ctx))
  },
}

export type { Tools }
