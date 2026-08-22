/**
 * JSONL session persistence. A subscriber (not a core service): it writes the
 * header as line 1 and one event per line, synchronously inside the
 * `session/event` listener (S1 simplification of DSH's write-behind). It also
 * exposes a reader for the `sessions show` surface. A torn tail is truncated on
 * read; an interrupted turn is repaired via the session repair helper.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serviceKey, type Context, type Plugin } from '../../kernel/index.ts'
import {
  repairInterruptedTail,
  SESSION_CREATED,
  SESSION_EVENT,
  type EventEnvelope,
  type Session,
  type SessionHeader,
} from '../../core/session/index.ts'

export interface StoredSession {
  readonly header: SessionHeader
  readonly events: EventEnvelope[]
}

export interface Archive {
  read(id: string): StoredSession | undefined
  list(): SessionHeader[]
  repaired(id: string): StoredSession | undefined
}

export const ARCHIVE = serviceKey<Archive>('archive')

interface HeaderLine extends SessionHeader {
  readonly kind: 'session'
}

export interface PersistenceConfig {
  readonly root: string
}

class JsonlArchive implements Archive {
  private readonly root: string
  private readonly files = new WeakMap<Session, string>()
  constructor(root: string) {
    this.root = root
    mkdirSync(root, { recursive: true })
  }

  onCreated(session: Session): void {
    const file = join(this.root, `${encodeURIComponent(session.id)}.jsonl`)
    this.files.set(session, file)
    const header: HeaderLine = { kind: 'session', ...session.header }
    writeFileSync(file, `${JSON.stringify(header)}\n`, 'utf8')
    for (const event of session.events) appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8')
  }

  onEvent(session: Session, event: EventEnvelope): void {
    const file = this.files.get(session)
    if (file) appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8')
  }

  read(id: string): StoredSession | undefined {
    const file = join(this.root, `${encodeURIComponent(id)}.jsonl`)
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return undefined
    }
    const lines = text.split('\n')
    const headerLine = lines.shift()
    if (!headerLine) return undefined
    const header = JSON.parse(headerLine) as HeaderLine
    const events: EventEnvelope[] = []
    for (const line of lines) {
      if (line.trim() === '') continue
      try {
        const event = JSON.parse(line) as EventEnvelope
        if (event.seq !== events.length) break // torn / non-contiguous tail
        events.push(event)
      } catch {
        break // torn final record
      }
    }
    return { header, events }
  }

  repaired(id: string): StoredSession | undefined {
    const stored = this.read(id)
    if (!stored) return undefined
    const closers = repairInterruptedTail(stored.events)
    return closers.length === 0 ? stored : { header: stored.header, events: [...stored.events, ...closers] }
  }

  list(): SessionHeader[] {
    let names: string[]
    try {
      names = readdirSync(this.root).filter((name) => name.endsWith('.jsonl'))
    } catch {
      return []
    }
    const headers: SessionHeader[] = []
    for (const name of names) {
      try {
        const first = readFileSync(join(this.root, name), 'utf8').split('\n', 1)[0]
        if (first) headers.push(JSON.parse(first) as SessionHeader)
      } catch {
        // Skip an unreadable file.
      }
    }
    return headers.toSorted((a, b) => b.createdAt - a.createdAt)
  }
}

/** Provides `ctx.archive` and writes every session to `<root>/<id>.jsonl`. */
export const persistenceJsonlPlugin: Plugin<PersistenceConfig> = {
  name: 'persistence-jsonl',
  apply(ctx: Context, config) {
    const archive = new JsonlArchive(config.root)
    ctx.provide(ARCHIVE, archive)
    ctx.on(SESSION_CREATED, (session) => archive.onCreated(session))
    ctx.on(SESSION_EVENT, (session, event) => archive.onEvent(session, event))
  },
}
