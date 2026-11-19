/**
 * "Would stopping the runtime interrupt work?" — asked over the WIRE, on
 * demand, before a close, a quit or a folder change (one lifecycle path).
 *
 * A short-lived WebSocket, signed in with main's cookie, sends ONE
 * `control/subscribe` and reads its baseline: a summary per live session
 * (ARCHITECTURE §8). Then it closes. It must never linger: a control
 * subscriber counts as a client that could still answer a parked approval
 * (`protocol/host.ts` `couldAnswer`), so a standing one would keep every
 * unattended question parked forever instead of settling `unavailable`.
 *
 * Anything short of a clean answer — a timeout, a refused upgrade, a close
 * before the result, a JSON-RPC error, a result of the wrong shape — is
 * `unknown`, and unknown is BUSY: the confirm is the safe side of a guess.
 *
 * Owns: the query and its reading. Must not own: the confirm (main) or any
 * state between calls.
 */

export interface RuntimeActivity {
  /** Stopping now would interrupt something, or the runtime could not say. */
  readonly busy: boolean
  /** The runtime gave no usable answer; `busy` is then true. */
  readonly unknown: boolean
  /** Sessions with a turn running. */
  readonly running: number
  /** Background jobs running, over all sessions. */
  readonly jobs: number
  /** Questions waiting for a person, over all sessions. */
  readonly approvals: number
}

/** The slice of a WebSocket this needs; Node's own is the default. */
export interface InspectSocket {
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: { readonly data?: unknown }) => void): void
  send(data: string): void
  close(): void
}

export type InspectSocketConstructor = new (url: string, init: { headers: Record<string, string> }) => InspectSocket

export interface InspectOptions {
  readonly port: number
  /** `minidsh_session=…`, as `signIn` returned it. */
  readonly cookie: string
  readonly timeoutMs?: number
  readonly WebSocketImpl?: InspectSocketConstructor
}

const UNKNOWN: RuntimeActivity = { busy: true, unknown: true, running: 0, jobs: 0, approvals: 0 }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

/** A `control/subscribe` result to activity, or `undefined` when it is not that shape. */
export function activityOf(result: unknown): RuntimeActivity | undefined {
  if (!isRecord(result) || !Array.isArray(result.sessions)) return undefined
  let running = 0
  let jobs = 0
  let approvals = 0
  for (const session of result.sessions) {
    if (!isRecord(session) || !isCount(session.runningJobs) || !isCount(session.pendingApprovals)) return undefined
    if (session.status !== 'idle' && session.status !== 'running' && session.status !== 'closed') return undefined
    if (session.status === 'running') running += 1
    jobs += session.runningJobs
    approvals += session.pendingApprovals
  }
  // Held notices are not counted: they wait for the next message, and a stop interrupts none of them.
  return { busy: running > 0 || jobs > 0 || approvals > 0, unknown: false, running, jobs, approvals }
}

const REQUEST_ID = 1

export function inspectRuntime({ port, cookie, timeoutMs = 2_000, WebSocketImpl = globalThis.WebSocket }: InspectOptions): Promise<RuntimeActivity> {
  return new Promise((resolve) => {
    let socket: InspectSocket
    try {
      socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } })
    } catch {
      resolve(UNKNOWN)
      return
    }
    let settled = false
    const settle = (activity: RuntimeActivity): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // Already closing; the answer stands.
      }
      resolve(activity)
    }
    const timer = setTimeout(() => settle(UNKNOWN), timeoutMs)
    socket.addEventListener('open', () => {
      try {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: REQUEST_ID, method: 'control/subscribe', params: {} }))
      } catch {
        settle(UNKNOWN)
      }
    })
    socket.addEventListener('message', (event) => {
      let frame: unknown
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        return
      }
      // Notifications (`control.summary`, `session.*`) may precede the answer; only ours settles.
      if (!isRecord(frame) || frame.id !== REQUEST_ID) return
      settle(frame.error === undefined ? (activityOf(frame.result) ?? UNKNOWN) : UNKNOWN)
    })
    socket.addEventListener('error', () => settle(UNKNOWN))
    socket.addEventListener('close', () => settle(UNKNOWN))
  })
}
