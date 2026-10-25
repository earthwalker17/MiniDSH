/**
 * The model-facing half of background jobs: `job_start` starts a shell
 * command beside the session, `job_output` reads what it wrote, `job_cancel`
 * stops it. Everything that makes a job a JOB — its id, its bracket in the
 * log, its notice through the inbox, its end at disposal — is `core/jobs`';
 * the process is the shell provider's. This file owns only what the model is
 * told.
 *
 * **Never an escalation.** A job runs under the session's own policy and the
 * acceptance it recorded, resolved inside `launch` so a switch landing while
 * it starts is one the registry already watches. An escalation's consent is
 * to ONE call (§7), and a job outlives the call that started it, so there is no
 * `sandbox_permissions` here: a command that needs more runs in the
 * foreground, where the shell tool can ask.
 */
import { z } from 'zod'
import type { Context, Plugin } from '../../kernel/index.ts'
import type { Agent } from '../../core/agent/types.ts'
import { foldJobs, JobError, JOBS, type JobEnd, type JobView } from '../../core/jobs/index.ts'
import { SANDBOX, SandboxError } from '../../core/sandbox/index.ts'
import { SHELL } from '../../core/shell/index.ts'
import { excerptWithSpill, excerptWithoutSpill } from '../../core/spill/index.ts'
import { defineTool, TOOLS } from '../../core/tools/index.ts'

export interface ToolJobsConfig {
  /** The longest `job_output` may wait for a job to end (default 600000 ms). */
  readonly maxWaitMs?: number | undefined
}

const configSchema = z.strictObject({ maxWaitMs: z.number().int().positive().optional() }).optional()

/** A read's excerpt: the tail is how a job is doing, so it gets the larger share. */
const EXCERPT = { headChars: 4_000, tailChars: 12_000 }

export const toolJobsPlugin: Plugin<ToolJobsConfig | undefined> = {
  name: 'tool-jobs',
  inject: [TOOLS, JOBS, SHELL, SANDBOX],
  config: configSchema,
  apply(ctx, config) {
    const tools = ctx.get(TOOLS)
    const { start, output, cancel } = buildJobTools(ctx, config?.maxWaitMs ?? 600_000)
    tools.register(ctx, start)
    tools.register(ctx, output)
    tools.register(ctx, cancel)
  },
}

function owner(agent: Agent | undefined): Agent {
  if (!agent) throw new Error('background jobs need an owning agent')
  return agent
}

function seconds(ms: number | undefined): string {
  return ms === undefined ? '' : ` after ${(ms / 1000).toFixed(1)}s`
}

/** One status line, from the end record when there is one. */
export function jobStatus(view: { readonly state: 'running' | 'ended' | 'unclosed'; readonly pid?: number; readonly end?: JobEnd }): string {
  const end = view.end
  if (end === undefined) return view.state === 'running' ? `running${view.pid === undefined ? '' : ` (pid ${view.pid})`}` : 'no end recorded'
  switch (end.cause) {
    case 'exited':
      return `${end.exitCode !== undefined ? `exited with code ${end.exitCode}` : end.signal !== undefined ? `terminated by signal ${end.signal}` : 'exited'}${seconds(end.durationMs)}`
    case 'failed':
      return `failed${end.detail === undefined ? '' : `: ${end.detail}`}`
    case 'cancelled':
      return `stopped${end.by === 'model' ? '' : end.by === 'user' ? ' by the user' : end.by === 'authority' ? ' (the sandbox policy changed)' : ' (its session ended)'}${seconds(end.durationMs)}`
    case 'lost':
      return 'lost: no longer supervised by this session (its process may still be running)'
  }
}

function buildJobTools(ctx: Context, maxWaitMs: number) {
  const jobs = ctx.get(JOBS)
  const shell = ctx.get(SHELL)
  const sandbox = ctx.get(SANDBOX)
  const dialect = shell.dialect === 'pwsh' ? 'pwsh (PowerShell 7)' : 'bash'

  const start = defineTool({
    name: 'job_start',
    description: `Start a long-running command as a background job and return its id at once.
* Use it for servers, watchers, and slow builds or test runs you want to keep working beside; use the shell tool for everything else.
* It runs in a fresh ${dialect} process at the workspace root — not in the shell tool's current directory or environment — under this session's sandbox policy, and cannot be escalated.
* You are notified in this session when it ends; read its output with job_output and stop it with job_cancel. Jobs end with their session; on Windows a program a job leaves running after its own command has ended is not stopped with it.`,
    input: z.object({ command: z.string().min(1).describe('The command to run in the background.') }),
    output: z.object({ jobId: z.string(), pid: z.number().nullable(), output: z.string().nullable() }),
    render: (_args, value) => [
      {
        type: 'text',
        text:
          `started job ${value.jobId}${value.pid === null ? '' : ` (pid ${value.pid})`}. You will be notified when it ends; ` +
          `read its output with job_output and stop it with job_cancel.${value.output === null ? '' : ` Its output is written to ${value.output}.`}`,
      },
    ],
    execute: async (args, exec) => {
      const agent = owner(exec.agent)
      const session = shell.sessionFor(agent)
      if (session.start === undefined) throw new JobError('JOB_REFUSED', 'this shell world cannot run background jobs')
      try {
        const view = await jobs.start({
          agent,
          callId: exec.callId,
          kind: 'shell',
          label: args.command,
          launch: async (output) => {
            // Resolved HERE, after admission: the registry is already watching
            // for a switch of authority when this stamp is read.
            const policy = sandbox.resolve({ session: agent.session })
            const job = await session.start!({ command: args.command, policy, accepts: sandbox.acceptsFor(agent.session, policy.mode), output })
            return { ...(job.pid === undefined ? {} : { pid: job.pid }), mode: job.sandbox.mode, enforcement: job.sandbox.enforcement, exited: job.exited, kill: () => job.kill() }
          },
        })
        return { jobId: view.jobId, pid: view.pid ?? null, output: view.output ?? null }
      } catch (error) {
        if (error instanceof SandboxError && error.code === 'SANDBOX_UNAVAILABLE') {
          throw new SandboxError(
            'SANDBOX_UNAVAILABLE',
            `[sandbox: ${error.message}] A background job runs under this session's own policy and cannot be escalated; run the command with the shell tool instead, which can ask for a wider mode.`,
          )
        }
        throw error
      }
    },
  })

  const output = defineTool({
    name: 'job_output',
    description: `Read a background job's status and the output it wrote since your last read. With wait_ms, first wait up to that long for it to end.`,
    input: z.object({
      job_id: z.string().min(1),
      wait_ms: z.number().int().nonnegative().optional().describe(`Wait up to this long for the job to end before reading (at most ${maxWaitMs}).`),
    }),
    output: z.object({ status: z.string(), text: z.string() }),
    // The wait is the tool's own, bounded below; the registry's deadline would
    // cut a legitimate wait short and lose the end it was about to report.
    timeoutMs: null,
    render: (_args, value) => [{ type: 'text', text: `${value.text.length > 0 ? value.text : '(no new output)'}\n[status: ${value.status}]` }],
    execute: async (args, exec) => {
      const agent = owner(exec.agent)
      try {
        const read = await jobs.read(agent, args.job_id, { waitMs: Math.min(args.wait_ms ?? 0, maxWaitMs), signal: exec.callSignal, callId: exec.callId })
        return { status: jobStatus(read.view), text: excerpt(read.text, read.omitted, read.view) }
      } catch (error) {
        if (!(error instanceof JobError) || error.code !== 'JOB_UNKNOWN') throw error
        // Not this lifecycle's: answer from the log, which outlives the registry.
        const record = foldJobs(agent.session.facts).find((job) => job.start.jobId === args.job_id)
        if (!record) throw error
        const where = record.start.output === undefined ? '' : ` Whatever it wrote is in ${record.start.output}.`
        return {
          status: jobStatus({ state: 'unclosed', ...(record.end === undefined ? {} : { end: record.end }) }),
          text: `[this job ran in an earlier run of this session; nothing more can be read from it here.${where}]`,
        }
      }
    },
  })

  const cancel = defineTool({
    name: 'job_cancel',
    description: 'Stop a running background job and what it started.',
    input: z.object({ job_id: z.string().min(1) }),
    output: z.object({ status: z.string(), ended: z.boolean() }),
    timeoutMs: null,
    render: (args, value) => [
      { type: 'text', text: value.ended ? `job ${args.job_id}: ${value.status}` : `job ${args.job_id}: a stop was requested, but it has not ended yet [status: ${value.status}]` },
    ],
    execute: async (args, exec) => {
      const view: JobView = await jobs.cancel(owner(exec.agent), args.job_id, 'model', exec.callId)
      return { status: jobStatus(view), ended: view.state === 'ended' }
    },
  })

  return { start, output, cancel }
}

function excerpt(text: string, omitted: number, view: JobView): string {
  // A file that stopped short (the size cap, a store that could not write) is
  // never called the whole output.
  const partial = view.outputPartial === true
  const where = view.output === undefined ? '' : partial ? `; ${view.output} holds only part of it` : `; the whole output is in ${view.output}`
  const lost = omitted > 0 ? `[${omitted.toLocaleString('en-US')} earlier characters are no longer held in memory${where}]\n` : ''
  const bounded = view.output === undefined || partial ? excerptWithoutSpill(text, EXCERPT) : excerptWithSpill(text, { path: view.output, bytes: 0 }, EXCERPT)
  return lost + bounded
}
