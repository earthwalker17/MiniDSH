/**
 * Pins that live in more than one file and must agree. Each is a place where
 * a release could otherwise go out with two answers to one question, and each
 * was found by reading, never by a failure (S22.5): the workflows named one
 * Node and `.nvmrc` another; an installer's name was spelled in the packer, in
 * two workflows' globs and in the README.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')
const workflows = readdirSync(join(ROOT, '.github', 'workflows')).filter((name) => /\.ya?ml$/.test(name))

describe('release pins', () => {
  const nvmrc = read('.nvmrc').trim()

  it('every workflow, and the action they share, sets up the Node .nvmrc names', () => {
    expect(nvmrc).toMatch(/^\d+\.\d+\.\d+$/)
    const actions = readdirSync(join(ROOT, '.github', 'actions')).map((name) => `.github/actions/${name}/action.yml`)
    const files = [...workflows.map((name) => `.github/workflows/${name}`), ...actions]
    const pins = files.flatMap((file) => [...read(file).matchAll(/runtime:\s*node@(\S+)/g)].map((match) => ({ file, version: match[1] })))
    // Every one of them sets a runtime up at least once, or this would compare nothing.
    expect(new Set(pins.map((pin) => pin.file)).size, `files with a runtime pin: ${pins.map((pin) => pin.file).join(', ')}`).toBe(files.length)
    expect(pins.filter((pin) => pin.version !== nvmrc)).toEqual([])
    // setup-node, where it is used, reads the file itself: never a second literal.
    for (const file of files) expect(read(file), file).not.toMatch(/node-version:\s*['"]?\d/)
  })

  it('the gate runs on the Node the desktop app bundles, and the live desktop test expects that one', () => {
    const packer = read('desktop/scripts/package.ts')
    const bundled = /const NODE_VERSION = '([^']+)'/.exec(packer)?.[1]
    expect(bundled).toBe(nvmrc)
    expect(/const BUNDLED_NODE = 'v([^']+)'/.exec(read('desktop/e2e/live.e2e.test.ts'))?.[1]).toBe(bundled)
  })

  it('the installers have one name each, with no version in it, and a pinned Node for each platform', () => {
    const installers = (JSON.parse(read('desktop/release-assets.json')) as { installers: Record<string, string> }).installers
    const names = Object.values(installers)
    expect(names.length).toBeGreaterThanOrEqual(4)
    expect(new Set(names).size).toBe(names.length)
    // `releases/latest/download/<name>` needs a name that survives a release.
    for (const name of names) expect(name, name).not.toMatch(/\d+\.\d+\.\d+/)
    const packer = read('desktop/scripts/package.ts')
    const pinned = [...packer.matchAll(/'((?:win32|linux|darwin)-(?:x64|arm64))': '[0-9a-f]{64}'/g)].map((match) => match[1])
    expect(pinned.toSorted()).toEqual(Object.keys(installers).toSorted())
  })

  it('every desktop platform in the list is a leg of both workflows that build it', () => {
    const installers = (JSON.parse(read('desktop/release-assets.json')) as { installers: Record<string, string> }).installers
    // One runner label per platform key; the Intel label is an image GitHub will retire (ARCHITECTURE §13).
    const runner: Record<string, string> = { 'win32-x64': 'windows-latest', 'linux-x64': 'ubuntu-latest', 'darwin-arm64': 'macos-latest', 'darwin-x64': 'macos-15-intel' }
    expect(Object.keys(runner).toSorted()).toEqual(Object.keys(installers).toSorted())
    for (const name of ['check.yml', 'release.yml']) {
      const text = read(`.github/workflows/${name}`)
      // The desktop job's matrix, the one that names the Intel image.
      const matrix = /os: \[([^\]]*macos-15-intel[^\]]*)\]/.exec(text)?.[1]
      expect(matrix, `${name} has no desktop matrix naming every platform`).toBeDefined()
      for (const label of Object.values(runner)) expect(matrix, `${name}: ${label}`).toContain(label)
      expect(text, `${name} must run the shared desktop leg`).toContain('uses: ./.github/actions/desktop-leg')
    }
  })
})
