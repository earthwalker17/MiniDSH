import { asSessionId, type SessionId } from '../ids.ts'
import { deepFreeze, snapshotJson } from '../json.ts'
import type { Message } from '../llm/types.ts'
import { deriveEventMessage, foldRequestHeader, Surface } from './surface.ts'
import {
  END_SEED,
  SESSION_FORMAT_VERSION,
  type EventEnvelope,
  type EventKind,
  type RequestHeader,
  type SessionHeader,
  type SurfaceIntent,
} from './types.ts'

/** The callbacks a session uses to reach its store's dispatch surface. */
export interface SessionHost {
  /**
   * Pre-commit observation: runs the dispatch observers (the invariants) for
   * a live event and returns the delivery step. A throw here rejects the
   * append before the event enters the log; the returned function publishes
   * `session/event` once the event is committed.
   */
  prepare(session: Session, event: EventEnvelope): () => void
  flush(session: Session): Promise<void>
}

export class SessionForkError extends Error {
  readonly code: 'INVALID_BOUNDARY' | 'OPEN_TURN'
  constructor(code: 'INVALID_BOUNDARY' | 'OPEN_TURN', message: string) {
    super(message)
    this.name = 'SessionForkError'
    this.code = code
  }
}

/**
 * An append-only log of typed events — the single source of truth. Model
 * history is derived from the surface, never stored. Structural integrity
 * (seq contiguity, JSON-lossless data, surface well-formedness, immutability)
 * is validated at the append site and is always on.
 */
export class Session {
  readonly header: SessionHeader
  private readonly log: EventEnvelope[] = []
  private readonly surface = new Surface()
  private readonly host: SessionHost
  private readonly firstLiveSeq: number
  private derived: readonly Message[] = []
  private derivedKey = -1

  constructor(header: SessionHeader, host: SessionHost, seed?: readonly EventEnvelope[]) {
    if (header.version !== SESSION_FORMAT_VERSION) {
      throw new Error(`session ${header.id}: version ${header.version} != ${SESSION_FORMAT_VERSION}`)
    }
    this.header = deepFreeze({ ...header, id: asSessionId(header.id) })
    this.host = host
    if (seed) {
      for (let i = 0; i < seed.length; i++) this.seedOne(seed[i]!, i)
    }
    this.firstLiveSeq = this.log.length
    if (seed && seed.length > 0 && this.log.at(-1)?.type !== END_SEED.type) {
      this.commit(this.build(END_SEED, {}), false)
    }
  }

  get id(): SessionId {
    return this.header.id
  }

  get seq(): number {
    return this.log.length
  }

  get events(): readonly EventEnvelope[] {
    return this.log
  }

  /** Seq at which this lifecycle's own writes begin (after any seed). */
  get liveStart(): number {
    return this.firstLiveSeq
  }

  private seedOne(raw: EventEnvelope, index: number): void {
    if (raw.seq !== index) throw new Error(`seed event ${index} has seq ${raw.seq}`)
    const event = this.freezeEnvelope(raw)
    this.surface.validate(event)
    this.log.push(event)
    this.surface.apply(event)
  }

  /** Appends a live event: validate + freeze + push + surface + emit. */
  append<Name extends string, Data>(kind: EventKind<Name, Data>, data: Data, intent?: SurfaceIntent): EventEnvelope<Data> {
    const event = this.build(kind, data, intent)
    this.commit(event, true)
    return event
  }

  private build<Name extends string, Data>(kind: EventKind<Name, Data>, data: Data, intent?: SurfaceIntent): EventEnvelope<Data> {
    const event: EventEnvelope<Data> = {
      type: kind.type,
      seq: this.log.length,
      time: Date.now(),
      data: snapshotJson(data),
      ...(intent ? { surfaceOp: snapshotJson(intent.surfaceOp) } : {}),
      ...(intent?.sourceEventSeqs ? { sourceEventSeqs: intent.sourceEventSeqs.slice() } : {}),
    }
    return deepFreeze(event)
  }

  private freezeEnvelope(raw: EventEnvelope): EventEnvelope {
    // Seed events arrive already-shaped; re-snapshot data to guarantee JSON-losslessness and freeze.
    const event: EventEnvelope = {
      type: raw.type,
      seq: raw.seq,
      time: raw.time,
      data: snapshotJson(raw.data),
      ...(raw.surfaceOp ? { surfaceOp: snapshotJson(raw.surfaceOp) } : {}),
      ...(raw.sourceEventSeqs ? { sourceEventSeqs: raw.sourceEventSeqs.slice() } : {}),
    }
    return deepFreeze(event)
  }

  /** validate → observe (may reject) → push → surface → deliver. Nothing enters the log that an observer rejected. */
  private commit(event: EventEnvelope, live: boolean): EventEnvelope {
    this.surface.validate(event)
    const deliver = live ? this.host.prepare(this, event) : undefined
    this.log.push(event)
    this.surface.apply(event)
    deliver?.()
    return event
  }

  /** Model history projected from the surface. Fresh array over shared frozen messages. */
  deriveMessages(): Message[] {
    const key = this.log.length * 1_000_003 + this.surface.replaceGeneration
    if (key !== this.derivedKey) {
      const messages: Message[] = []
      for (const seq of this.surface.seqs()) {
        const message = deriveEventMessage(this.log[seq]!)
        if (message) messages.push(message)
      }
      this.derived = messages
      this.derivedKey = key
    }
    return [...this.derived]
  }

  foldRequestHeader(): RequestHeader | undefined {
    return foldRequestHeader(this.log)
  }

  flush(): Promise<void> {
    return this.host.flush(this)
  }

  /** Seed for a fork at `boundary` (inclusive; defaults to the whole log). Rejects an open turn. */
  forkSeed(boundary?: number): EventEnvelope[] {
    const end = boundary === undefined ? this.log.length - 1 : boundary
    if (!Number.isInteger(end) || end < -1 || end >= this.log.length) {
      throw new SessionForkError('INVALID_BOUNDARY', `fork boundary ${String(boundary)} is out of range`)
    }
    const slice = this.log.slice(0, end + 1)
    for (let i = slice.length - 1; i >= 0; i--) {
      const type = slice[i]!.type
      if (type === 'turn/end') break
      if (type === 'turn/start') throw new SessionForkError('OPEN_TURN', 'cannot fork inside an open turn')
    }
    return slice.map((event, index) => ({ ...event, seq: index }))
  }
}
