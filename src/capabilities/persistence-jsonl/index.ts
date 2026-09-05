/**
 * JSONL session persistence. A subscriber (not a driven service): it writes the
 * header as line 1 and one event per line, synchronously inside the
 * `session/event` listener through one file descriptor held per session (S1
 * simplification of DSH's write-behind), and provides the `core/persistence`
 * read Definition.
 *
 * A session MATERIALIZES on its first conversation fact — its first surface
 * event — never at publication: a session that opened, recorded its stamps and
 * was abandoned leaves nothing behind (DSH's rule: a created-but-never-appended
 * session is absent). Publication decides the write mode: a `resumed` session
 * ATTACHES to its existing file append-only at publication (the whole-file
 * snapshot is the fresh/fork path and must never run for a resume). A torn
 * final line — the expected crash artifact — is preserved in a `.torn`
 * sidecar, never silently destroyed; deeper corruption (a mid-file parse error
 * or seq gap) marks the stored session `damaged` on read and refuses attach.
 *
 * Single-writer per stored session is this provider's guarantee: publication
 * takes a `<file>.lock` write lease held until disposal — materialized or not —
 * so a second process resuming the same id is refused before it appends a byte
 * (interleaved appends from two processes would collide seqs and truncate the
 * log as damaged on the next read). Provably-dead same-host holders are
 * reclaimed; anything else names the holder and asks for manual cleanup.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, truncateSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { Context, Plugin } from '../../kernel/index.ts'
import { PERSISTENCE, type Persistence, type StoredSession, type StoredSessionSummary } from '../../core/persistence/index.ts'
import {
  SESSION_CREATED,
  SESSION_DISPOSED,
  SESSION_EVENT,
  SESSION_FLUSH,
  SESSION_FORMAT_VERSION,
  foldSessionTitle,
  type EventEnvelope,
  type Session,
  type SessionHeader,
} from '../../core/session/index.ts'

interface HeaderLine extends SessionHeader {
  readonly kind: 'session'
}

/** The write lease a published session holds on its stored log. */
interface LeaseHolder {
  readonly pid: number
  readonly host: string
  readonly acquiredAt: number
}

export interface PersistenceConfig {
  readonly root: string
}

const configSchema = z.strictObject({ root: z.string().min(1) })

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
        const parsed = JSON.parse(line) as Partial<HeaderLine>
        // Shape-check the discriminator the writer stamps: a stray .jsonl whose
        // first line is some other JSON must read as "not a session", not crash.
        if (parsed.kind !== 'session' || typeof parsed.id !== 'string' || typeof parsed.createdAt !== 'number' || typeof parsed.version !== 'number')
          return undefined
        header = parsed as SessionHeader
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

/**
 * A stored log written by a NEWER format is refused loudly (a throw, never
 * `damaged`): silently resuming it under this version would rewrite its header
 * to the current constant and discard whatever the newer format meant.
 */
function refuseFutureVersion(header: SessionHeader): void {
  if (header.version > SESSION_FORMAT_VERSION) {
    throw new Error(
      `session ${header.id}: stored log has format version ${header.version}, but this MiniDSH reads at most ${SESSION_FORMAT_VERSION}`,
    )
  }
}

/** Parses a lock file's holder; `undefined` for a missing or malformed one. */
function readLeaseHolder(lock: string): LeaseHolder | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lock, 'utf8')) as Partial<LeaseHolder>
    if (typeof parsed.pid !== 'number' || typeof parsed.host !== 'string') return undefined
    return parsed as LeaseHolder
  } catch {
    return undefined
  }
}

/** Dead means provably dead: same host AND the signal-0 probe reports ESRCH. */
function holderIsDead(holder: LeaseHolder): boolean {
  if (holder.host !== hostname()) return false
  try {
    process.kill(holder.pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** The header line is small by construction; a bounded read is all a listing needs. */
const HEADER_READ_BYTES = 64 * 1024
/**
 * How far past the header a listing will look for a name. A session opens with
 * its header, the four facts creation stamps, the turn and then the prompt —
 * about eight lines — and the title lands directly after that prompt. The bound
 * is what keeps a listing from parsing a chunk-heavy log line by line if that
 * shape ever changes.
 */
const TITLE_SCAN_LINES = 32

/**
 * The bounded prefix of a stored log: line 1 and the complete lines after it,
 * out of ONE read.
 *
 * This costs nothing that listing did not already pay. The buffer was always
 * 64 KiB; only the first newline was ever used and the rest thrown away, so a
 * title comes out of bytes already in hand — no second syscall, no second seek.
 * A log whose first prompt is bigger than the buffer simply has no complete
 * line to give, and its session lists without a name.
 */
function readPrefixLines(file: string, limit: number): string[] {
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(HEADER_READ_BYTES)
    const length = readSync(fd, buffer, 0, buffer.length, 0)
    const lines: string[] = []
    let from = 0
    while (lines.length < limit) {
      const newline = buffer.indexOf(0x0a, from)
      // Past the read, or a final line the buffer cut in half: not a line yet.
      if (newline === -1 || newline >= length) break
      lines.push(buffer.subarray(from, newline).toString('utf8'))
      from = newline + 1
    }
    return lines
  } finally {
    closeSync(fd)
  }
}

/** The events of a prefix, parsed lazily so a fold that finds its answer early stops the parsing. */
function* prefixEvents(lines: readonly string[]): Generator<EventEnvelope> {
  for (const line of lines.slice(1)) {
    let parsed: EventEnvelope
    try {
      parsed = JSON.parse(line) as EventEnvelope
    } catch {
      return
    }
    if (typeof parsed?.type !== 'string' || typeof parsed.seq !== 'number') return
    yield parsed
  }
}

/** Stored session summaries (the header and the name), newest first; unreadable files skipped. */
function listStoredHeaders(root: string): StoredSessionSummary[] {
  let names: string[]
  try {
    names = readdirSync(root).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return []
  }
  const summaries: StoredSessionSummary[] = []
  for (const name of names) {
    try {
      const lines = readPrefixLines(join(root, name), TITLE_SCAN_LINES)
      const first = lines[0]
      if (!first) continue
      const parsed = JSON.parse(first) as Partial<HeaderLine>
      if (parsed.kind !== 'session' || typeof parsed.id !== 'string' || typeof parsed.createdAt !== 'number') continue
      const title = foldSessionTitle(prefixEvents(lines))
      summaries.push({ header: parsed as SessionHeader, ...(title === undefined ? {} : { title }) })
    } catch {
      // Skip an unreadable file.
    }
  }
  return summaries.toSorted((a, b) => b.header.createdAt - a.header.createdAt)
}

/** A materialized or attached session: the file and the descriptor every append goes through. */
interface OpenFile {
  readonly file: string
  readonly fd: number
}

class JsonlArchive implements Persistence {
  private readonly root: string
  /** Sessions with a file: materialized (first surface event) or attached (resume). */
  private readonly open = new WeakMap<Session, OpenFile>()
  /** The same sessions, iterable, so unloading the row can close every descriptor it holds. */
  private readonly tracked = new Set<Session>()
  /** Published, leased, and not yet materialized: waiting for a conversation fact. */
  private readonly pending = new WeakSet<Session>()
  /** A write failure is remembered and rethrown at every later flush checkpoint. */
  private readonly failures = new WeakMap<Session, unknown>()
  /** Lock-file path per session holding the write lease. */
  private readonly leases = new WeakMap<Session, string>()
  /** Every lock this archive holds → the exact payload it wrote (ownership proof). */
  private readonly held = new Map<string, string>()
  constructor(root: string) {
    this.root = root
    mkdirSync(root, { recursive: true })
  }

  private fileFor(id: string): string {
    return join(this.root, `${encodeURIComponent(id)}.jsonl`)
  }

  /**
   * Publication takes the lease and decides the write mode. A resumed session
   * attaches now; anything else waits, leased, for its first surface event. A
   * failed lease or attach is remembered: later events are dropped and every
   * flush throws.
   */
  onPublished(session: Session): void {
    const file = this.fileFor(session.id)
    try {
      // The lease guards the whole published lifetime, materialized or not: a
      // second process must not be able to attach to a file a live session is
      // about to write, or still appending to. Reads never lock.
      this.acquireLease(session, file)
    } catch (error) {
      this.failures.set(session, error)
      return
    }
    if (session.origin !== 'resumed') {
      this.pending.add(session)
      return
    }
    try {
      this.attach(session, file)
      this.track(session, file)
    } catch (error) {
      this.releaseLease(session)
      this.failures.set(session, error)
    }
  }

  private track(session: Session, file: string): void {
    const fd = openSync(file, 'a')
    this.open.set(session, { file, fd })
    this.tracked.add(session)
  }

  /** A closed descriptor is forgotten with the session: no entry ever names a number the OS may have reused. */
  private close(session: Session): void {
    const opened = this.open.get(session)
    this.tracked.delete(session)
    if (!opened) return
    this.open.delete(session)
    try {
      closeSync(opened.fd)
    } catch {
      // Already closed.
    }
  }

  /**
   * The per-session write lease: exclusive-create of `<file>.lock`. A holder
   * is stale only when its pid is provably dead on THIS host (`ESRCH`; an
   * `EPERM` probe means alive-but-inaccessible, and another host cannot be
   * probed at all) — everything else refuses and names the holder, so pid
   * reuse or a foreign host degrade to a manual `rm` of the lock file, never
   * to two writers.
   *
   * Reclaiming a stale lock is the one TWO-step in this protocol (remove, then
   * create), so it runs under its own exclusive-create mutex: without it two
   * reclaimers racing the same dead holder can both remove and both create,
   * and BOTH would believe they hold the lease. A process that dies inside the
   * steal leaves the mutex behind, which blocks further *reclaims* (never a
   * fresh acquisition) and is named in the refusal — the same manual-cleanup
   * edge the lease already documents.
   */
  private acquireLease(session: Session, file: string): void {
    const lock = `${file}.lock`
    const payload = JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: Date.now() } satisfies LeaseHolder)
    const tryCreate = (): boolean => {
      try {
        writeFileSync(lock, payload, { flag: 'wx' })
        this.leases.set(session, lock)
        this.held.set(lock, payload)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw error
      }
    }
    if (tryCreate()) return
    const holder = readLeaseHolder(lock)
    if (holder && holderIsDead(holder)) {
      const steal = `${lock}.steal`
      let mutex = false
      try {
        writeFileSync(steal, payload, { flag: 'wx' })
        mutex = true
      } catch {
        // Another reclaimer holds the steal mutex; fall through and refuse.
      }
      if (mutex) {
        try {
          // Re-probe under the mutex: the winner of a previous race may have
          // already replaced this lock with a live one.
          const current = readLeaseHolder(lock)
          if (!current || holderIsDead(current)) {
            try {
              unlinkSync(lock)
            } catch {
              // The holder released between the probe and here.
            }
            if (tryCreate()) return
          }
        } finally {
          try {
            unlinkSync(steal)
          } catch {
            // Nothing to clean up.
          }
        }
      }
    }
    const who = holder ? `pid ${holder.pid} on ${holder.host}` : 'an unreadable holder'
    throw new Error(`session ${session.id}: the stored log is locked by ${who}; if that process is gone, remove ${lock}`)
  }

  /** Removes only a lock this archive still owns — never one another process has since taken. */
  private releaseLease(session: Session): void {
    const lock = this.leases.get(session)
    if (!lock) return
    this.leases.delete(session)
    this.releaseLock(lock)
  }

  private releaseLock(lock: string): void {
    const payload = this.held.get(lock)
    this.held.delete(lock)
    try {
      // Identity, not just the path: if an operator's manual cleanup (or a
      // wrong staleness verdict) let another process take this lock, removing
      // it here would hand a THIRD process the same log.
      if (payload !== undefined && readFileSync(lock, 'utf8') !== payload) return
      unlinkSync(lock)
    } catch {
      // Already gone (e.g. stolen after this process was wrongly probed dead).
    }
  }

  /** Unloading the provider must not strand the leases or the descriptors it holds. */
  unload(): void {
    // Deleting the current entry mid-iteration is well-defined for a Set and a Map.
    for (const session of this.tracked) this.close(session)
    for (const lock of this.held.keys()) this.releaseLock(lock)
  }

  /** The fresh/fork path: one whole-file write of the header plus every event so far. */
  private snapshot(session: Session, file: string): void {
    // The store's duplicate-id throw guards LIVE ids only; the stored plane
    // guards itself: a non-resumed publication must never overwrite a stored
    // log (resume attaches; a fork mints a new id).
    if (existsSync(file)) {
      throw new Error(`session ${session.id}: a stored log with this id already exists; refusing to overwrite`)
    }
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
    refuseFutureVersion(scan.header)
    if (scan.tail === 'invalid') throw new Error(`session ${session.id}: stored log is damaged; refusing to attach`)
    if (scan.header.id !== session.id || scan.header.createdAt !== session.header.createdAt) {
      throw new Error(`session ${session.id}: stored header does not match the resumed session; refusing to attach`)
    }
    // The file is read (agents.resume → persistence.load) BEFORE the lease is
    // taken at publication, and the lock is free in that gap — so compare
    // against the seed this session actually resumed from, not the log it has
    // already grown (end-seed, a composition stamp, repair closers). Comparing
    // against the grown length would tolerate a foreign writer's appends and
    // then silently skip that many of this session's own events.
    if (scan.events.length > session.liveStart) {
      throw new Error(`session ${session.id}: the stored log grew past what this session resumed from; refusing to attach`)
    }
    const lastStored = scan.events.at(-1)
    const mine = lastStored ? session.events[lastStored.seq] : undefined
    if (lastStored && (!mine || mine.type !== lastStored.type || mine.time !== lastStored.time)) {
      throw new Error(`session ${session.id}: the stored log changed since it was loaded; refusing to attach`)
    }
    if (scan.tail === 'torn-line') {
      // Preserve the crash artifact in a sidecar rather than destroying bytes;
      // a delimiter keeps fragments from successive crashes individually
      // recoverable (a torn fragment never ends in a newline). ONE append, so
      // a failure between sidecar and truncate cannot leave half a record.
      const torn = readFileSync(file).subarray(scan.validBytes)
      appendFileSync(`${file}.torn`, Buffer.concat([Buffer.from(`# torn ${new Date().toISOString()} (${torn.length} bytes)\n`), torn, Buffer.from('\n')]))
      truncateSync(file, scan.validBytes)
    }
    const delta = session.events.slice(scan.events.length)
    if (delta.length > 0) {
      appendFileSync(file, delta.map((event) => `${JSON.stringify(event)}\n`).join(''), 'utf8')
    }
  }

  onEvent(session: Session, event: EventEnvelope): void {
    const opened = this.open.get(session)
    if (opened) {
      try {
        // The byte count is checked, not assumed. `writeSync` does not loop,
        // and a short write (a full disk, an interrupted call) would leave a
        // fragment the next event appends after — fabricating exactly the
        // mid-file seq gap the quarantine below exists to prevent, while every
        // flush kept reporting success and the driver kept paying for steps.
        const line = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8')
        const written = writeSync(opened.fd, line)
        if (written !== line.length) throw new Error(`wrote ${written} of ${line.length} bytes for event ${event.seq}`)
      } catch (error) {
        if (!this.failures.has(session)) this.failures.set(session, error)
        // Quarantine the file: appending a LATER event after a dropped one would
        // fabricate a seq gap and poison the stored log permanently. From here
        // the session is dropped-and-flagged (every flush keeps failing).
        this.close(session)
      }
      return
    }
    // Materialize on the first conversation fact: the snapshot carries the
    // header and everything appended so far (this event included), and every
    // later event appends through the descriptor.
    if (!this.pending.has(session) || event.surfaceOp === undefined) return
    this.pending.delete(session)
    const file = this.fileFor(session.id)
    try {
      this.snapshot(session, file)
      this.track(session, file)
    } catch (error) {
      this.failures.set(session, error)
    }
  }

  /** A session that never recorded a conversation fact was never materialized, so nothing is left behind. */
  onDisposed(session: Session): void {
    // The lease outlives even a quarantined session (the stored prefix stays
    // guarded while the un-persisted session lives) — released here, always.
    this.releaseLease(session)
    this.pending.delete(session)
    this.close(session)
  }

  /**
   * The awaited durability checkpoint: a swallowed write error surfaces here,
   * and keeps surfacing — a failed lease, attach, materialization or append
   * leaves the session permanently un-persisted, so EVERY flush must fail,
   * not just the first.
   */
  onFlush(session: Session): void {
    const failure = this.failures.get(session)
    if (failure === undefined) return
    throw new Error(`session ${session.id} could not be persisted: ${failure instanceof Error ? failure.message : String(failure)}`, {
      cause: failure,
    })
  }

  load(id: string): StoredSession | undefined {
    const scan = scanSessionFile(this.fileFor(id))
    if (!scan) return undefined
    refuseFutureVersion(scan.header)
    return { header: scan.header, events: scan.events, ...(scan.tail === 'invalid' ? { damaged: true as const } : {}) }
  }

  list(): StoredSessionSummary[] {
    return listStoredHeaders(this.root)
  }
}

/** Provides `ctx.persistence` and writes every published session to `<root>/<id>.jsonl`. */
export const persistenceJsonlPlugin: Plugin<PersistenceConfig> = {
  name: 'persistence-jsonl',
  config: configSchema,
  apply(ctx: Context, config) {
    const archive = new JsonlArchive(config.root)
    ctx.provide(PERSISTENCE, archive)
    // Unloading this row must not strand the locks or descriptors it holds: the
    // listeners below (including the one that releases per session) die with it.
    ctx.effect(() => () => archive.unload(), 'persistence-unload')
    ctx.on(SESSION_CREATED, (session) => archive.onPublished(session))
    ctx.on(SESSION_EVENT, (session, event) => archive.onEvent(session, event))
    ctx.on(SESSION_FLUSH, (session) => archive.onFlush(session))
    ctx.on(SESSION_DISPOSED, (session) => archive.onDisposed(session))
  },
}
