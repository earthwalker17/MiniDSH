/**
 * `view_image`: read an image from the workspace so the model can see it.
 *
 * The producer half of the attachment plane, and DSH's `read_image` shape. Its
 * order is the one thing that matters:
 *
 *   1. refuse if the STEP's route cannot take images, before any I/O;
 *   2. refuse if this request already carries as many images as it may;
 *   3. resolve and stat, and refuse an oversized file before reading it;
 *   4. read the bytes and commit them DURABLY;
 *   5. only then return, so the reference in the `tool/result` names an object
 *      that already exists.
 *
 * Step 1 is what makes delegation the model's own answer rather than a rule it
 * has to be told. The shipped route cannot see images, so a parent asking to
 * view one is refused with a message naming the move; a verifier child routed to
 * a vision model is not. Nothing enters history the current route cannot take,
 * which is the admission half of the pair — the projection half (history the
 * CURRENT route cannot take is still readable) lives in the adapters.
 *
 * The route it reads is the folded `request/context`, which the driver writes
 * before the step opens. Not `agent.options`, which is the BASE route an
 * `agent/request` listener may have moved; and not a fresh `resolveCallConfig`,
 * which would re-run a waterfall the driver deliberately consults once per step,
 * without the step's own position. No agent means no route, and no route means
 * refuse.
 */
import { z } from 'zod'
import type { Context, Plugin } from '../../kernel/index.ts'
import { asAttachmentId, ATTACHMENTS, isImageAdmissionError, type Attachments, type ImageMediaType } from '../../core/attachments/index.ts'
import { FS, FsError, type Fs, type FsActor } from '../../core/fs/index.ts'
import { imageDescriptor, collectImageRefs } from '../../core/llm/content.ts'
import { LLM, type Llm } from '../../core/llm/index.ts'
import { foldRequestContext } from '../../core/session/index.ts'
import { defineTool, TOOLS, type ToolCallView, type ToolContext } from '../../core/tools/index.ts'
import type { Agent } from '../../core/agent/types.ts'

const DESCRIPTION = `Look at an image file in the workspace.

* Answers with the image itself, so the model reading this result can see it.
* Only a vision-capable route can receive one. On a text-only route this is refused, and the refusal says so — delegate to a subagent whose route can see images rather than retrying.
* PNG, JPEG, WebP and GIF.`

const InputSchema = z.object({ path: z.string().describe('Path to the image, relative to the workspace or absolute.') })
type Input = z.infer<typeof InputSchema>

/**
 * The durable value. `name` is nullable rather than optional because a tool's
 * value must be strictly JSON, and an optional property is `string | undefined`
 * — which `JsonValue` does not admit even though `snapshotJson` would drop it.
 * Absent and null mean the same thing here, and `render` puts it back.
 */
const OutputSchema = z.object({
  attachment: z.object({
    id: z.string(),
    mediaType: z.string(),
    bytes: z.number(),
    width: z.number(),
    height: z.number(),
    name: z.string().nullable(),
  }),
  text: z.string(),
})

interface Deps {
  readonly ctx: Context
  readonly fs: Fs
  readonly llm: Llm
  readonly attachments: () => Attachments | undefined
}

/** What the step this call belongs to can take as input. Absent modalities mean text only. */
function routeTakesImages(llm: Llm, agent: Agent): { ok: boolean; route: string } {
  const context = foldRequestContext(agent.session.facts)
  if (!context) return { ok: false, route: 'an unrecorded route' }
  const route = `${context.provider}/${context.model}`
  // The record is the authority — a replay has no live adapter — and the
  // adapter is consulted only for a log written before the field existed.
  const modalities = context.inputModalities ?? tryLive(llm, context.provider, context.model)
  return { ok: modalities?.includes('image') === true, route }
}

function tryLive(llm: Llm, provider: string, model: string): readonly string[] | undefined {
  try {
    return llm.resolveModel(provider, model).inputModalities
  } catch {
    return undefined
  }
}

/**
 * Images already on the live surface, counted so a request cannot grow past
 * what a provider will serve.
 *
 * Per REQUEST, not per message, and that is the correction that matters: this
 * tool returns one image per result, so a per-message count could never bind.
 * Meanwhile both providers tighten their own per-image limits as a request
 * accumulates images, and Anthropic caps a whole request at 32 MB — so without
 * a cumulative bound, five ordinary calls produce a request that is refused
 * with a code nothing retries and nothing compacts, and the session wedges with
 * every later request failing identically.
 */
function imagesOnSurface(agent: Agent): { count: number; bytes: number } {
  const refs = new Map<string, { bytes: number }>()
  for (const message of agent.session.deriveMessages()) collectImageRefs(message.content, refs as never)
  let bytes = 0
  for (const ref of refs.values()) bytes += ref.bytes
  return { count: refs.size, bytes }
}

async function view(args: Input, exec: ToolContext, deps: Deps): Promise<z.infer<typeof OutputSchema>> {
  const agent = exec.agent
  if (!agent) throw Object.assign(new Error('view_image requires an owning agent'), { code: 'UNSUPPORTED_CONTENT' })

  const { ok, route } = routeTakesImages(deps.llm, agent)
  if (!ok) {
    throw Object.assign(
      new Error(
        `${route} cannot accept images, so reading one here would put content in this conversation that the model cannot see. ` +
          `Delegate the look to a subagent whose route is vision-capable, and ask it to report what it saw.`,
      ),
      { code: 'UNSUPPORTED_CONTENT' },
    )
  }

  const attachments = deps.attachments()
  if (!attachments) throw Object.assign(new Error('this deployment stores no attachments, so an image cannot be read'), { code: 'UNSUPPORTED_CONTENT' })
  const limits = attachments.imageLimits

  const already = imagesOnSurface(agent)
  if (already.count >= limits.maxImagesPerRequest) {
    throw Object.assign(
      new Error(`this conversation already carries ${already.count} image(s), which is all one request may hold; summarise what you have seen instead of adding another`),
      { code: 'TOO_MANY_IMAGES' },
    )
  }

  const target = deps.fs.resolve(args.path, agent.session.header.cwd)
  const info = await deps.fs.stat(target)
  if (!info || info.type !== 'file') throw new FsError('FS_NOT_FOUND', `cannot read "${args.path}" as an image`)
  // Refuse on size before reading: the cheap bound comes first.
  if (info.size > limits.maxImageBytes) {
    throw Object.assign(new Error(`"${args.path}" is ${info.size} bytes; this deployment accepts images up to ${limits.maxImageBytes}`), { code: 'IMAGE_TOO_LARGE' })
  }
  if (already.bytes + info.size > limits.maxRequestImageBytes) {
    throw Object.assign(new Error(`adding "${args.path}" would put ${already.bytes + info.size} bytes of image in one request, over this deployment's ${limits.maxRequestImageBytes}`), {
      code: 'IMAGE_TOO_LARGE',
    })
  }

  const actor: FsActor = exec.agent ? { agent: exec.agent } : {}
  const { bytes } = await deps.fs.readBytes(target, actor)
  let ref
  try {
    // Durable BEFORE this returns: the reference in the `tool/result` about to
    // be appended must name an object that already exists.
    ref = await attachments.saveImage({ data: bytes, name: args.path })
  } catch (error) {
    // An admission refusal is the caller's to fix and says how; a storage fault
    // is this host's and says so. Collapsing them would tell a model to try a
    // different file when the disk is the problem.
    const code = isImageAdmissionError(error) ? (error as { code: string }).code : 'ATTACHMENT_WRITE_FAILED'
    throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code })
  }
  return { attachment: { id: ref.id, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, name: ref.name ?? null }, text: imageDescriptor(ref) }
}

export const toolViewImagePlugin: Plugin = {
  name: 'tool-view-image',
  inject: [TOOLS, FS, LLM],
  apply(ctx) {
    const deps: Deps = { ctx, fs: ctx.get(FS), llm: ctx.get(LLM), attachments: () => ctx.tryGet(ATTACHMENTS) }
    ctx.get(TOOLS).register(
      ctx,
      defineTool({
        name: 'view_image',
        description: DESCRIPTION,
        input: InputSchema,
        output: OutputSchema,
        presentCall: (args): ToolCallView => ({ card: 'generic', title: `view image ${args.path}`, kind: 'read', locations: [{ path: args.path }] }),
        // The block the model actually sees: the reference, and the descriptor
        // that stands in for it wherever the bytes cannot go.
        render: (_args, value) => [
          {
            type: 'image',
            attachment: {
              id: asAttachmentId(value.attachment.id),
              mediaType: value.attachment.mediaType as ImageMediaType,
              bytes: value.attachment.bytes,
              width: value.attachment.width,
              height: value.attachment.height,
              ...(value.attachment.name === null ? {} : { name: value.attachment.name }),
            },
            text: value.text,
          },
        ],
        execute: (args: Input, exec) => view(args, exec, deps),
      }),
    )
  },
}
