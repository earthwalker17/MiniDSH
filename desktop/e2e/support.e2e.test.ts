/**
 * What the two desktop E2E files stand on, held without the app: each helper
 * here decides what a wait or a verdict in those files MEANS, and each was
 * wrong in a way no run of the app showed.
 *
 *   - `storedEvents` read a delegated child's log with its parent's, so a
 *     child's `turn/end` ended a wait for the person's turn;
 *   - the live arc judged the agent's fix with the test file in the folder the
 *     agent was working in, which the agent may rewrite (`judgeSlug`);
 *   - a close "during the start" was sent on the hope the runtime was still
 *     booting (`holdRuntimeStart` makes it so).
 *
 * Keyless and always on, like expect-keys.e2e.test.ts: it launches nothing
 * and calls no one.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { holdRuntimeStart, judgeSlug, storedEvents, turnEnds } from './support.ts'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
const scratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A stored log as the runtime writes one: a header line, then events. */
function log(home: string, id: string, header: Record<string, unknown>, events: readonly { type: string; data: unknown }[]): void {
  mkdirSync(join(home, 'sessions'), { recursive: true })
  const lines = [JSON.stringify({ kind: 'session', version: 0, id, createdAt: 1, cwd: '/w', ...header }), ...events.map((event, seq) => JSON.stringify({ seq, time: 1, ...event }))]
  writeFileSync(join(home, 'sessions', `${id}.jsonl`), `${lines.join('\n')}\n`)
}

describe('storedEvents', () => {
  it('reads the person’s sessions and not a delegated child’s: a child that finished is not the turn that delegated it', () => {
    const home = scratch('minidsh-e2e-support-home-')
    // The parent's turn is still running when its child's has ended.
    log(home, 'session-parent', {}, [{ type: 'turn/start', data: { turn: 1 } }, { type: 'subagent/start', data: { childId: 'session-child' } }])
    log(home, 'session-child', { delegatedBy: 'session-parent', delegationDepth: 1 }, [{ type: 'turn/start', data: { turn: 1 } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }])
    expect(turnEnds(home), 'the child’s end was read as the person’s turn ending').toEqual([])
    expect(storedEvents(home).map((event) => event.type)).toEqual(['turn/start', 'subagent/start'])
    // Once the parent's own turn ends, that is the one end there is.
    log(home, 'session-parent', {}, [{ type: 'turn/start', data: { turn: 1 } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'cancelled' } } }])
    expect(turnEnds(home)).toEqual(['cancelled'])
  })

  it('reads nothing from a home with no sessions yet, and survives a torn last line', () => {
    const home = scratch('minidsh-e2e-support-home-')
    expect(storedEvents(home)).toEqual([])
    log(home, 'session-a', {}, [{ type: 'turn/start', data: { turn: 1 } }])
    writeFileSync(join(home, 'sessions', 'session-a.jsonl'), `${readFileSync(join(home, 'sessions', 'session-a.jsonl'), 'utf8')}{"type":"turn/e`)
    expect(storedEvents(home).map((event) => event.type)).toEqual(['turn/start'])
  })
})

describe('judgeSlug', () => {
  const TEST = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { slugify } from './slug.mjs'\n\ntest('lowercases', () => {\n  assert.equal(slugify('Hello World'), 'hello-world')\n})\n"
  const BROKEN = "export function slugify(title) {\n  return title.split(' ').join('-')\n}\n"
  const FIXED = "export function slugify(title) {\n  return title.trim().toLowerCase().split(/\\s+/).join('-')\n}\n"

  it('judges the module with its own test, whatever the workspace’s test file has been made to say', { timeout: 120_000 }, () => {
    const workspace = scratch('minidsh-e2e-support-ws-')
    const judge = scratch('minidsh-e2e-support-judge-')
    writeFileSync(join(workspace, 'package.json'), '{ "type": "module" }\n')
    writeFileSync(join(workspace, 'slug.mjs'), BROKEN)
    // The agent's shortcut: the folder's own test rewritten to pass on the broken module.
    writeFileSync(join(workspace, 'slug.test.mjs'), "import { test } from 'node:test'\ntest('passes', () => {})\n")
    const cheated = judgeSlug(workspace, judge, TEST)
    expect(cheated.pass, `the judge passed a module that does not lowercase:\n${cheated.output}`).toBe(false)
    writeFileSync(join(workspace, 'slug.mjs'), FIXED)
    const fixed = judgeSlug(workspace, judge, TEST)
    expect(fixed.pass, fixed.output).toBe(true)
    // And the judge wrote nothing into the folder the agent works in.
    expect(readFileSync(join(workspace, 'slug.test.mjs'), 'utf8')).toContain("test('passes'")
  })

  it('fails a workspace whose module is gone, rather than passing on a folder with nothing to test', () => {
    const workspace = scratch('minidsh-e2e-support-ws-')
    expect(judgeSlug(workspace, scratch('minidsh-e2e-support-judge-'), TEST)).toMatchObject({ pass: false, output: expect.stringContaining('is gone') as string })
  })
})

describe('holdRuntimeStart', () => {
  it('writes a composition whose one inserted plugin does not finish applying until the release file exists', async () => {
    const home = scratch('minidsh-e2e-support-home-')
    const release = holdRuntimeStart(home)
    const composition = JSON.parse(readFileSync(join(home, 'composition.json'), 'utf8')) as { patches: { insert: { id: string; plugin: string }[] }[] }
    const row = composition.patches[0]!.insert[0]!
    expect(row.id).toBe('e2e-hold-runtime-start')
    const plugin = ((await import(pathToFileURL(row.plugin).href)) as { default: { name: string; apply(): Promise<void> } }).default
    expect(plugin.name).toBe(row.id)
    // The plugin's own clock is in this test's hands, so "however long it
    // waits" is a number and not a sleep: a minute of polling with no release
    // file, and it has not applied; the file written, one poll later it has.
    vi.useFakeTimers()
    try {
      let applied = false
      const applying = plugin.apply().then(() => {
        applied = true
      })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(applied, 'the plugin applied with nothing releasing it').toBe(false)
      writeFileSync(release, '')
      await vi.advanceTimersByTimeAsync(100)
      await applying
      expect(applied).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
