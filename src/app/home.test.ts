/**
 * `app/home.ts` alone resolves the home (ARCHITECTURE §9), and what it hands
 * to plugins is absolute: a relative path is read by each consumer against
 * its own base, and the global `AGENTS.md` was then read from the SESSION's
 * cwd — a repository could supply the user's global instructions (S20.5).
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPath } from '../core/sandbox/paths.ts'
import { homeLayout, installRoots, resolveHome } from './home.ts'

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
    // Every path the layout carries, by name: a field added to it has to be
    // put in one of these lists, so none goes unchecked by being skipped.
    const paths: Record<string, string> = {
      sessionsRoot: layout.sessionsRoot,
      spillRoot: layout.spillRoot,
      attachmentsRoot: layout.attachmentsRoot,
      browserProfileRoot: layout.browserProfileRoot,
      globalInstructionsPath: layout.globalInstructionsPath,
      credentialsPath: layout.credentialsPath,
      settingsStorePath: layout.settingsStorePath,
    }
    expect(Object.keys(layout).toSorted()).toEqual([...Object.keys(paths), 'skillRoots', 'installRoots'].toSorted())
    for (const [field, value] of Object.entries(paths)) {
      expect(isAbsolute(value), `${field}: ${value}`).toBe(true)
      // Under the home, each one: the relative spelling resolved once, for all.
      expect(value.startsWith(resolve('rel-home', 'nested')), `${field}: ${value}`).toBe(true)
    }
    expect(layout.globalInstructionsPath).toBe(join(resolve('rel-home', 'nested'), 'AGENTS.md'))
    // The user's root, then the bundled one.
    expect(layout.skillRoots.map((root) => root.origin)).toEqual(['user', 'bundled'])
    for (const root of layout.skillRoots) expect(isAbsolute(root.path), root.path).toBe(true)
    expect(layout.skillRoots[0]!.path).toBe(resolve('rel-home', 'nested', 'skills'))
  })

  it('falls back to ~/.minidsh when MINIDSH_HOME is unset or empty', () => {
    const fallback = join(homedir(), '.minidsh')
    delete process.env.MINIDSH_HOME
    expect(resolveHome()).toBe(fallback)
    // Empty is unset, never the process's own directory.
    process.env.MINIDSH_HOME = ''
    expect(resolveHome()).toBe(fallback)
    expect(homeLayout().sessionsRoot).toBe(join(fallback, 'sessions'))
  })

  /**
   * What the shell row is given to keep readable under a confinement profile
   * that hides part of the filesystem (the Linux AppImage mounts both under
   * the `/tmp` bubblewrap makes private).
   */
  it('names the runtime\'s own install directories: the package root that holds the bundled skills, and the running Node\'s', () => {
    const roots = installRoots()
    for (const root of roots) expect(isAbsolute(root), root).toBe(true)
    const bundled = homeLayout().skillRoots.find((root) => root.origin === 'bundled')!.path
    // The bundled skills are found from the same anchor, so they are INSIDE the first root.
    expect(roots[0]).toBe(dirname(bundled))
    expect(existsSync(join(roots[0]!, 'skills', 'office', 'SKILL.md')), `no bundled skill under ${roots[0]}`).toBe(true)
    expect(roots).toContain(canonicalPath(dirname(process.execPath)))
    expect(new Set(roots).size, roots.join(', ')).toBe(roots.length)
    expect(homeLayout().installRoots).toEqual(roots)
  })
})
