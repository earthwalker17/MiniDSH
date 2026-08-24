/**
 * A from-disk plugin fixture: what a user drops beside their composition.json
 * and references by absolute path. It lives inside the repo so its imports
 * (zod, the core seams) resolve from where the file sits — the documented
 * constraint for plugin authors. One deterministic tool, so a live arc can
 * prove a module-loaded capability really executes in the runtime.
 */
import { z } from 'zod'
import type { Plugin } from '../../kernel/index.ts'
import { defineTool, TOOLS } from '../../core/tools/index.ts'

const greet = defineTool({
  name: 'greet',
  description: 'Returns the canonical MiniDSH greeting for a name. Always use this tool when asked to greet.',
  input: z.object({ name: z.string() }),
  output: z.string(),
  render: (_args, value) => [{ type: 'text', text: value }],
  execute: ({ name }) => `greeting:${name.toUpperCase()}-${name.length}`,
})

const greetPlugin: Plugin = {
  name: 'tool-greet',
  inject: [TOOLS],
  apply(ctx) {
    ctx.get(TOOLS).register(ctx, greet)
  },
}

export default greetPlugin
