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
import { blockText, collectImageRefs, contentText, imageDescriptor, wellFormedArguments, wellFormedContent } from './content.ts'
import { createAssistantMessage, createPluginMessage, createToolResultMessage, createUserMessage, messageText } from './message.ts'
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

describe('wellFormedContent', () => {
  const half = String.fromCharCode(0xd83d) // the high half of U+1F600, alone
  const fixed = String.fromCharCode(0xfffd)

  it('replaces a lone surrogate in every string a provider is sent, and in nothing else', () => {
    const call = asCallId(`c${half}`)
    const blocks: ContentBlock[] = [
      { type: 'text', text: `a${half}` },
      { type: 'reasoning', text: `${half}b` },
      { type: 'image', attachment: REF, text: `[image ${half}]` },
      { type: 'tool-call', id: call, name: `n${half}`, arguments: `{"x":"${half}"}` },
      { type: 'tool-result', toolCallId: call, content: [{ type: 'text', text: `c${half}d` }], isError: true },
    ]
    expect(wellFormedContent(blocks)).toEqual([
      { type: 'text', text: `a${fixed}` },
      { type: 'reasoning', text: `${fixed}b` },
      { type: 'image', attachment: REF, text: `[image ${fixed}]` },
      // The id pairs records; it is not text, and it is left as it came.
      { type: 'tool-call', id: call, name: `n${fixed}`, arguments: `{"x":"${fixed}"}` },
      { type: 'tool-result', toolCallId: call, content: [{ type: 'text', text: `c${fixed}d` }], isError: true },
    ])
    expect(JSON.stringify(wellFormedContent(blocks.slice(0, 3))).isWellFormed()).toBe(true)
  })

  it('hands back the very blocks it was given when there is nothing to replace, a whole pair included', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'a whole pair: \u{1F600}' },
      { type: 'tool-call', id: asCallId('c1'), name: 'view', arguments: '{}' },
      { type: 'tool-result', toolCallId: asCallId('c1'), content: [{ type: 'text', text: 'out' }, IMAGE] },
    ]
    const out = wellFormedContent(blocks)
    expect(out).not.toBe(blocks)
    expect(out.map((block, index) => block === blocks[index])).toEqual([true, true, true])
  })

  it('is what every message constructor applies, so no constructor can log one', () => {
    const lone = `x${half}`
    const built = [
      createUserMessage(lone),
      createPluginMessage('p', lone),
      createAssistantMessage([{ type: 'text', text: lone }], 'p', 'm'),
      createToolResultMessage(asCallId('c1'), [{ type: 'text', text: lone }], false),
    ]
    expect(built.map((message) => JSON.stringify(message.content).includes(`x${fixed}`))).toEqual([true, true, true, true])
    expect(built.map((message) => /\\ud83d/i.test(JSON.stringify(message.content)))).toEqual([false, false, false, false])
  })
})

// A call's arguments are JSON text. A lone surrogate can sit in them as an
// ESCAPE, in a string that is itself well-formed: OpenAI answers a history
// holding one with HTTP 500, three times of three (S22.5, 2026-11-21).
describe('wellFormedArguments', () => {
  const B = '\\' // one backslash, as the arguments string holds it

  it('replaces an unpaired surrogate escape, whichever half it is and whatever its case', () => {
    expect(wellFormedArguments(`{"q":"${B}ud83d"}`)).toBe(`{"q":"${B}ufffd"}`)
    expect(wellFormedArguments(`{"q":"${B}ude00 tail"}`)).toBe(`{"q":"${B}ufffd tail"}`)
    expect(wellFormedArguments(`{"q":"${B}uD83D"}`)).toBe(`{"q":"${B}ufffd"}`)
    // A low half before a high one is two lone halves, not a pair.
    expect(wellFormedArguments(`{"q":"${B}ude00${B}ud83d"}`)).toBe(`{"q":"${B}ufffd${B}ufffd"}`)
    // A lone half followed by a real pair: only the first is replaced.
    expect(wellFormedArguments(`{"q":"${B}ud83d${B}ud83d${B}ude00"}`)).toBe(`{"q":"${B}ufffd${B}ud83d${B}ude00"}`)
    for (const args of [`{"q":"${B}ud83d"}`, `{"q":"${B}ude00${B}ud83d"}`]) {
      expect((JSON.parse(args) as { q: string }).q.isWellFormed()).toBe(false)
      expect((JSON.parse(wellFormedArguments(args)) as { q: string }).q.isWellFormed()).toBe(true)
    }
  })

  it('leaves a pair, an escaped backslash, every other escape and plain text exactly as written', () => {
    const kept = [
      `{"q":"${B}ud83d${B}ude00"}`,
      // An escaped backslash, then the letters: the text \ud83d, not an escape.
      `{"path":"C:${B}${B}ud83d${B}${B}users"}`,
      `{"q":"${B}u0041 ${B}n ${B}" ${B}t"}`,
      `{"q":"\u{1F600} plain"}`,
      '{}',
      // Not JSON at all: a model's broken arguments are logged as they came.
      `{"q": ${B}`,
    ]
    expect(kept.map((args) => wellFormedArguments(args))).toEqual(kept)
  })

  it('is what a tool call gets wherever a message is built, and the same string comes back when nothing changed', () => {
    const call: ContentBlock = { type: 'tool-call', id: asCallId('c1'), name: 'search', arguments: `{"q":"${B}ud83d"}` }
    expect(wellFormedContent([call])).toEqual([{ ...call, arguments: `{"q":"${B}ufffd"}` }])
    expect(createAssistantMessage([call], 'p', 'm').content).toEqual([{ ...call, arguments: `{"q":"${B}ufffd"}` }])
    const fine: ContentBlock = { type: 'tool-call', id: asCallId('c2'), name: 'search', arguments: `{"q":"${B}u00e9"}` }
    expect(wellFormedContent([fine])[0]).toBe(fine)
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
    expect(blockText(IMAGE)).toBe(imageDescriptor(REF))
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
    // On a text-only route, or when the bytes were not resolved, this is what
    // is sent (images.test.ts covers the resolved-bytes wire), and the one
    // thing it must never be is silence.
    const result = createToolResultMessage(asCallId('c2'), [IMAGE], false)
    const deepseek = serializeDeepSeek(undefined, [result])
    expect(deepseek[0]?.content).toBe(imageDescriptor(REF))
    expect(deepseek[0]?.content).not.toBe('(no output)')
    const anthropic = serializeAnthropic([result])
    expect(anthropic[0]?.content[0]).toMatchObject({ type: 'tool_result', content: imageDescriptor(REF) })
  })
})
