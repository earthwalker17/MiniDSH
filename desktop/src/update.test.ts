import { describe, expect, it } from 'vitest'
import type { FetchLike } from './runtime.ts'
import { checkForUpdate, compareVersions, LATEST_RELEASE_API, parseLatestRelease } from './update.ts'

const release = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  tag_name: 'v1.3.0',
  html_url: 'https://github.com/earthwalker17/MiniDSH/releases/tag/v1.3.0',
  draft: false,
  prerelease: false,
  ...overrides,
})

function answering(response: Response | Error): { fetch: FetchLike; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      if (response instanceof Error) throw response
      return response
    },
  }
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

describe('version comparison', () => {
  it('orders x.y.z numerically, not as text', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0)
    expect(compareVersions('v1.2.0', '1.2.1')).toBe(-1)
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1)
  })

  it('sorts a prerelease below its release, and prereleases by semver precedence', () => {
    expect(compareVersions('1.3.0-rc.1', '1.3.0')).toBe(-1)
    expect(compareVersions('1.3.0', '1.3.0-rc.1')).toBe(1)
    expect(compareVersions('1.3.0-rc.1', '1.2.9')).toBe(1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1)
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1)
    expect(compareVersions('1.0.0-beta', '1.0.0-alpha')).toBe(1)
    expect(compareVersions('1.0.0+build.5', '1.0.0')).toBe(0)
  })

  it('throws on anything that is not a version', () => {
    for (const bad of ['1.2', '1.2.3.4', 'latest', '', 'v', '1.2.x']) expect(() => compareVersions(bad, '1.0.0')).toThrow(TypeError)
  })
})

describe('the latest release', () => {
  it('reads the tag and the release page', () => {
    expect(parseLatestRelease(release())).toEqual({ version: '1.3.0', url: 'https://github.com/earthwalker17/MiniDSH/releases/tag/v1.3.0' })
  })

  it('acts only on a vX.Y.Z tag whose page is this repository releases', () => {
    for (const overrides of [
      { tag_name: '1.3.0' },
      { tag_name: 'v1.3' },
      { tag_name: 'v1.3.0-rc.1' },
      { tag_name: 7 },
      { html_url: 'http://github.com/earthwalker17/MiniDSH/releases/tag/v1.3.0' },
      { html_url: 'https://github.com/someone/MiniDSH/releases/tag/v1.3.0' },
      { html_url: 'https://github.com/earthwalker17/MiniDSH/releases/../../../evil/x' },
      { html_url: 'https://github.com/earthwalker17/MiniDSH/releasesX/tag/v1.3.0' },
      { html_url: 'https://github.com.evil.example/earthwalker17/MiniDSH/releases/' },
      { html_url: undefined },
      { draft: true },
      { prerelease: true },
    ]) {
      expect(parseLatestRelease(release(overrides)), JSON.stringify(overrides)).toBeUndefined()
    }
    for (const bad of [null, [], 'v1.3.0', 3]) expect(parseLatestRelease(bad)).toBeUndefined()
  })
})

describe('the update check', () => {
  it('asks the GitHub API with its User-Agent, Accept and a deadline', async () => {
    const fake = answering(json(release()))
    expect(await checkForUpdate({ current: '1.2.0', fetchImpl: fake.fetch })).toEqual({ kind: 'newer', version: '1.3.0', url: 'https://github.com/earthwalker17/MiniDSH/releases/tag/v1.3.0' })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]!.url).toBe(LATEST_RELEASE_API)
    expect(fake.calls[0]!.url).toBe('https://api.github.com/repos/earthwalker17/MiniDSH/releases/latest')
    expect(fake.calls[0]!.init.headers).toEqual({ 'User-Agent': 'MiniDSH-Desktop', Accept: 'application/vnd.github+json' })
    expect(fake.calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('is current when the latest is the same or older, a prerelease build included', async () => {
    expect(await checkForUpdate({ current: '1.3.0', fetchImpl: answering(json(release())).fetch })).toEqual({ kind: 'current' })
    expect(await checkForUpdate({ current: '1.4.0', fetchImpl: answering(json(release())).fetch })).toEqual({ kind: 'current' })
    expect(await checkForUpdate({ current: '1.3.0-rc.1', fetchImpl: answering(json(release())).fetch })).toMatchObject({ kind: 'newer', version: '1.3.0' })
  })

  it('reports every failure as an error with a short message, never a throw', async () => {
    const cases: [Response | Error, RegExp][] = [
      [new Error('getaddrinfo ENOTFOUND'), /could not be reached/],
      [json({ message: 'Not Found' }, 404), /No release/],
      [json({ message: 'rate limit' }, 403), /403 \(rate limited/],
      [json({}, 500), /answered 500/],
      [new Response('<html>', { status: 200 }), /not understood/],
      [json(release({ html_url: 'https://evil.example/' })), /not understood/],
    ]
    for (const [response, message] of cases) {
      const result = await checkForUpdate({ current: '1.2.0', fetchImpl: answering(response).fetch })
      expect(result.kind).toBe('error')
      expect(result.kind === 'error' ? result.message : '').toMatch(message)
    }
    expect(await checkForUpdate({ current: 'dev', fetchImpl: answering(json(release())).fetch })).toMatchObject({ kind: 'error', message: expect.stringMatching(/not comparable/) })
  })
})
