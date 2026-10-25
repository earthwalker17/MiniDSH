/**
 * A from-disk plugin fixture, beside `greet-plugin.ts` and loaded the same way:
 * one tool whose body does not return until a release file exists. The live
 * arc kills its host while this body is held, so the kill lands INSIDE a
 * dispatched call on every run — a `tool/dispatch` on the record and no
 * result — instead of whenever a 50 ms poll happened to catch a call that
 * usually finished first.
 */
import { existsSync } from 'node:fs'
import { z } from 'zod'
import type { Plugin } from '../../kernel/index.ts'
import { defineTool, TOOLS } from '../../core/tools/index.ts'

export interface HoldConfig {
  /** The file whose existence releases every held call (absolute). */
  readonly releaseFile: string
}

const configSchema = z.strictObject({ releaseFile: z.string().min(1) })

const holdPlugin: Plugin<HoldConfig> = {
  name: 'tool-hold',
  inject: [TOOLS],
  config: configSchema,
  apply(ctx, config) {
    ctx.get(TOOLS).register(
      ctx,
      defineTool({
        name: 'hold',
        description: 'Waits until the operator releases it, then returns "released". Always call it when asked to hold.',
        input: z.object({}),
        output: z.string(),
        render: (_args, value) => [{ type: 'text', text: value }],
        execute: (_args, exec) =>
          new Promise<string>((resolve, reject) => {
            const poll = setInterval(() => {
              if (!existsSync(config.releaseFile)) return
              clearInterval(poll)
              resolve('released')
            }, 50)
            exec.signal.addEventListener('abort', () => {
              clearInterval(poll)
              reject(new Error('hold was cancelled'))
            })
          }),
      }),
    )
  },
}

export default holdPlugin
