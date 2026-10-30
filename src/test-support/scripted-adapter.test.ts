import { describe, expect, it } from 'vitest'
import type { LlmRequest, StreamChunk } from '../core/llm/index.ts'
import { createUserMessage, messageText } from '../core/llm/message.ts'
import { assistantText, ScriptedAdapter } from './scripted-adapter.ts'

const request = (task: string): LlmRequest => ({ provider: 'scripted', model: 'scripted-model', messages: [createUserMessage(task)] })
const asks = (task: string) => (candidate: LlmRequest) => messageText(candidate.messages[0]!) === task

async function answer(adapter: ScriptedAdapter, task: string): Promise<string> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(request(task))) chunks.push(chunk)
  return chunks.flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.text] : [])).join('')
}

describe('ScriptedAdapter.scriptWhen', () => {
  it('serves each matching request its own queue, whatever order they ask in, and the rest from the shared one', async () => {
    const adapter = new ScriptedAdapter()
      .scriptWhen(asks('task A'), assistantText('A1'), assistantText('A2'))
      .scriptWhen(asks('task B'), assistantText('B1'))
      .script(assistantText('shared 1'), assistantText('shared 2'))
    expect(await answer(adapter, 'task B')).toBe('B1')
    expect(await answer(adapter, 'task A')).toBe('A1')
    expect(await answer(adapter, 'parent')).toBe('shared 1')
    expect(await answer(adapter, 'task A')).toBe('A2')
    // A matching queue that has run dry falls through to the shared one.
    expect(await answer(adapter, 'task B')).toBe('shared 2')
    await expect(answer(adapter, 'task A')).rejects.toThrow(/no scripted response remaining/)
    expect(adapter.calls.map((call) => messageText(call.messages[0]!))).toEqual(['task B', 'task A', 'parent', 'task A', 'task B', 'task A'])
  })

  it('answers from the first registered queue that matches', async () => {
    const adapter = new ScriptedAdapter().scriptWhen(() => true, assistantText('first')).scriptWhen(asks('task A'), assistantText('second'))
    expect(await answer(adapter, 'task A')).toBe('first')
    expect(await answer(adapter, 'task A')).toBe('second')
  })
})
