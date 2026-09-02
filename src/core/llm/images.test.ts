/**
 * The three answers an adapter gives an image block, and the wire shapes it
 * produces. Every wire shape here was probed against the real API first; the
 * assertions are what those probes returned 200 for.
 */
import { describe, expect, it } from 'vitest'
import { asAttachmentId, AttachmentError, type AttachmentRef, type Attachments } from '../attachments/index.ts'
import { asCallId } from '../ids.ts'
import { serializeMessages as serializeAnthropic } from '../../capabilities/llm-anthropic/serialize.ts'
import { serializeMessages as serializeDeepSeek } from '../../capabilities/llm-deepseek/serialize.ts'
import { imageDescriptor, resolveRequestImages, type ResolvedImage } from './content.ts'
import { createToolResultMessage, createUserMessage } from './message.ts'
import { LlmError, type ContentBlock, type Message } from './types.ts'

const BYTES = new Uint8Array([1, 2, 3, 4])
const REF: AttachmentRef = { id: asAttachmentId(`sha256:${'cd'.repeat(32)}`), mediaType: 'image/png', bytes: BYTES.length, width: 8, height: 8, name: 'dot.png' }
const IMAGE: ContentBlock = { type: 'image', attachment: REF, text: imageDescriptor(REF) }
const RESOLVED: ReadonlyMap<string, ResolvedImage> = new Map([[REF.id, { ref: REF, data: BYTES }]])
const BASE64 = Buffer.from(BYTES).toString('base64')

function userWithImage(text: string): Message {
  const message = createUserMessage(text)
  return { ...message, content: [...message.content, IMAGE] }
}

function store(read: () => Promise<Uint8Array>): Attachments {
  return {
    imageLimits: { maxImageBytes: 1, maxImageDimension: 1, maxImagePixels: 1, maxImagesPerRequest: 1, maxRequestImageBytes: 1, mediaTypes: ['image/png'] },
    saveImage: () => Promise.reject(new Error('not used')),
    readImage: read,
    hostPath: () => undefined,
  }
}

describe('resolveRequestImages', () => {
  const options = { takesImages: true, attachments: store(() => Promise.resolve(BYTES)), provider: 'deepseek', model: 'vision' }

  it('never touches the store for a history with no image', async () => {
    let read = false
    const watching = store(() => {
      read = true
      return Promise.resolve(BYTES)
    })
    expect((await resolveRequestImages([createUserMessage('hi')], { ...options, attachments: watching })).size).toBe(0)
    expect(read).toBe(false)
  })

  it('resolves an image nested in a tool result, which is where every image MiniDSH produces lives', async () => {
    const result = createToolResultMessage(asCallId('c1'), [IMAGE], false)
    expect([...(await resolveRequestImages([result], options)).keys()]).toEqual([REF.id])
  })

  /**
   * The one path that substitutes. It exists because durable history outlives
   * the model that first consumed it: refusing here would brick every session
   * that ever attached an image the moment its route changed.
   */
  it('returns nothing for a text-only route, so the serializer sends the descriptor', async () => {
    expect((await resolveRequestImages([userWithImage('look')], { ...options, takesImages: false })).size).toBe(0)
  })

  it('refuses when the route takes images but nothing is mounted to hold them', async () => {
    await expect(resolveRequestImages([userWithImage('look')], { ...options, attachments: undefined })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  /**
   * Refuse, never coerce. Falling back to the descriptor here would tell the
   * model it was shown a description while the log says it was shown an image.
   */
  it('refuses when the bytes are gone, and the code is deliberately not retryable', async () => {
    const missing = store(() => Promise.reject(new AttachmentError('ATTACHMENT_NOT_FOUND', 'gone')))
    const error = await resolveRequestImages([userWithImage('look')], { ...options, attachments: missing }).catch((e: unknown) => e)
    expect((error as LlmError).code).toBe('ATTACHMENT_UNREADABLE')
    const { RETRYABLE_CODES } = await import('./types.ts')
    expect(RETRYABLE_CODES.has('ATTACHMENT_UNREADABLE')).toBe(false)
  })
})

describe('DeepSeek wire shape', () => {
  it('sends a data URI beside the text, in the OpenAI-compatible part shape a probe accepted', () => {
    expect(serializeDeepSeek(undefined, [userWithImage('what colour?')], RESOLVED)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'what colour?' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${BASE64}` } }] },
    ])
  })

  it('puts an image inside a tool-role message, the shape the verifier child actually produces', () => {
    const result = createToolResultMessage(asCallId('c1'), [{ type: 'text', text: 'here' }, IMAGE], false)
    expect(serializeDeepSeek(undefined, [result], RESOLVED)).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'here' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${BASE64}` } }] },
    ])
  })

  it('keeps the string form when the bytes were not resolved, and sends the descriptor', () => {
    expect(serializeDeepSeek(undefined, [userWithImage('what colour?')])).toEqual([{ role: 'user', content: `what colour?${imageDescriptor(REF)}` }])
  })
})

describe('Anthropic wire shape', () => {
  it('sends a base64 source block, in the shape a probe accepted', () => {
    expect(serializeAnthropic([userWithImage('what colour?')], RESOLVED)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'what colour?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BASE64 } }] },
    ])
  })

  it('keeps a tool_result image INSIDE the tool result, never hoisted by the results-first sort', () => {
    const result = createToolResultMessage(asCallId('c1'), [{ type: 'text', text: 'here' }, IMAGE], false)
    const turns = serializeAnthropic([result, createUserMessage('and now?')], RESOLVED)
    expect(turns).toHaveLength(1)
    const [first, second] = turns[0]!.content
    // The sort moves top-level blocks only: the tool result comes first, and the
    // image is still one of ITS blocks.
    expect(first).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'c1',
      content: [{ type: 'text', text: 'here' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BASE64 } }],
    })
    expect(second).toEqual({ type: 'text', text: 'and now?' })
  })

  it('keeps the string form when the bytes were not resolved, and sends the descriptor', () => {
    const result = createToolResultMessage(asCallId('c1'), [IMAGE], false)
    expect(serializeAnthropic([result])).toEqual([[{ type: 'tool_result', tool_use_id: 'c1', content: imageDescriptor(REF) }]].map((content) => ({ role: 'user', content })))
  })
})
