/**
 * `view_image`: read an image from the workspace so the model can see it.
 *
 * A producer on the attachment plane, and DSH's `read_image` shape. Its order
 * is the one thing that matters, and it is `core/llm/admission.ts`'s:
 *
 *   1. refuse if the STEP's route cannot take images, before any I/O;
 *   2. refuse if this request already carries as many images as it may;
 *   3. resolve and stat, and refuse an oversized file before reading it;
 *   4. read the bytes and commit them DURABLY;
 *   5. only then return, so the reference in the `tool/result` names an object
 *      that already exists.
 *
 * No agent means no route, and no route means refuse.
 */
import { z } from 'zod'
import type { Context, Plugin } from '../../kernel/index.ts'
import { asAttachmentId, ATTACHMENTS, isImageAdmissionError, type Attachments, type ImageMediaType } from '../../core/attachments/index.ts'
import { FS, FsError, type Fs, type FsActor } from '../../core/fs/index.ts'
import { imageDescriptor } from '../../core/llm/content.ts'
import { assertImageFits, assertImageRoom, assertRouteTakesImages } from '../../core/llm/admission.ts'
import { LLM, type Llm } from '../../core/llm/index.ts'
import { defineTool, TOOLS, type ToolContext } from '../../core/tools/index.ts'

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

async function view(args: Input, exec: ToolContext, deps: Deps): Promise<z.infer<typeof OutputSchema>> {
  const agent = exec.agent
  if (!agent) throw Object.assign(new Error('view_image requires an owning agent'), { code: 'UNSUPPORTED_CONTENT' })

  assertRouteTakesImages(deps.llm, agent)

  const attachments = deps.attachments()
  if (!attachments) throw Object.assign(new Error('this deployment stores no attachments, so an image cannot be read'), { code: 'UNSUPPORTED_CONTENT' })
  const limits = attachments.imageLimits

  assertImageRoom(agent.session, limits)

  const target = deps.fs.resolve(args.path, agent.session.header.cwd)
  const info = await deps.fs.stat(target)
  if (!info || info.type !== 'file') throw new FsError('FS_NOT_FOUND', `cannot read "${args.path}" as an image`)
  // Refuse on size before reading: the cheap bound comes first.
  assertImageFits(agent.session, limits, info.size, `"${args.path}"`)

  const actor: FsActor = exec.agent ? { agent: exec.agent } : {}
  // The size stat reported is not a bound on what a read returns (core/fs).
  const { bytes } = await deps.fs.readBytes(target, actor, { maxBytes: limits.maxImageBytes })
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
