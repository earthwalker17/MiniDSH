/**
 * `app/home.ts` alone resolves the home (ARCHITECTURE §9), and what it hands
 * to plugins is absolute: a relative path is read by each consumer against
 * its own base, and the global `AGENTS.md` was then read from the SESSION's
 * cwd — a repository could supply the user's global instructions (S20.5).
 */
import { isAbsolute, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { homeLayout, resolveHome } from './home.ts'

const saved = process.env.MINIDSH_HOME
afterEach(() => {
  if (saved === undefined) delete process.env.MINIDSH_HOME
  else process.env.MINIDSH_HOME = saved
})

describe('the home layout', () => {
  it('is absolute in every field under a RELATIVE MINIDSH_HOME, resolved against the process cwd once', () => {
    process.env.MINIDSH_HOME = join('rel-home', 'nested')
    expect(resolveHome()).toBe(resolve('rel-home', 'nested'))
    const layout = homeLayout()
    for (const [field, value] of Object.entries(layout)) {
      if (typeof value === 'string') expect(isAbsolute(value), `${field}: ${value}`).toBe(true)
    }
    expect(layout.globalInstructionsPath).toBe(join(resolve('rel-home', 'nested'), 'AGENTS.md'))
    for (const root of layout.skillRoots) expect(isAbsolute(root.path), root.path).toBe(true)
  })
})
