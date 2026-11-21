/**
 * The prompt registry's interpolation rule: a string section is a template, a
 * function section returns finished text. The scope rules (who sees which
 * section or variable) are `core/scope.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { coreHarness, type CoreHarness } from '../../test-support/harness.ts'
import { assistantText } from '../../test-support/scripted-adapter.ts'
import { createUserMessage } from '../llm/message.ts'
import { TURN_END, matches } from '../session/index.ts'
import { PROMPT } from './index.ts'

let harness: CoreHarness | undefined
afterEach(async () => {
  await harness?.dispose()
  harness = undefined
})

describe('prompt interpolation', () => {
  it('resolves a variable in a string template, and fails the assemble on one nobody registered', async () => {
    harness = await coreHarness()
    const prompt = harness.root.get(PROMPT)
    prompt.variable(harness.root, 'who', () => 'everyone')
    const greeting = prompt.section(harness.root, { name: 'greeting', order: 10, text: 'hello {{who}}' })
    expect((await prompt.assemble()).system).toBe('You are a test agent.\n\nhello everyone')

    // Strict: a typo in a template is an error at assembly, never text the model reads.
    greeting()
    prompt.section(harness.root, { name: 'typo', order: 10, text: 'hello {{whom}}' })
    await expect(prompt.assemble()).rejects.toThrowError('unknown prompt variable "whom"')
  })

  it('takes what a function section returns as finished text, braces and all', async () => {
    harness = await coreHarness()
    const prompt = harness.root.get(PROMPT)
    prompt.variable(harness.root, 'who', () => 'everyone')
    // Neither an unknown name nor a registered one is read out of rendered text.
    prompt.section(harness.root, { name: 'rendered', order: 10, text: () => 'cwd: /work/templates/{{name}} for {{who}}' })
    expect((await prompt.assemble()).system).toBe('You are a test agent.\n\ncwd: /work/templates/{{name}} for {{who}}')
  })

  // The shape that reached a person: the default runtime-context section
  // renders the working directory, and a workspace such as `templates/{{name}}`
  // failed every step before any request, LOOP_FAILED, naming a variable.
  it('runs a turn in a workspace whose path looks like a template variable', async () => {
    harness = await coreHarness()
    const cwd = join(tmpdir(), 'templates', '{{name}}')
    harness.root.get(PROMPT).section(harness.root, { name: 'where', order: 10, text: (agent) => `Working directory: ${agent?.session.header.cwd ?? ''}` })
    harness.adapter.script(assistantText('ok'))
    const { agent } = await harness.create({ cwd })
    agent.followup(createUserMessage('hi'))
    await agent.whenIdle()
    const ends = agent.session.events.filter((event) => matches(event, TURN_END)).map((event) => (matches(event, TURN_END) ? event.data.reason : undefined))
    expect(ends).toEqual([{ kind: 'completed' }])
    expect(harness.adapter.calls.map((call) => call.system)).toEqual([`You are a test agent.\n\nWorking directory: ${cwd}`])
  })
})
