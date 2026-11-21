/**
 * A from-disk plugin fixture, beside `hold-plugin.ts` and loaded the same way:
 * a host that does each thing a test client must not swallow. The clients in
 * `serve-process.ts` and `web-process.ts` fail the test that met one, and a
 * check like that is only known to work once something has tripped it — so
 * each switch here is one real way a spawned host goes wrong, done by the
 * real host process, for the client's own tests to meet.
 */
import { z } from 'zod'
import type { Plugin } from '../../kernel/index.ts'
import { APPROVAL } from '../../core/approval/index.ts'
import { TOOLS_EXECUTE } from '../../core/tools/index.ts'

export interface MisbehaveConfig {
  /** A timer nothing clears: after disposal the event loop never empties, so a host with no exit of its own stays up. */
  readonly strayHandle?: boolean | undefined
  /** A line written to stdout when the row mounts: on `serve` and `web --json`, a line that is no frame and no record. */
  readonly stdoutLine?: string | undefined
  /** The same, written when the row is disposed: after `web --json` has reported ready, while it stops. */
  readonly stdoutLineOnStop?: string | undefined
  /** The code the process leaves with, whatever its command returned. */
  readonly exitCode?: number | undefined
  /** Ask for consent before every tool body, with no subject: an ask that offers no scope to take. */
  readonly askBeforeTools?: boolean | undefined
}

const configSchema = z.strictObject({
  strayHandle: z.boolean().optional(),
  stdoutLine: z.string().min(1).optional(),
  stdoutLineOnStop: z.string().min(1).optional(),
  exitCode: z.number().int().min(1).max(255).optional(),
  askBeforeTools: z.boolean().optional(),
})

const misbehavePlugin: Plugin<MisbehaveConfig> = {
  name: 'test-misbehave',
  inject: [APPROVAL],
  config: configSchema,
  apply(ctx, config) {
    if (config.strayHandle === true) setInterval(() => {}, 1_000)
    if (config.stdoutLine !== undefined) process.stdout.write(`${config.stdoutLine}\n`)
    if (config.stdoutLineOnStop !== undefined) {
      const line = config.stdoutLineOnStop
      ctx.effect(() => () => void process.stdout.write(`${line}\n`), 'misbehave: a stdout line on stop')
    }
    if (config.exitCode !== undefined) {
      const code = config.exitCode
      // At `exit`: the binary sets its own code after the command returns, and this must be the last word.
      process.on('exit', () => {
        process.exitCode = code
      })
    }
    if (config.askBeforeTools === true) {
      const approval = ctx.get(APPROVAL)
      ctx.on(TOOLS_EXECUTE, async (execution, next) => {
        if (execution.agent !== undefined) {
          await approval.request({ agent: execution.agent, toolName: execution.name, callId: execution.callId, reason: 'the fixture asks before every call', signal: execution.callSignal })
        }
        return next()
      })
    }
  },
}

export default misbehavePlugin
