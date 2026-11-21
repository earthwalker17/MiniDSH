/**
 * The fence's rules as text: what counts as loopback, what the two launch
 * switches then say, and which operator entries the row's contract admits.
 * No browser: what Chrome DOES with these strings is `launch.test.ts`'s, on
 * the hosts that have one. These hold on a host that has none.
 */
import { describe, expect, it } from 'vitest'
import { bypassList, hostResolverRules, isAllowedHost, isLoopbackHost, reachable } from './fence.ts'
import { toolBrowserPlugin } from './index.ts'

/** Chrome's host pattern, as `base::MatchPattern` reads one: `*` is any run of characters, `?` exactly one, the rest literal. */
function matchesPattern(host: string, pattern: string): boolean {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')
  return new RegExp(`^${source}$`).test(host)
}

/** The hosts `--host-resolver-rules` leaves to a real lookup: its EXCLUDE patterns. */
function excluded(allowHosts: readonly string[] = []): string[] {
  const [map, ...rest] = hostResolverRules(allowHosts).split(', ')
  expect(map, 'every other name must resolve to nothing').toBe('MAP * ~NOTFOUND')
  expect(rest.filter((rule) => !rule.startsWith('EXCLUDE ')), 'a rule that is neither the map nor an exclusion').toEqual([])
  return rest.map((rule) => rule.slice('EXCLUDE '.length))
}

describe('what the fence calls loopback', () => {
  // As `URL.hostname` spells them, which is what the navigation check reads.
  const LOOPBACK = ['localhost', 'app.localhost', 'a.b.localhost', '127.0.0.1', '[::1]']
  // Addresses in 127/8 that are not 127.0.0.1, and NAMES built to look like loopback.
  const NOT_LOOPBACK = ['127.0.0.2', '127.1.2.3', '127.255.255.254', '127.x.example.com', '127.0.0.1.example.com', '127.0.0.1x', 'localhost.example.com', 'app.localhost.example.com', 'notlocalhost', '[::2]', '0.0.0.0', '10.0.0.1']

  it('is localhost, a name under .localhost, 127.0.0.1 and [::1], and nothing else beginning 127', () => {
    for (const host of LOOPBACK) expect(isLoopbackHost(host), host).toBe(true)
    for (const host of NOT_LOOPBACK) expect(isLoopbackHost(host), host).toBe(false)
    // Every spelling of the address is the one string once `URL` has read it.
    for (const url of ['http://127.1:8080/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://LOCALHOST:5173/', 'https://[0:0:0:0:0:0:0:1]/']) expect(reachable(new URL(url), []), url).toBe(true)
    for (const url of ['http://127.0.0.2:8080/', 'http://127.x.example.com/', 'ftp://localhost/', 'ws://localhost/']) expect(reachable(new URL(url), []), url).toBe(false)
  })

  /**
   * The rule a glob broke: an exclusion is matched against the host as TEXT,
   * so `EXCLUDE 127.*` exempted `127.x.example.com` from "resolves to nothing"
   * along with the addresses it was written for, and that name reached a DNS
   * transaction as a WebRTC TURN host. A name that is not loopback must match
   * NO exclusion, whatever it is spelled like.
   */
  it('leaves to a real lookup exactly the hosts it calls loopback: no exclusion matches a name that only looks like one', () => {
    const patterns = excluded()
    const exempt = (host: string): string[] => patterns.filter((pattern) => matchesPattern(host, pattern))
    for (const host of NOT_LOOPBACK) expect(exempt(host), `${host} is exempt from the resolver rules`).toEqual([])
    for (const host of LOOPBACK) expect(exempt(host).length, `${host} is loopback and would resolve to nothing`).toBeGreaterThan(0)
    // Chrome asks for the IPv6 address both ways, so both spellings are there.
    expect(exempt('::1')).toEqual(['::1'])
    // And the proxy is one of them: without its exclusion the browser cannot reach its own fence.
    expect(exempt('127.0.0.1')).toEqual(['127.0.0.1'])
  })

  it('sends past the proxy only what also resolves, so another 127 address meets the fence instead of failing as a name', () => {
    const entries = bypassList([]).split(';')
    expect(entries[0], 'Chrome’s implicit bypass (link-local as well as loopback) must be removed first').toBe('<-loopback>')
    const direct = entries.slice(1)
    // An entry with a `/` is an address RANGE to Chrome: `127.0.0.1/8` sent the whole of 127/8 direct.
    expect(direct.filter((entry) => entry.includes('/')), 'an address range in the bypass list').toEqual([])
    const patterns = excluded()
    for (const entry of direct) expect(patterns, `${entry} bypasses the proxy but resolves to nothing`).toContain(entry)
  })

  it('adds an operator’s hosts to both lists as written, and admits them to the navigation check', () => {
    const allowHosts = ['example.com', '*.dev.example.com']
    expect(excluded(allowHosts).slice(-2)).toEqual(allowHosts)
    expect(bypassList(allowHosts).split(';').slice(-2)).toEqual(allowHosts)
    expect(isAllowedHost('example.com', allowHosts)).toBe(true)
    expect(isAllowedHost('api.dev.example.com', allowHosts)).toBe(true)
    // A `*.` entry is its subdomains, not the name itself and not a name that merely ends the same.
    expect(isAllowedHost('dev.example.com', allowHosts)).toBe(false)
    expect(isAllowedHost('notexample.com', allowHosts)).toBe(false)
    expect(isAllowedHost('evildev.example.com', allowHosts)).toBe(false)
  })
})

/**
 * `allowHosts` is written into two command-line switches whose values are
 * LISTS: `;` separates bypass entries and `, ` separates resolver rules. The
 * row's contract is the only thing between an entry and those lists, so an
 * entry that could end one item and begin another — `a.com;*` bypasses the
 * proxy for everything, `a.com, MAP * 1.2.3.4` rewrites every lookup — is
 * refused there, as is anything that is not a bare lower-case host.
 */
describe('the allowHosts contract', () => {
  const parse = (allowHosts: unknown): unknown => toolBrowserPlugin.config!.parse({ profileRoot: 'profiles', allowHosts })

  it('admits a host name, an IPv4 address and a `*.` prefix', () => {
    const allowHosts = ['example.com', '*.example.com', 'intranet', '10.1.2.3', 'my-host.internal', 'xn--bcher-kva.example']
    expect(parse(allowHosts)).toEqual({ profileRoot: 'profiles', allowHosts })
  })

  it.each([
    ['a second bypass entry', 'a.com;*'],
    ['a second resolver rule', 'a.com, MAP * 1.2.3.4'],
    ['a comma alone', 'a.com,b.com'],
    ['a port', 'a.com:443'],
    ['a scheme', 'http://a.com'],
    ['a path or an address range', '127.0.0.1/8'],
    ['upper case, which no URL host is', 'A.com'],
    ['every host', '*'],
    ['a wildcard that is not a leading label', 'a.*'],
    ['a wildcard inside a label', '*a.com'],
    ['two wildcards', '*.*.a.com'],
    ['a space', 'a b'],
    ['a leading space', ' a.com'],
    ['a trailing newline', 'a.com\n'],
    ['a trailing dot', 'a.com.'],
    ['an empty label', 'a..com'],
    ['a leading dot', '.a.com'],
    ['an IPv6 literal', '[::1]'],
    ['Chrome’s own bypass keyword', '<local>'],
    ['Chrome’s own resolver keyword', '~NOTFOUND'],
    ['an underscore', 'a_b.com'],
    ['a non-ASCII name', 'bücher.example'],
    ['nothing', ''],
  ])('refuses %s (%j)', (_what, entry) => {
    expect(() => parse([entry]), JSON.stringify(entry)).toThrow()
  })

  it('refuses a list that is not strings, and one past its length', () => {
    expect(() => parse('example.com')).toThrow()
    expect(() => parse([42])).toThrow()
    expect(() => parse(Array.from({ length: 65 }, (_, index) => `h${index}.example.com`))).toThrow()
  })
})
