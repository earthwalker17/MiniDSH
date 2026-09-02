/**
 * `view_image` against a real composition: a real fs provider, a real
 * attachment store, a real agent, a real session log.
 *
 * The sharpest test here is the last one. It is not about images at all.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentHandle } from '../../core/agent/index.ts'
import { ATTACHMENTS } from '../../core/attachments/index.ts'
import { createUserMessage } from '../../core/llm/message.ts'
import { matches, TOOL_RESULT } from '../../core/session/index.ts'
import { quadPng } from '../../test-support/images.ts'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { assistantText, assistantToolCall } from '../../test-support/scripted-adapter.ts'
import { attachmentsLocalPlugin } from '../attachments-local/index.ts'
import { fsLocalPlugin } from '../fs-local/index.ts'
import { fsObservationPolicyPlugin } from '../fs-observation-policy/index.ts'
import { toolEditorPlugin } from '../tool-editor/index.ts'
import { sandboxPlugin } from '../../core/sandbox/index.ts'
import { toolViewImagePlugin } from './index.ts'

let harnesses: CoreHarness[] = []
let dirs: string[] = []

afterEach(async () => {
  for (const harness of harnesses.toReversed()) await harness.dispose()
  harnesses = []
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/**
 * A world with the image tool, the editor, a real fence and a real store. The
 * scripted adapter's modalities are what decides admission, exactly as a real
 * route's would.
 */
async function world(options: { vision: boolean; store?: boolean } = { vision: true }): Promise<{
  harness: CoreHarness
  cwd: string
  attachmentsRoot: string
  create: () => Promise<AgentHandle>
}> {
  const harness = await coreHarness()
  harnesses.push(harness)
  const cwd = tempDir('minidsh-viewimage-cwd-')
  const attachmentsRoot = tempDir('minidsh-viewimage-store-')
  if (options.vision) {
    const resolve = harness.adapter.resolveModel.bind(harness.adapter)
    harness.adapter.resolveModel = (model: string) => ({ ...resolve(model), inputModalities: ['text', 'image'] as const })
  }
  harness.root.plugin(sandboxPlugin, {})
  harness.root.plugin(fsLocalPlugin)
  harness.root.plugin(fsObservationPolicyPlugin)
  if (options.store !== false) harness.root.plugin(attachmentsLocalPlugin, { root: attachmentsRoot })
  harness.root.plugin(toolViewImagePlugin)
  harness.root.plugin(toolEditorPlugin, {})
  await harness.root.settle()
  return { harness, cwd, attachmentsRoot, create: () => harness.create({ cwd }) }
}

function resultOf(handle: AgentHandle): { content: readonly { type: string }[]; error?: { code: string } } {
  const event = handle.agent.session.facts.find((candidate) => matches(candidate, TOOL_RESULT))
  if (!event || !matches(event, TOOL_RESULT)) throw new Error('no tool/result in the log')
  const block = event.data.message.content[0]
  return { content: block && block.type === 'tool-result' ? block.content : [], ...(event.data.error ? { error: event.data.error } : {}) }
}

async function runViewImage(handle: AgentHandle, harness: CoreHarness, path: string): Promise<void> {
  harness.adapter.script(assistantToolCall('c1', 'view_image', { path }), assistantText('done'))
  handle.agent.followup(createUserMessage('look'))
  await handle.agent.whenIdle()
}

describe('view_image', () => {
  it('commits the bytes durably and answers with an image block naming them', async () => {
    const { harness, cwd, attachmentsRoot, create } = await world()
    const png = quadPng(96)
    writeFileSync(join(cwd, 'quad.png'), png)
    const handle = await create()
    await runViewImage(handle, harness, 'quad.png')

    const result = resultOf(handle)
    expect(result.error).toBeUndefined()
    expect(result.content.map((block) => block.type)).toEqual(['image'])
    const image = result.content[0] as unknown as { attachment: { id: string; width: number; name?: string }; text: string }
    // The binding assertion: the id addresses the SOURCE file, not whatever the
    // store happened to write.
    expect(image.attachment.id).toBe(`sha256:${createHash('sha256').update(png).digest('hex')}`)
    expect(image.attachment.width).toBe(96)
    expect(image.text).toContain('96×96')

    const stored = harness.root.get(ATTACHMENTS).hostPath(image.attachment as never)!
    expect(readFileSync(stored).equals(png)).toBe(true)
    expect(attachmentsRoot).toBeTruthy()
    // Bytes never enter the log.
    expect(JSON.stringify(handle.agent.session.events)).not.toContain(png.toString('base64').slice(0, 32))
  })

  /**
   * The refusal that makes delegation the model's own answer. It is decided from
   * the route the STEP is on, before any file is touched.
   */
  it('refuses on a text-only route, naming delegation, before it reads anything', async () => {
    const { harness, cwd, create } = await world({ vision: false })
    writeFileSync(join(cwd, 'quad.png'), quadPng(96))
    const handle = await create()
    await runViewImage(handle, harness, 'quad.png')
    const result = resultOf(handle)
    expect(result.error?.code).toBe('UNSUPPORTED_CONTENT')
    const text = result.content.map((block) => (block as { text?: string }).text ?? '').join('')
    expect(text).toContain('cannot accept images')
    expect(text).toContain('Delegate')
  })

  it('refuses when the deployment stores no attachments', async () => {
    const { harness, cwd, create } = await world({ vision: true, store: false })
    writeFileSync(join(cwd, 'quad.png'), quadPng(96))
    const handle = await create()
    await runViewImage(handle, harness, 'quad.png')
    expect(resultOf(handle).error?.code).toBe('UNSUPPORTED_CONTENT')
  })

  it('reports a file that is not an image as an admission error the caller can act on', async () => {
    const { harness, cwd, create } = await world()
    writeFileSync(join(cwd, 'notes.txt'), 'plain text')
    const handle = await create()
    await runViewImage(handle, harness, 'notes.txt')
    expect(resultOf(handle).error?.code).toBe('INVALID_IMAGE')
  })

  /**
   * THE test in this file, and it is not about images.
   *
   * `fs-observation-policy` keys its map by path alone. If `readBytes` emitted
   * `fs/observed`, calling `view_image` on a source file would hand the model a
   * read-before-edit token for content it has never been shown — and the very
   * next `str_replace_editor` overwrite of that path would be authorised by it.
   * The policy's whole premise is that an edit is safe because the model saw
   * this version; a byte read must not be able to satisfy it.
   */
  it('does not license a blind overwrite of a file it read as bytes', async () => {
    const { harness, cwd, create } = await world()
    const secret = join(cwd, 'app.ts')
    writeFileSync(secret, 'export const answer = 42\n')
    const handle = await create()

    harness.adapter.script(
      assistantToolCall('c1', 'view_image', { path: 'app.ts' }),
      assistantToolCall('c2', 'str_replace_editor', { command: 'str_replace', path: 'app.ts', old_str: 'export const answer = 42', new_str: 'export const answer = 0' }),
      assistantText('done'),
    )
    handle.agent.followup(createUserMessage('go'))
    await handle.agent.whenIdle()

    const results = handle.agent.session.facts.filter((event) => matches(event, TOOL_RESULT))
    // The image read failed (it is not an image) — and, crucially, it recorded
    // no observation, so the edit that followed is refused for not having read
    // the file rather than being let through.
    expect(results).toHaveLength(2)
    const edit = results[1]!
    expect(matches(edit, TOOL_RESULT) && edit.data.error?.code).toBe('FS_NOT_OBSERVED')
    expect(readFileSync(secret, 'utf8')).toBe('export const answer = 42\n')
  })

  /**
   * The bound counts OCCURRENCES, and this is the test that says why.
   *
   * The store is content-addressed, so viewing one file five times yields five
   * image blocks carrying ONE id. A bound that counted distinct attachments
   * would see a single image while the request carried five full base64
   * copies — reproduced during the review: the bound said 1, the wire carried
   * 5 — which is exactly the unrecoverable wedge the bound exists to prevent,
   * since the provider answers a code nothing retries and nothing compacts.
   */
  it('bounds a repeat of the SAME image, which content addressing would otherwise make free', async () => {
    const { harness, cwd, create } = await world()
    writeFileSync(join(cwd, 'same.png'), quadPng(64))
    const handle = await create()
    harness.adapter.script(...[0, 1, 2, 3, 4].map((index) => assistantToolCall(`c${index}`, 'view_image', { path: 'same.png' })), assistantText('done'))
    handle.agent.followup(createUserMessage('look at it again and again'))
    await handle.agent.whenIdle()
    const codes = handle.agent.session.facts.filter((event) => matches(event, TOOL_RESULT)).map((event) => (matches(event, TOOL_RESULT) ? event.data.error?.code : undefined))
    expect(codes.slice(0, 4), `the first four repeats must be admitted; got ${JSON.stringify(codes)}`).toEqual([undefined, undefined, undefined, undefined])
    expect(codes[4], 'the fifth copy of one image is still a fifth image on the wire').toBe('TOO_MANY_IMAGES')
  })

  it('bounds how many images one request may carry, because a per-message count never binds', async () => {
    const { harness, cwd, create } = await world()
    // Four distinct images is the shipped per-request cap; the fifth is refused.
    for (let index = 0; index < 5; index++) writeFileSync(join(cwd, `q${index}.png`), quadPng(16 + index * 8))
    const handle = await create()
    harness.adapter.script(
      ...[0, 1, 2, 3, 4].map((index) => assistantToolCall(`c${index}`, 'view_image', { path: `q${index}.png` })),
      assistantText('done'),
    )
    handle.agent.followup(createUserMessage('look at them all'))
    await handle.agent.whenIdle()
    const codes = handle.agent.session.facts.filter((event) => matches(event, TOOL_RESULT)).map((event) => (matches(event, TOOL_RESULT) ? event.data.error?.code : undefined))
    expect(codes.slice(0, 4)).toEqual([undefined, undefined, undefined, undefined])
    expect(codes[4]).toBe('TOO_MANY_IMAGES')
  })
})
