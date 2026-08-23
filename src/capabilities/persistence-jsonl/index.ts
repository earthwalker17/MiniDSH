/**
 * JSONL session persistence. A subscriber (not a driven service): it writes the
 * header as line 1 and one event per line, synchronously inside the
 * `session/event` listener (S1 simplification of DSH's write-behind), and
 * provides the `core/persistence` read Definition. Publication decides the
 * write mode: a `resumed` session ATTACHES to its existing file append-only
 * (the whole-file snapshot is the fresh/fork path and must never run for a
 * resume). A torn final line — the expected crash artifact — is preserved in a
 * `.torn` sidecar, never silently destroyed; deeper corruption (a mid-file
 * parse error or seq gap) marks the stored session `damaged` on read and
 * refuses attach.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context, Plugin } from '../../kernel/index.ts'
import { PERSISTENCE, type Persistence, type StoredSession } from '../../core/persistence/index.ts'
import {
  SESSION_CREATED,
  SESSION_DISPOSED,
  SESSION_EVENT,
  SESSION_FLUSH,
  type EventEnvelope,
  type Session,
  type SessionHeader,
} from '../../core/session/index.ts'

interface HeaderLine extends SessionHeader {
  readonly kind: 'session'
}

export interface PersistenceConfig {
  readonly root: string
}

interface ScanResult {
  readonly header: SessionHeader
  readonly events: EventEnvelope[]
  /** Byte length of the accepted prefix (each accepted line including its newline). */
  readonly validBytes: number
  /**
   * `torn-line`: an unterminated final fragment (crash artifact; safe to
   * sidecar). `invalid`: terminated garbage or a seq gap — deeper corruption.
   */
  readonly tail: 'none' | 'torn-line' | 'invalid'
}

/** Scans a session file line by line, tracking exact byte offsets. */
function scanSessionFile(file: string): ScanResult | undefined {
  let buffer: Buffer
  try {
    buffer = readFileSync(file)
  } catch {
    return undefined
  }
  let header: SessionHeader | undefined
  const events: EventEnvelope[] = []
  let validBytes = 0
  let tail: ScanResult['tail'] = 'none'
  let offset = 0
  let first = true
  while (offset < buffer.length) {
    const nl = buffer.indexOf(0x0a, offset)
    const terminated = nl !== -1
    const end = terminated ? nl : buffer.length
    const lineEnd = terminated ? nl + 1 : buffer.length
    const line = buffer.subarray(offset, end).toString('utf8')
    if (!terminated) {
      // An append cut short before its trailing newline.
      tail = first ? 'invalid' : 'torn-line'
      break
    }
    if (first) {
      try {
        header = JSON.parse(line) as SessionHeader
      } catch {
        return undefined
      }
      first = false
    } else if (line.trim() !== '') {
      let accepted = false
      try {
        const event = JSON.parse(line) as EventEnvelope
        if (event.seq === events.length) {
          events.push(event)
          accepted = true
        }
      } catch {
        // Terminated but unparseable: not a torn append; fall through to invalid.
      }
      if (!accepted) {
        tail = 'invalid'
        break
      }
    }
    validBytes = lineEnd
    offset = lineEnd
  }
  if (!header) return undefined
  return { header, events, validBytes, tail }
}

/** Stored session headers (line 1 of each `*.jsonl`), newest first; unreadable files skipped. */
function listStoredHeaders(root: string): SessionHeader[] {
  let names: string[]
  try {
    names = readdirSync(root).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return []
  }
  const headers: SessionHeader[] = []
  for (const name of names) {
    try {
      const first = readFileSync(join(root, name), 'utf8').split('\n', 1)[0]
      if (first) headers.push(JSON.parse(first) as SessionHeader)
    } catch {
      // Skip an unreadable file.
    }
  }
  return headers.toSorted((a, b) => b.createdAt - a.createdAt)
}

class JsonlArchive implements Persistence {
  private readonly root: string
  private readonly files = new WeakMap<Session, string>()
  /** A write failure is remembered and rethrown at the next flush checkpoint. */
  private readonly failures = new WeakMap<Session, unknown>()
  constructor(root: string) {
    this.root = root
    mkdirSync(root, { recursive: true })
  }

  private fileFor(id: string): string {
    return join(this.root, `${encodeURIComponent(id)}.jsonl`)
  }

  /** Publication decides the write mode; a failed attach leaves no file entry, so later events are dropped and flush throws. */
  onPublished(session: Session): void {
    const file = this.fileFor(session.id)
    try {
      if (session.origin === 'resumed') this.attach(session, file)
      else this.snapshot(session, file)
      this.files.set(session, file)
    } catch (error) {
      this.failures.set(session, error)
    }
  }

  /** The fresh/fork path: one whole-file write of the header plus every event so far. */
  private snapshot(session: Session, file: string): void {
    const header: HeaderLine = { kind: 'session', ...session.header }
    const lines = [JSON.stringify(header), ...session.events.map((event) => JSON.stringify(event))]
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
  }

  /** The resume path: append-only continuation of the existing file. */
  private attach(session: Session, file: string): void {
    const scan = scanSessionFile(file)
    if (!scan) {
      // No stored file (or an unreadable header): nothing to attach to.
      this.snapshot(session, file)
      return
    }
    if (scan.tail === 'invalid') throw new Error(`session ${session.id}: stored log is damaged; refusing to attach`)
    if (scan.header.id !== session.id || scan.header.createdAt !== session.header.createdAt) {
      throw new Error(`session ${session.id}: stored header does not match the resumed session; refusing to attach`)
    }
    if (scan.events.length > session.events.length) {
      throw new Error(`session ${session.id}: stored log is longer than the resumed session; refusing to attach`)
    }
    if (scan.tail === 'torn-line') {
      // Preserve the crash artifact in a sidecar rather than destroying bytes.
      const torn = readFileSync(file).subarray(scan.validBytes)
      appendFileSync(`${file}.torn`, torn)
      truncateSync(file, scan.validBytes)
    }
    const delta = session.events.slice(scan.events.length)
    if (delta.length > 0) {
      appendFileSync(file, delta.map((event) => `${JSON.stringify(event)}\n`).join(''), 'utf8')
    }
  }

  onEvent(session: Session, event: EventEnvelope): void {
    const file = this.files.get(session)
    if (!file) return
    try {
      appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8')
    } catch (error) {
      if (!this.failures.has(session)) this.failures.set(session, error)
    }
  }

  /** A session disposed before any fact was recorded (e.g. never prompted) leaves no file behind. */
  onDisposed(session: Session): void {
    const file = this.files.get(session)
    this.files.delete(session)
    if (!file || session.events.length > 0) return
    try {
      unlinkSync(file)
    } catch {
      // Already gone or unremovable; a header-only file is harmless.
    }
  }

  /** The awaited durability checkpoint: a swallowed write error surfaces here. */
  onFlush(session: Session): void {
    const failure = this.failures.get(session)
    if (failure === undefined) return
    this.failures.delete(session)
    throw new Error(`session ${session.id} could not be persisted: ${failure instanceof Error ? failure.message : String(failure)}`, {
      cause: failure,
    })
  }

  load(id: string): StoredSession | undefined {
    const scan = scanSessionFile(this.fileFor(id))
    if (!scan) return undefined
    return { header: scan.header, events: scan.events, ...(scan.tail === 'invalid' ? { damaged: true as const } : {}) }
  }

  list(): SessionHeader[] {
    return listStoredHeaders(this.root)
  }
}

/** Provides `ctx.persistence` and writes every published session to `<root>/<id>.jsonl`. */
export const persistenceJsonlPlugin: Plugin<PersistenceConfig> = {
  name: 'persistence-jsonl',
  apply(ctx: Context, config) {
    const archive = new JsonlArchive(config.root)
    ctx.provide(PERSISTENCE, archive)
    ctx.on(SESSION_CREATED, (session) => archive.onPublished(session))
    ctx.on(SESSION_EVENT, (session, event) => archive.onEvent(session, event))
    ctx.on(SESSION_FLUSH, (session) => archive.onFlush(session))
    ctx.on(SESSION_DISPOSED, (session) => archive.onDisposed(session))
  },
}
