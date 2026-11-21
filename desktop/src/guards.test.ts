import { describe, expect, it } from 'vitest'
import { exemptLoopbackFromProxy, runtimeEnv } from './env.ts'
import { externalUrl, isHostUrl } from './guards.ts'

describe('the host URL rule', () => {
  it('admits the live runtime\'s own http and ws origin, exactly', () => {
    expect(isHostUrl('http://127.0.0.1:31000/', 31_000)).toBe(true)
    expect(isHostUrl('http://127.0.0.1:31000/app.js?x=1', 31_000)).toBe(true)
    expect(isHostUrl('ws://127.0.0.1:31000/ws', 31_000)).toBe(true)
    expect(isHostUrl('HTTP://127.0.0.1:31000/', 31_000)).toBe(true)
  })

  it('refuses everything else: another port, another spelling, user info, https, wss, no runtime', () => {
    expect(isHostUrl('http://127.0.0.1:31001/', 31_000)).toBe(false)
    expect(isHostUrl('ws://127.0.0.1:31001/ws', 31_000)).toBe(false)
    expect(isHostUrl('http://localhost:31000/', 31_000)).toBe(false)
    expect(isHostUrl('http://[::1]:31000/', 31_000)).toBe(false)
    expect(isHostUrl('http://127.0.0.1:31000@evil.example/', 31_000)).toBe(false)
    expect(isHostUrl('http://user:pass@127.0.0.1:31000/', 31_000)).toBe(false)
    expect(isHostUrl('https://127.0.0.1:31000/', 31_000)).toBe(false)
    expect(isHostUrl('wss://127.0.0.1:31000/ws', 31_000)).toBe(false)
    expect(isHostUrl('file:///C:/evil.html', 31_000)).toBe(false)
    expect(isHostUrl('not a url', 31_000)).toBe(false)
    expect(isHostUrl('http://127.0.0.1:31000/', undefined)).toBe(false)
  })
})

describe('what may be handed to the OS', () => {
  it('passes http, https and mailto, normalized', () => {
    expect(externalUrl('https://github.com/earthwalker17/MiniDSH')).toBe('https://github.com/earthwalker17/MiniDSH')
    expect(externalUrl('HTTP://Example.COM/a b')).toBe('http://example.com/a%20b')
    expect(externalUrl('mailto:someone@example.com')).toBe('mailto:someone@example.com')
  })

  it('refuses every other scheme, and garbage', () => {
    for (const url of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'data:text/html,x', 'ms-settings:', 'smb://host/share', 'minidsh-shell://app/index.html', 'about:blank', '', 'nope']) {
      expect(externalUrl(url), url).toBeUndefined()
    }
  })
})

describe("the runtime's environment", () => {
  it('appends the bundled node to the PATH spelling that is there, and drops the run-as-node switch', () => {
    const env = runtimeEnv({ Path: 'C:\\Windows;C:\\Tools', ELECTRON_RUN_AS_NODE: '1', HOME: 'h' }, 'C:\\App\\resources\\node', ';')
    expect(env.Path).toBe('C:\\Windows;C:\\Tools;C:\\App\\resources\\node')
    expect(env.PATH).toBeUndefined()
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.HOME).toBe('h')
  })

  it('sets PATH when there was none', () => {
    expect(runtimeEnv({}, '/opt/app/node/bin', ':').PATH).toBe('/opt/app/node/bin')
  })

  it("removes what AppRun added inside an AppImage, and only that", () => {
    const appDir = '/tmp/.mount_MiniDSabc'
    const env = runtimeEnv(
      {
        APPIMAGE: '/home/z/MiniDSH.AppImage',
        APPDIR: appDir,
        ARGV0: 'MiniDSH',
        OWD: '/home/z',
        PATH: `${appDir}:${appDir}/usr/sbin:/usr/local/bin:/usr/bin`,
        LD_LIBRARY_PATH: `${appDir}/usr/lib`,
        XDG_DATA_DIRS: `${appDir}/usr/share/:/usr/share`,
        HOME: '/home/z',
      },
      '/tmp/.mount_MiniDSabc/resources/node/bin',
      ':',
    )
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/tmp/.mount_MiniDSabc/resources/node/bin')
    expect(env.LD_LIBRARY_PATH).toBeUndefined()
    expect(env.XDG_DATA_DIRS).toBe('/usr/share')
    for (const name of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) expect(env[name], name).toBeUndefined()
    expect(env.HOME).toBe('/home/z')
  })

  it('leaves the environment alone outside an AppImage, even when APPDIR happens to be set', () => {
    const env = runtimeEnv({ APPDIR: '/x', PATH: '/x/bin:/usr/bin' }, '/n', ':')
    expect(env.PATH).toBe('/x/bin:/usr/bin:/n')
    expect(env.APPDIR).toBe('/x')
  })
})

// Node's proxy agent reads `no_proxy` before `NO_PROXY`, and an empty value
// counts as set: a lowercase one that lacks loopback wins over an uppercase
// one that has it, and the launch token would go to the proxy.
describe("main's own environment", () => {
  const exempted = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    exemptLoopbackFromProxy(env)
    return env
  }

  it('exempts loopback from an environment proxy under BOTH spellings, whichever were set', () => {
    expect(exempted({})).toEqual({ NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' })
    expect(exempted({ no_proxy: '' })).toEqual({ NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' })
    expect(exempted({ NO_PROXY: 'a.example', no_proxy: 'b.example' })).toEqual({ NO_PROXY: 'a.example,127.0.0.1', no_proxy: 'b.example,127.0.0.1' })
  })

  // This environment is the runtime's and every agent shell's too. A spelling
  // created holding loopback alone shadowed the person's own exemptions for
  // every reader that prefers it (curl and git read the lowercase one first).
  it('gives a spelling that was not set the entries of the one that was, never loopback alone', () => {
    expect(exempted({ NO_PROXY: 'corp.example, .internal' })).toEqual({ NO_PROXY: 'corp.example,.internal,127.0.0.1', no_proxy: 'corp.example,.internal,127.0.0.1' })
    expect(exempted({ no_proxy: 'example.com' })).toEqual({ NO_PROXY: 'example.com,127.0.0.1', no_proxy: 'example.com,127.0.0.1' })
  })

  it('adds it once: an entry already there is not repeated, nor is a second pass', () => {
    const env = exempted({ NO_PROXY: 'localhost,127.0.0.1', no_proxy: '127.0.0.1 , x.example' })
    expect(env).toEqual({ NO_PROXY: 'localhost,127.0.0.1', no_proxy: '127.0.0.1,x.example' })
    expect(exempted({ ...env })).toEqual(env)
  })
})
