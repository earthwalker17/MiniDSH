/**
 * Image admission, the rule every producer asks before it reads or captures a
 * byte. Exercised through a real agent and real logs: the route is the one the
 * STEP recorded, and the surface fold reads what `view_image` really appended.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { attachmentsLocalPlugin } from '../../capabilities/attachments-local/index.ts'
import { fsLocalPlugin } from '../../capabilities/fs-local/index.ts'
import { toolViewImagePlugin } from '../../capabilities/tool-view-image/index.ts'
import { quadPng } from '../../test-support/images.ts'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { assistantText, assistantToolCall } from '../../test-support/scripted-adapter.ts'
import type { ImageLimits } from '../attachments/index.ts'
import { assertImageFits, assertImageRoom, assertRouteTakesImages, imagesOnSurface, routeTakesImages } from './admission.ts'
import { createUserMessage } from './message.ts'
import { LLM } from './runtime.ts'

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

async function world(vision: boolean): Promise<{ harness: CoreHarness; cwd: string }> {
  const harness = await coreHarness()
  harnesses.push(harness)
  if (vision) {
    const resolve = harness.adapter.resolveModel.bind(harness.adapter)
    harness.adapter.resolveModel = (model: string) => ({ ...resolve(model), inputModalities: ['text', 'image'] as const })
  }
  harness.root.plugin(fsLocalPlugin)
  harness.root.plugin(attachmentsLocalPlugin, { root: tempDir('minidsh-admission-store-') })
  harness.root.plugin(toolViewImagePlugin)
  expect((await harness.root.settle()).failed).toEqual([])
  return { harness, cwd: tempDir('minidsh-admission-cwd-') }
}

const LIMITS: ImageLimits = {
  maxImageBytes: 10_000,
  maxImageDimension: 8000,
  maxImagePixels: 20_000_000,
  maxImagesPerRequest: 2,
  maxRequestImageBytes: 15_000,
  mediaTypes: ['image/png'],
}

describe('image admission', () => {
  it('reads the route the STEP recorded, and refuses a route nothing recorded', async () => {
    const { harness, cwd } = await world(true)
    const { agent } = await harness.create({ cwd })
    const llm = harness.root.get(LLM)
    // No step has opened, so no `request/context` names a route yet.
    expect(routeTakesImages(llm, agent)).toEqual({ ok: false, route: 'an unrecorded route' })
    harness.adapter.script(assistantText('hello'))
    agent.followup(createUserMessage('hi'))
    await agent.whenIdle()
    expect(routeTakesImages(llm, agent)).toEqual({ ok: true, route: 'scripted/scripted-model' })
  })

  it('refuses a text-only route with a code a model can route on, naming delegation', async () => {
    const { harness, cwd } = await world(false)
    const { agent } = await harness.create({ cwd })
    harness.adapter.script(assistantText('hello'))
    agent.followup(createUserMessage('hi'))
    await agent.whenIdle()
    let caught: unknown
    try {
      assertRouteTakesImages(harness.root.get(LLM), agent)
    } catch (error) {
      caught = error
    }
    expect((caught as { code?: string }).code).toBe('UNSUPPORTED_CONTENT')
    expect(String(caught)).toContain('Delegate the look to a subagent')
  })

  it('counts every image occurrence on the surface, and bounds count and bytes from it', async () => {
    const { harness, cwd } = await world(true)
    const png = quadPng(64)
    writeFileSync(join(cwd, 'q.png'), png)
    const { agent } = await harness.create({ cwd })
    // The same file twice: one stored object, two wire images.
    harness.adapter.script(assistantToolCall('c1', 'view_image', { path: 'q.png' }), assistantToolCall('c2', 'view_image', { path: 'q.png' }), assistantText('seen'))
    agent.followup(createUserMessage('look twice'))
    await agent.whenIdle()

    expect(imagesOnSurface(agent.session)).toEqual({ count: 2, bytes: 2 * png.length })
    expect(() => assertImageRoom(agent.session, LIMITS)).toThrow(/A subagent starts with a conversation of its own/)
    expect(() => assertImageRoom(agent.session, { ...LIMITS, maxImagesPerRequest: 3 })).not.toThrow()

    const fits = (byteLength: number, limits: ImageLimits = LIMITS): string | undefined => {
      try {
        assertImageFits(agent.session, limits, byteLength, 'this screenshot')
        return undefined
      } catch (error) {
        return (error as { code: string }).code
      }
    }
    expect(fits(LIMITS.maxImageBytes + 1)).toBe('IMAGE_TOO_LARGE')
    // Alone it fits (the per-image bound raised out of the way); beside what the
    // request already carries it does not.
    const roomy = { ...LIMITS, maxImageBytes: LIMITS.maxRequestImageBytes }
    expect(fits(LIMITS.maxRequestImageBytes - 2 * png.length + 1, roomy)).toBe('IMAGE_TOO_LARGE')
    expect(fits(LIMITS.maxRequestImageBytes - 2 * png.length, roomy)).toBeUndefined()
  })
})
