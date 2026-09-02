/**
 * The guards that had to land BEFORE the `image` variant existed.
 *
 * A probe against the tree at 19bda63 pushed a constructed image block through
 * the live code and nothing changed: the meter scored it 0, both serializers
 * emitted byte-identical wire messages, and three surfaces rendered nothing.
 * None of those six sites was a `switch` the type checker would flag. These
 * tests pin the projection that replaced them, and — the load-bearing half —
 * that adding it did not move a single byte for a history with no image in it.
 */
import { describe, expect, it } from 'vitest'
import { asAttachmentId, type AttachmentRef } from '../attachments/index.ts'
import { asCallId } from '../ids.ts'
import { estimateImageTokens, estimateMessage } from '../metering/index.ts'
import { serializeMessages as serializeAnthropic } from '../../capabilities/llm-anthropic/serialize.ts'
import { serializeMessages as serializeDeepSeek } from '../../capabilities/llm-deepseek/serialize.ts'
import { blockText, collectImageRefs, contentText, imageDescriptor } from './content.ts'
import { createAssistantMessage, createToolResultMessage, createUserMessage, messageText } from './message.ts'
import type { ContentBlock } from './types.ts'

const REF: AttachmentRef = {
  id: asAttachmentId(`sha256:${'ab'.repeat(32)}`),
  mediaType: 'image/png',
  bytes: 12_700,
  width: 96,
  height: 96,
  name: 'quad.png',
}

const IMAGE: ContentBlock = { type: 'image', attachment: REF, text: imageDescriptor(REF) }

describe('imageDescriptor', () => {
  it('names what a text-only route is sent in place of the bytes', () => {
    expect(imageDescriptor(REF)).toBe('[image quad.png · image/png · 96×96 · 12 KB]')
  })

  it('falls back to a generic name rather than inventing one', () => {
    const { name: _name, ...unnamed } = REF
    expect(imageDescriptor(unnamed)).toBe('[image image · image/png · 96×96 · 12 KB]')
  })
})

describe('blockText', () => {
  it('reproduces the `type === "text"` filter it replaced, for every original kind', () => {
    expect(blockText({ type: 'text', text: 'hello' })).toBe('hello')
    // Not part of what a message SAYS — the old filter dropped all three.
    expect(blockText({ type: 'reasoning', text: 'thinking' })).toBe('')
    expect(blockText({ type: 'tool-call', id: asCallId('c1'), name: 'view', arguments: '{}' })).toBe('')
    expect(blockText({ type: 'tool-result', toolCallId: asCallId('c1'), content: [{ type: 'text', text: 'out' }] })).toBe('')
  })

  it('projects an image to its stored descriptor, not to nothing', () => {
    expect(blockText(IMAGE)).toBe(REF.name === undefined ? '' : imageDescriptor(REF))
    expect(blockText(IMAGE).length).toBeGreaterThan(0)
  })

  it('reads the STORED descriptor, so a wording change cannot rewrite an old log', () => {
    const frozen: ContentBlock = { type: 'image', attachment: REF, text: '[image as an older MiniDSH wrote it]' }
    expect(blockText(frozen)).toBe('[image as an older MiniDSH wrote it]')
  })
})

describe('contentText and collectImageRefs', () => {
  it('walks into a tool result, which is where every image S8 produces lives', () => {
    const nested: ContentBlock = { type: 'tool-result', toolCallId: asCallId('c1'), content: [{ type: 'text', text: 'here' }, IMAGE] }
    expect([...collectImageRefs([nested]).keys()]).toEqual([REF.id])
    // `contentText` deliberately does NOT unwrap a tool result: whoever unwraps it projects its content.
    expect(contentText([nested])).toBe('')
    expect(contentText(nested.type === 'tool-result' ? nested.content : [])).toBe(`here${imageDescriptor(REF)}`)
  })

  it('dedupes by attachment id, because one object may appear under two names', () => {
    const again: ContentBlock = { type: 'image', attachment: { ...REF, name: 'copy.png' }, text: 'x' }
    expect(collectImageRefs([IMAGE, again]).size).toBe(1)
  })
})

describe('messageText', () => {
  it('is unchanged for a text-only message', () => {
    expect(messageText(createUserMessage('fix the bug'))).toBe('fix the bug')
    expect(messageText(createAssistantMessage([{ type: 'text', text: 'done' }, { type: 'reasoning', text: 'hmm' }], 'p', 'm'))).toBe('done')
  })

  it('no longer returns nothing for an image-only message', () => {
    const message = createUserMessage('')
    const withImage = { ...message, content: [IMAGE] }
    expect(messageText(withImage)).toBe(imageDescriptor(REF))
  })
})

describe('estimateImageTokens', () => {
  /**
   * Measured against Anthropic's `count_tokens` on claude-haiku-4-5, minus an
   * 11-token text baseline: 96²→19, 256²→103, 512²→364, 1024²→1372, 1568²→1524,
   * 2048²→1524. DeepSeek's own bucketed cost on the same images is far lower
   * (96px→116, 1024px and up→348 over a 7-token baseline), so this curve is the
   * conservative side for a provider-neutral meter.
   */
  it('tracks the measured Anthropic curve within its own rounding', () => {
    expect(estimateImageTokens(96, 96)).toBe(13) // measured 19
    expect(estimateImageTokens(256, 256)).toBe(88) // measured 103
    expect(estimateImageTokens(512, 512)).toBe(350) // measured 364
    expect(estimateImageTokens(1024, 1024)).toBe(1399) // measured 1372
  })

  it('plateaus where the provider downscales instead of growing without bound', () => {
    expect(estimateImageTokens(1568, 1568)).toBe(1600)
    expect(estimateImageTokens(4000, 3000)).toBe(1600)
    expect(estimateImageTokens(0, 0)).toBe(0)
  })

  it('is what the meter charges, so an image is no longer free', () => {
    const text = createUserMessage('look at this')
    const withImage = { ...text, content: [...text.content, IMAGE] }
    // The probe that motivated this: both scored 7 before the variant landed.
    expect(estimateMessage(text)).toBe(7)
    expect(estimateMessage(withImage)).toBe(7 + estimateImageTokens(96, 96))
  })
})

describe('the wire is unmoved for a history with no image', () => {
  /**
   * The hazard this pins: the natural way to carry an image is to widen every
   * message's `content` to an array of parts. That would change the bytes of
   * every message serialized BEFORE the first image, so attaching one at turn 12
   * would retroactively rewrite turns 1-11 and cost both providers' prefix cache
   * for the rest of the session — and every pre-S8 session would re-pay its whole
   * prompt on the first request after the upgrade.
   */
  const history = [
    createUserMessage('read the file'),
    createAssistantMessage([{ type: 'text', text: 'ok' }, { type: 'tool-call', id: asCallId('c1'), name: 'view', arguments: '{"path":"a.ts"}' }], 'deepseek', 'deepseek-v4-flash'),
    createToolResultMessage(asCallId('c1'), [{ type: 'text', text: 'file contents' }], false),
  ]

  it('DeepSeek still sends plain string content', () => {
    expect(serializeDeepSeek('sys', history)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'read the file' },
      { role: 'assistant', content: 'ok', reasoning_content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'view', arguments: '{"path":"a.ts"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'file contents' },
    ])
  })

  it('Anthropic still sends a plain string tool_result', () => {
    expect(serializeAnthropic(history)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'read the file' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'c1', name: 'view', input: { path: 'a.ts' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'file contents' }] },
    ])
  })

  it('an image-bearing tool result carries its descriptor rather than "(no output)"', () => {
    // Phase 2 replaces the descriptor with real bytes on an image-capable route;
    // until then — and forever on a text-only route — this is what is sent, and
    // the one thing it must never be is silence.
    const result = createToolResultMessage(asCallId('c2'), [IMAGE], false)
    const deepseek = serializeDeepSeek(undefined, [result])
    expect(deepseek[0]?.content).toBe(imageDescriptor(REF))
    expect(deepseek[0]?.content).not.toBe('(no output)')
    const anthropic = serializeAnthropic([result])
    expect(anthropic[0]?.content[0]).toMatchObject({ type: 'tool_result', content: imageDescriptor(REF) })
  })
})
