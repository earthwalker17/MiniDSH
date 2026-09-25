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
 * sidecar, never silently destroyed; deeper corruption (a mid-file parse error,
 * a seq gap, a line that is not an event envelope) marks the stored session
 * `damaged` on read, names where and why in its `integrity`, and refuses attach.
 *
 * Single-writer per stored session is this provider's guarantee: publication
 * takes a `<file>.lock` write lease held until disposal — materialized or not —
 * so a second process resuming the same id is refused before it appends a byte
 * (interleaved appends from two processes would collide seqs and truncate the
 * log as damaged on the next read). Provably-dead same-host holders are
 * reclaimed; anything else names the holder and asks for manual cleanup.
 */
import {
  appendFileSync,
  close as fsClose,
  closeSync,
  existsSync,
  fdatasync,
  fsync,
  fsyncSync,
  mkdirSync,
  open,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { Context, Plugin } from '../../kernel/index.ts'
import { PERSISTENCE, type Persistence, type StoredIntegrity, type StoredLease, type StoredSession, type StoredSessionSummary } from '../../core/persistence/index.ts'
import {
  SESSION_CREATED,
  SESSION_DISPOSED,
  SESSION_EVENT,
  SESSION_FLUSH,
  SESSION_FORMAT_VERSION,
  SessionFormatError,
  envelopeFault,
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
  /** The file's size. */
  readonly bytes: number
  /**
   * `torn-line`: an unterminated final fragment (crash artifact; safe to
   * sidecar). `invalid`: a terminated line that is not the next event —
   * deeper corruption, named in `stop`.
   */
  readonly tail: 'none' | 'torn-line' | 'invalid'
  readonly stop?: { readonly line: number; readonly byte: number; readonly reason: string }
}

/**
 * Why a terminated line is not the next event, or `undefined` when it is.
 *
 * A RUN of NULs gets its own words because it is the one shape with a known
 * cause: a power cut after the last sync can leave a zero-filled region where
 * lines had not reached the disk (`JSON.stringify` never emits a raw NUL). A
 * stray NUL byte is corruption like any other, and is named as such.
 */
function lineFault(line: string, expectedSeq: number): { reason: string } | { event: EventEnvelope } {
  if (line.includes(NUL_RUN)) return { reason: 'a run of NUL bytes where a line should be (the signature of a power cut after the last sync)' }
  if (line.includes('\u0000')) return { reason: 'a NUL byte inside a line (corruption)' }
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { reason: 'not JSON' }
  }
  const fault = envelopeFault(parsed)
  if (fault !== undefined) return { reason: fault }
  const event = parsed as EventEnvelope
  if (event.seq !== expectedSeq) return { reason: `seq ${event.seq} where ${expectedSeq} was expected` }
  return { event }
}

/** Eight zero bytes: a filesystem zero-fills whole blocks, and no string this writer emits holds even one. */
const NUL_RUN = '\u0000'.repeat(8)

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
  let stop: ScanResult['stop']
  let offset = 0
  let lineNo = 0
  let first = true
  while (offset < buffer.length) {
    lineNo += 1
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
      const read = lineFault(line, events.length)
      if ('reason' in read) {
        tail = 'invalid'
        stop = { line: lineNo, byte: offset, reason: read.reason }
        break
      }
      events.push(read.event)
    }
    validBytes = lineEnd
    offset = lineEnd
  }
  if (!header) return undefined
  return { header, events, validBytes, bytes: buffer.length, tail, ...(stop === undefined ? {} : { stop }) }
}

/**
 * A stored log of a NEWER format is refused loudly and distinctly from damage:
 * nothing is wrong with it, this reader just cannot faithfully read it.
 */
function refuseFutureVersion(header: SessionHeader, file: string): void {
  if (header.version > SESSION_FORMAT_VERSION) throw new SessionFormatError(header.id, header.version, file)
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

/**
 * Why `<root>/<id>.jsonl` exists and still reads as no session — an empty
 * file, a zero-filled or unterminated first line, a first line that is not a
 * session header — or `undefined` when there is no such file or its header
 * reads. `load` answers "no such session" for both, and a cold reader must
 * not: a power cut at creation zero-fills exactly the header.
 */
export function unreadableHeader(root: string, id: string): string | undefined {
  let buffer: Buffer
  try {
    buffer = readFileSync(join(root, `${encodeURIComponent(id)}.jsonl`))
  } catch {
    return undefined
  }
  if (buffer.length === 0) return 'the file is empty'
  const nl = buffer.indexOf(0x0a)
  const first = buffer.subarray(0, nl === -1 ? buffer.length : nl)
  if (first.includes(0)) return 'NUL bytes where the header line should be'
  if (nl === -1) return 'its header line is unterminated'
  try {
    const parsed = JSON.parse(first.toString('utf8')) as Partial<HeaderLine>
    if (parsed.kind === 'session' && typeof parsed.id === 'string' && typeof parsed.createdAt === 'number' && typeof parsed.version === 'number') return undefined
  } catch {
    // Named below.
  }
  return 'its first line is not a session header'
}

/**
 * The lease on a stored log, read and never taken, removed or reclaimed: what
 * a cold reader needs to say "this log is still being written" rather than
 * read an append in flight as a torn tail. `undefined` when no lock (or an
 * unreadable one) is there.
 */
function readLease(file: string): StoredLease | undefined {
  const holder = readLeaseHolder(`${file}.lock`)
  if (!holder) return undefined
  const alive = holder.host !== hostname() ? 'unknown' : !holderIsDead(holder)
  return { pid: holder.pid, host: holder.host, ...(typeof holder.acquiredAt === 'number' ? { acquiredAt: holder.acquiredAt } : {}), alive }
}

/** The header line is small by construction; a bounded read is all a listing needs. */
const HEADER_READ_BYTES = 64 * 1024
/**
 * How far past the header a listing will look for a name. A session opens with
 * its header, the lifecycle record and the facts creation stamps, the turn and
 * then the prompt — about ten lines — and the title lands directly after that
 * prompt. The bound
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
    const buffer = PREFIX_BUFFER
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

/**
 * One 64 KiB scratch buffer for every prefix read, instead of one per FILE.
 * `readPrefixLines` copies out what it keeps before returning, and the whole
 * listing walk is synchronous, so nothing can hold a view into it across a
 * read. Measured over 2,000 files: about a third of the walk was allocation.
 */
const PREFIX_BUFFER = Buffer.alloc(HEADER_READ_BYTES)

/**
 * The listing is a per-FILE cache keyed by the file's own identity, not a
 * store-wide snapshot with invalidation hooks.
 *
 * `list()` is bounded per file and unbounded in file count, and sessions are
 * never deleted — so a store grows without limit while `sessions/list` is a hot
 * RPC the browser re-issues whenever any session is named. Measured on a warm
 * cache: 49 ms over 100 stored sessions, 441 ms over 1,000, 5.3 s over 5,000,
 * every millisecond of it blocking the host's event loop, because every call in
 * the path is a *Sync* one.
 *
 * `size` and `mtimeMs` are the key because they are exactly what changes when a
 * line is appended: a `statSync` is one syscall against an `open` + 64 KiB
 * `read` + `close` + up to 32 `JSON.parse`. The prefix a summary is folded from
 * is immutable once written, so a hit cannot be stale — and a file this process
 * is itself appending to changes size on every event, which re-reads it.
 */
interface CachedSummary {
  readonly size: number
  readonly mtimeMs: number
  readonly summary: StoredSessionSummary | undefined
}
const summaryCache = new Map<string, CachedSummary>()

function summaryFor(file: string): StoredSessionSummary | undefined {
  const stats = statSync(file, { throwIfNoEntry: false })
  if (stats === undefined) {
    summaryCache.delete(file)
    return undefined
  }
  const cached = summaryCache.get(file)
  if (cached !== undefined && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) return cached.summary
  let summary: StoredSessionSummary | undefined
  try {
    const lines = readPrefixLines(file, TITLE_SCAN_LINES)
    const first = lines[0]
    const parsed = first === undefined ? undefined : (JSON.parse(first) as Partial<HeaderLine>)
    if (parsed !== undefined && parsed.kind === 'session' && typeof parsed.id === 'string' && typeof parsed.createdAt === 'number') {
      const title = foldSessionTitle(prefixEvents(lines))
      summary = { header: parsed as SessionHeader, ...(title === undefined ? {} : { title }) }
    }
  } catch {
    // An unreadable file is skipped — and the skip is cached too, so a file
    // that is not a session log is not re-parsed on every listing.
  }
  summaryCache.set(file, { size: stats.size, mtimeMs: stats.mtimeMs, summary })
  return summary
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
  const live = new Set<string>()
  for (const name of names) {
    const file = join(root, name)
    live.add(file)
    const summary = summaryFor(file)
    if (summary !== undefined) summaries.push(summary)
  }
  // A file that is gone is not remembered: the cache must not outgrow the store.
  for (const file of summaryCache.keys()) if (file.startsWith(root) && !live.has(file)) summaryCache.delete(file)
  return summaries.toSorted((a, b) => b.header.createdAt - a.header.createdAt)
}

/** A materialized or attached session: the file and the descriptor every append goes through. */
interface OpenFile {
  readonly file: string
  readonly fd: number
  /** Bumped by every write to the file: each append, and the snapshot or attach that opened it. */
  gen: number
  /** The highest `gen` a COMPLETED sync covered — one that started at or after it. */
  synced: number
  /** The sync in flight; one file's syncs never overlap. */
  syncing?: Promise<void> | undefined
  /** A file this process created, whose directory entry is not yet synced (POSIX only). */
  dirPending: boolean
}

/** `fdatasync` as a promise: off the event loop, so a web host's other sessions keep running while one waits on its disk. */
function syncData(fd: number): Promise<void> {
  return new Promise((resolve, reject) => fdatasync(fd, (error) => (error ? reject(error) : resolve())))
}

/**
 * A directory's entry list to stable storage (POSIX). Windows has no API for
 * it — a directory cannot be opened for `FlushFileBuffers` from Node — so there
 * a new log's NAME rests on NTFS's own metadata journal (ARCHITECTURE §13).
 */
function syncDirectory(dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    open(dir, 'r', (openError, fd) => {
      if (openError) return reject(openError)
      fsync(fd, (syncError) => fsClose(fd, () => (syncError ? reject(syncError) : resolve())))
    })
  })
}

/** The same, for the one synchronous path that needs it: a new `.torn` sidecar's name, before the truncate it pays for. */
function syncDirectorySync(dir: string): void {
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

class JsonlArchive implements Persistence {
  /**
   * A resolved flush is on stable storage: `onFlush` syncs the file (and, once,
   * its directory on POSIX). Measured 2026-09-26 over several runs, append +
   * `fdatasync` of one log line: Windows NTFS p50 0.7–3.6 ms / p95 0.9–4.4 ms,
   * WSL 2 ext4 p50 2.4–10 ms / p95 4.7–20 ms — the spread is the host's load.
   * A flush with nothing new to sync costs no syscall at all. A tool call pays
   * up to two (after `tool/call`, after `tool/dispatch`), a step one more, and
   * every turn end and every resume one.
   */
  readonly durability = 'synced' as const
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
      const created = this.attach(session, file)
      this.track(session, file, created)
    } catch (error) {
      this.releaseLease(session)
      this.failures.set(session, error)
    }
  }

  /**
   * `created`: this process just made the file, so on POSIX its DIRECTORY
   * entry must be synced once too, or a power cut can keep the data and lose
   * the name. The file's bytes were written before the descriptor opened
   * (snapshot, attach), so it starts dirty.
   */
  private track(session: Session, file: string, created: boolean): void {
    const fd = openSync(file, 'a')
    this.open.set(session, { file, fd, gen: 1, synced: 0, dirPending: created && process.platform !== 'win32' })
    this.tracked.add(session)
  }

  /**
   * A closed descriptor is forgotten with the session: no entry ever names a
   * number the OS may have reused. The close itself waits for a sync in
   * flight — an `fdatasync` still queued on the threadpool must never run on a
   * number the OS has since handed to another session's file and "succeed".
   */
  private close(session: Session): void {
    const opened = this.open.get(session)
    this.tracked.delete(session)
    if (!opened) return
    this.open.delete(session)
    const shut = (): void => {
      try {
        closeSync(opened.fd)
      } catch {
        // Already closed.
      }
    }
    if (opened.syncing) void opened.syncing.then(shut, shut)
    else shut()
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
    // log (resume attaches; a fork mints a new id). Exclusive create, so the
    // check and the write are one step.
    const header: HeaderLine = { kind: 'session', ...session.header }
    const lines = [JSON.stringify(header), ...session.events.map((event) => JSON.stringify(event))]
    try {
      writeFileSync(file, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`session ${session.id}: a stored log with this id already exists; refusing to overwrite`, { cause: error })
      }
      throw error
    }
  }

  /** The resume path: append-only continuation of the existing file. Returns whether it had to CREATE the file. */
  private attach(session: Session, file: string): boolean {
    const scan = scanSessionFile(file)
    if (!scan) {
      // No stored file (or an unreadable header): nothing to attach to.
      this.snapshot(session, file)
      return true
    }
    // Continued in place only at this writer's own format: an older log is
    // read and forked, never extended with events of a format it lacks.
    if (scan.header.version !== SESSION_FORMAT_VERSION) throw new SessionFormatError(scan.header.id, scan.header.version, file)
    if (scan.tail === 'invalid') throw new Error(`session ${session.id}: stored log is damaged; refusing to attach`)
    if (scan.header.id !== session.id || scan.header.createdAt !== session.header.createdAt) {
      throw new Error(`session ${session.id}: stored header does not match the resumed session; refusing to attach`)
    }
    // The file is read (agents.resume → persistence.load) BEFORE the lease is
    // taken at publication, and the lock is free in that gap — so compare
    // against the seed this session actually resumed from, not the log it has
    // already grown (end-seed, a composition stamp). Comparing against the
    // grown length would tolerate a foreign writer's appends and then silently
    // skip that many of this session's own events.
    //
    // Repair closers are IN the seed (`agents.resume` appends them before the
    // session exists), so `liveStart` counts them and this length check alone
    // tolerates up to that many foreign events. The identity below guards that
    // window: every stored event must BE this session's event at its seq, by
    // full value. Type and time were enough while every resumer wrote the same
    // closers; since S16 two versions repair the same tail differently (a
    // synced lifecycle's gate-death reads not-started, 1.0.0 answers unknown
    // under a random id), so a foreign resumer's torn delta can match in type
    // and time while its results say something else.
    if (scan.events.length > session.liveStart) {
      throw new Error(`session ${session.id}: the stored log grew past what this session resumed from; refusing to attach`)
    }
    for (const stored of scan.events) {
      const mine = session.events[stored.seq]
      if (mine === undefined || JSON.stringify(mine) !== JSON.stringify(stored)) {
        throw new Error(`session ${session.id}: the stored log changed since it was loaded (seq ${stored.seq}); refusing to attach`)
      }
    }
    if (scan.tail === 'torn-line') {
      // Preserve the crash artifact in a sidecar rather than destroying bytes;
      // a delimiter keeps fragments from successive crashes individually
      // recoverable (a torn fragment never ends in a newline). ONE append, so
      // a failure between sidecar and truncate cannot leave half a record —
      // its byte count checked, because a full disk makes `writeSync` return
      // short rather than throw — and SYNCED before the truncate, name and
      // all, or a power cut could keep the truncation (journaled metadata)
      // and lose the fragment it moved.
      const torn = readFileSync(file).subarray(scan.validBytes)
      const sidecar = `${file}.torn`
      const created = !existsSync(sidecar)
      const fd = openSync(sidecar, 'a')
      try {
        const record = Buffer.concat([Buffer.from(`# torn ${new Date().toISOString()} (${torn.length} bytes)\n`), torn, Buffer.from('\n')])
        const written = writeSync(fd, record)
        if (written !== record.length) throw new Error(`session ${session.id}: wrote ${written} of ${record.length} bytes of the torn tail to its sidecar; refusing to truncate`)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      if (created && process.platform !== 'win32') syncDirectorySync(dirname(file))
      truncateSync(file, scan.validBytes)
    }
    const delta = session.events.slice(scan.events.length)
    if (delta.length > 0) {
      appendFileSync(file, delta.map((event) => `${JSON.stringify(event)}\n`).join(''), 'utf8')
    }
    return false
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
        opened.gen += 1
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
      this.track(session, file, true)
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
   * The awaited durability checkpoint. It resolves only once everything
   * appended before it is on STABLE storage (`durability: 'synced'`), which is
   * the claim crash repair leans on to read a missing `tool/dispatch` as "the
   * body never ran" (§4); and a swallowed write error surfaces here and keeps
   * surfacing — a failed lease, attach, materialization, append or sync leaves
   * the session permanently un-persisted, so EVERY flush must fail.
   *
   * **Which sync covers which flush.** Two flushes of one session overlap in
   * practice (a timed-out call's dispatch checkpoint is still awaiting while
   * the driver moves on), and a flush that merely JOINED the sync in flight
   * would resolve over a write that landed after that sync began — so the next
   * call's body could run with its `tool/dispatch` still in the page cache.
   * Each flush therefore takes the file's write generation as its target and
   * resolves only after a sync that STARTED at or after it completes; syncs of
   * one file are serialized. A failed sync is never retried: after an fsync
   * error the kernel may have dropped the dirty pages and marked them clean,
   * so a retry could report a success that means nothing.
   *
   * What it costs is measured beside `durability` above.
   */
  async onFlush(session: Session): Promise<void> {
    this.rethrow(session)
    const opened = this.open.get(session)
    if (!opened) return
    const target = opened.gen
    while (opened.synced < target) {
      // Detached since (disposal closes the descriptor): there is no file left
      // to sync through. Resolving here would say a write is on stable storage
      // that no sync ever covered — the one claim this method exists to make.
      if (this.open.get(session) !== opened) throw new Error(`session ${session.id}: detached before its writes were synced`)
      opened.syncing ??= this.sync(session, opened).finally(() => {
        opened.syncing = undefined
      })
      await opened.syncing
      this.rethrow(session)
    }
  }

  private rethrow(session: Session): void {
    const failure = this.failures.get(session)
    if (failure === undefined) return
    throw new Error(`session ${session.id} could not be persisted: ${failure instanceof Error ? failure.message : String(failure)}`, {
      cause: failure,
    })
  }

  /** One sync of one file, covering every write made before it started. Never rejects: a failure is remembered and the file quarantined. */
  private async sync(session: Session, opened: OpenFile): Promise<void> {
    const covers = opened.gen
    try {
      await syncData(opened.fd)
      if (opened.dirPending) {
        await syncDirectory(dirname(opened.file))
        opened.dirPending = false
      }
      opened.synced = Math.max(opened.synced, covers)
    } catch (error) {
      if (!this.failures.has(session)) this.failures.set(session, error)
      this.close(session)
    }
  }

  load(id: string): StoredSession | undefined {
    const file = this.fileFor(id)
    const scan = scanSessionFile(file)
    if (!scan) return undefined
    refuseFutureVersion(scan.header, file)
    const integrity: StoredIntegrity = {
      bytes: scan.bytes,
      readableBytes: scan.validBytes,
      tail: scan.tail === 'none' ? 'none' : scan.tail === 'torn-line' ? 'torn' : 'damaged',
      ...(scan.stop === undefined ? {} : { stop: scan.stop }),
    }
    const lease = readLease(file)
    return {
      header: scan.header,
      events: scan.events,
      integrity,
      ...(scan.tail === 'invalid' ? { damaged: true as const } : {}),
      ...(lease === undefined ? {} : { lease }),
    }
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
