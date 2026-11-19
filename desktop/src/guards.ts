/**
 * The URL rules the window enforces, pure so they are tested apart from
 * Electron (S22.2 review: they lived untested in main.ts).
 *
 * Owns: which URL is the runtime's own (`isHostUrl`: the web view may load it,
 * and only it gets the injected cookie) and which may be handed to the OS
 * (`externalUrl`). Must not own: the port (main's `live`), or the decision to
 * open anything.
 */

/**
 * The live runtime's own origin, exactly: http or ws, host `127.0.0.1`, the
 * port it reported ready on, no user info. Compared by protocol and host,
 * never by prefix (`http://127.0.0.1:P@evil/` parses to host `evil`), and a
 * `localhost` spelling is NOT the host: its cookie is minted for the
 * `127.0.0.1:P` authority (web.ts).
 */
export function isHostUrl(url: string, port: number | undefined): boolean {
  if (port === undefined) return false
  const parsed = URL.parse(url)
  if (parsed === null) return false
  return (parsed.protocol === 'http:' || parsed.protocol === 'ws:') && parsed.host === `127.0.0.1:${port}` && parsed.username === '' && parsed.password === ''
}

/** What the person's browser or mail client may be handed: http(s) and mailto, normalized; anything else is `undefined`. */
export function externalUrl(url: string): string | undefined {
  const parsed = URL.parse(url)
  if (parsed === null) return undefined
  return parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:' ? parsed.href : undefined
}
