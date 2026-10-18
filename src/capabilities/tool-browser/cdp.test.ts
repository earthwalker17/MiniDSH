/**
 * The pipe client against byte streams: framing, routing and the three failure
 * rules, without a browser. The real-browser half is `launch.test.ts`.
 */
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { CdpConnection, type CdpEvent } from './cdp.ts'

function pair(options: { maxMessageBytes?: number } = {}): { cdp: CdpConnection; sent: string[]; feed: (text: string | Buffer) => void; toBrowser: PassThrough; fromBrowser: PassThrough } {
  const toBrowser = new PassThrough()
  const fromBrowser = new PassThrough()
  const sent: string[] = []
  toBrowser.on('data', (chunk: Buffer) => {
    for (const part of chunk.toString('utf8').split('\0')) if (part !== '') sent.push(part)
  })
  const cdp = new CdpConnection(toBrowser, fromBrowser, options)
  return { cdp, sent, feed: (text) => fromBrowser.write(text), toBrowser, fromBrowser }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('the CDP pipe client', () => {
  it('frames each command as one JSON text and a NUL, with the flat session id', async () => {
    const { cdp, sent } = pair()
    void cdp.send('Page.navigate', { url: 'http://localhost:1/' }, { sessionId: 'S1' }).catch(() => {})
    await tick()
    expect(sent.map((text) => JSON.parse(text))).toEqual([{ id: 1, method: 'Page.navigate', params: { url: 'http://localhost:1/' }, sessionId: 'S1' }])
    cdp.close('test over')
  })

  it('reassembles answers split across chunks and splits several in one chunk', async () => {
    const { cdp, feed } = pair()
    const a = cdp.send<{ v: number }>('A.a')
    const b = cdp.send<{ v: number }>('B.b')
    const events: CdpEvent[] = []
    cdp.onEvent((event) => events.push(event))
    feed('{"id":1,"res')
    feed('ult":{"v":1}}\0{"method":"Page.loadEventFired","params":{"timestamp":3},"sessionId":"S"}\0{"id":2,"result":{"v":2}}\0')
    expect((await a).v).toBe(1)
    expect((await b).v).toBe(2)
    expect(events).toEqual([{ method: 'Page.loadEventFired', params: { timestamp: 3 }, sessionId: 'S' }])
  })

  it('turns a protocol error into a coded rejection naming the method', async () => {
    const { cdp, feed } = pair()
    const answer = cdp.send('DOM.resolveNode', { backendNodeId: 9 })
    feed('{"id":1,"error":{"code":-32000,"message":"No node with given id found"}}\0')
    await expect(answer).rejects.toMatchObject({ code: 'BROWSER_PROTOCOL', message: expect.stringContaining('DOM.resolveNode: No node with given id found') })
  })

  it('drops an oversized answer up to its NUL, failing only the request it answers', async () => {
    const { cdp, feed } = pair({ maxMessageBytes: 100 })
    const big = cdp.send('Page.captureScreenshot')
    const small = cdp.send<{ ok: boolean }>('Browser.getVersion')
    feed(`{"id":1,"result":{"data":"${'x'.repeat(60)}`)
    feed(`${'y'.repeat(200)}"}}\0{"id":2,"result":{"ok":true}}\0`)
    await expect(big).rejects.toMatchObject({ code: 'BROWSER_PROTOCOL', message: expect.stringContaining('larger than 100 bytes') })
    expect((await small).ok).toBe(true)
    expect(cdp.closed).toBeUndefined()
  })

  it('rejects every pending request when the pipe ends, and refuses to send after', async () => {
    const { cdp, fromBrowser } = pair()
    const pending = cdp.send('Runtime.evaluate', { expression: 'new Promise(() => {})', awaitPromise: true })
    const reasons: string[] = []
    cdp.onClose((reason) => reasons.push(reason))
    fromBrowser.end()
    await expect(pending).rejects.toMatchObject({ code: 'BROWSER_CLOSED' })
    expect(reasons).toEqual(['the browser closed its end of the pipe'])
    await expect(cdp.send('Browser.getVersion')).rejects.toMatchObject({ code: 'BROWSER_CLOSED' })
  })

  it('routes a write error to close instead of letting it reach the host', async () => {
    const { cdp, toBrowser } = pair()
    const pending = cdp.send('Browser.getVersion')
    // An unhandled 'error' on this stream would be an uncaught exception.
    toBrowser.destroy(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    await expect(pending).rejects.toMatchObject({ code: 'BROWSER_CLOSED', message: expect.stringContaining('EPIPE') })
  })

  it('times a request out with a coded error, and honours the caller abort', async () => {
    const { cdp } = pair()
    await expect(cdp.send('Slow.thing', {}, { timeoutMs: 20 })).rejects.toMatchObject({ code: 'BROWSER_TIMEOUT', message: expect.stringContaining('Slow.thing') })
    const controller = new AbortController()
    const cancelled = cdp.send('Slow.other', {}, { signal: controller.signal })
    controller.abort(new Error('the turn was cancelled'))
    await expect(cancelled).rejects.toThrow('the turn was cancelled')
    cdp.close('test over')
  })

  it('closes on a message that is not JSON', async () => {
    const { cdp, feed } = pair()
    const pending = cdp.send('A.a')
    feed('{not json\0')
    await expect(pending).rejects.toMatchObject({ code: 'BROWSER_CLOSED' })
    expect(cdp.closed).toContain('not JSON')
  })
})
