/**
 * Image admission: whether a producer may put one more image into THIS
 * conversation, decided before any byte is read or captured.
 *
 * Every image producer asks the same three questions, in this order, and the
 * order is the contract:
 *
 *   1. can the STEP's route take images at all? (`assertRouteTakesImages`,
 *      before any I/O);
 *   2. does this request already carry as many images as it may?
 *      (`assertImageRoom`, before any I/O);
 *   3. once the size is known — a file's `stat`, a capture's bytes — does the
 *      image fit, alone and beside what the request already carries?
 *      (`assertImageFits`, before the bytes are committed).
 *
 * Only then does the producer commit through `Attachments.saveImage`, so the
 * reference in its `tool/result` names an object that already exists (the
 * attachment plane's one rule). Step 1 is what makes delegation the model's own
 * answer rather than a rule it has to be told: a text-only parent asking to see
 * is refused with a message naming the move, and a verifier child routed to a
 * vision model is not. Nothing enters history the current route cannot take —
 * the admission half; the projection half (history the CURRENT route cannot
 * take is still readable) lives in the adapters.
 *
 * It lives beside `core/llm`, not in `core/attachments`, because the plane
 * imports nothing from `core/llm` (its module note) and this rule is about a
 * ROUTE. It was `tool-view-image`'s alone until a second producer existed
 * (S20's `tool-browser`); one rule, one home.
 */
import { AttachmentError, type ImageLimits } from '../attachments/index.ts'
import type { Agent } from '../agent/types.ts'
import type { Session } from '../session/session.ts'
import { foldRequestContext } from '../session/surface.ts'
import type { Llm } from './runtime.ts'
import type { ContentBlock } from './types.ts'

/**
 * What the step this call belongs to can take as input. Absent modalities mean
 * text only.
 *
 * The route read is the folded `request/context`, which the driver writes
 * before the step opens. Not `agent.options`, which is the BASE route an
 * `agent/request` listener may have moved; and not a fresh `resolveCallConfig`,
 * which would re-run a waterfall the driver deliberately consults once per
 * step, without the step's own position. No record means no route, and no
 * route means refuse.
 */
export function routeTakesImages(llm: Llm, agent: Agent): { ok: boolean; route: string } {
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

/** Step 1 as a refusal: `UNSUPPORTED_CONTENT`, worded so the model's next move is delegation, not a retry. */
export function assertRouteTakesImages(llm: Llm, agent: Agent): void {
  const { ok, route } = routeTakesImages(llm, agent)
  if (ok) return
  throw Object.assign(
    new Error(
      `${route} cannot accept images, so putting one here would add content to this conversation that the model cannot see. ` +
        `Delegate the look to a subagent whose route is vision-capable, and ask it to report what it saw.`,
    ),
    { code: 'UNSUPPORTED_CONTENT' },
  )
}

/**
 * Images already on the live surface, counted so a request cannot grow past
 * what a provider will serve.
 *
 * Per REQUEST, not per message: a producer returns one image per result, so a
 * per-message count could never bind, while both providers tighten their own
 * per-image limits as a request accumulates images and Anthropic caps a whole
 * request at 32 MB. Without a cumulative bound, a handful of ordinary calls
 * produce a request refused with a code nothing retries and nothing compacts,
 * and every later request in the session fails identically.
 *
 * It counts OCCURRENCES, not distinct attachments, and that distinction is the
 * whole bound. `collectImageRefs` dedupes by id — correctly, because the
 * adapter reads each object's bytes once — but the serializers emit one wire
 * image per BLOCK. Since the store is content-addressed, viewing the same file
 * five times yields five blocks carrying one id, so a deduped count sees a
 * single image while the request carries five full copies. Reproduced before
 * this was written: the bound said 1, the wire carried 5.
 */
export function imagesOnSurface(session: Session): { count: number; bytes: number } {
  let count = 0
  let bytes = 0
  const walk = (blocks: readonly ContentBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'image') {
        count++
        bytes += block.attachment.bytes
      } else if (block.type === 'tool-result') {
        walk(block.content)
      }
    }
  }
  for (const message of session.deriveMessages()) walk(message.content)
  return { count, bytes }
}

/**
 * Step 2: refused when this conversation already carries all the images one
 * request may hold. The bound is the SURFACE's, so it holds until a compaction
 * shadows them — and a delegated child starts with a surface of its own, which
 * is why the message names delegation before summarising.
 */
export function assertImageRoom(session: Session, limits: ImageLimits): void {
  const already = imagesOnSurface(session)
  if (already.count < limits.maxImagesPerRequest) return
  throw new AttachmentError(
    'TOO_MANY_IMAGES',
    `this conversation already carries ${already.count} image(s), which is all one request may hold. ` +
      `A subagent starts with a conversation of its own: delegate further looks to one and ask it to report, or summarise what you have seen.`,
  )
}

/**
 * Step 3: refused when an image of `byteLength` exceeds the per-image bound, or
 * would push this request past its cumulative byte bound. `label` names the
 * image in the refusal (a path, or "this screenshot").
 */
export function assertImageFits(session: Session, limits: ImageLimits, byteLength: number, label: string): void {
  if (byteLength > limits.maxImageBytes) {
    throw new AttachmentError('IMAGE_TOO_LARGE', `${label} is ${byteLength} bytes; this deployment accepts images up to ${limits.maxImageBytes}`)
  }
  const already = imagesOnSurface(session)
  if (already.bytes + byteLength > limits.maxRequestImageBytes) {
    throw new AttachmentError(
      'IMAGE_TOO_LARGE',
      `adding ${label} would put ${already.bytes + byteLength} bytes of image in one request, over this deployment's ${limits.maxRequestImageBytes}`,
    )
  }
}
