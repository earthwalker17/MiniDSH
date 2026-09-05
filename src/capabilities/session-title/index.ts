/**
 * Names a session after the first thing a person asked it.
 *
 * The title is a log-only fact and its fold lives in core (`core/session/title`,
 * which also explains why); this row is the only thing that WRITES one. It is a
 * capability rather than part of the session because choosing a name is policy:
 * a deployment that wants a model-written title replaces this row, and one that
 * wants no titles at all disables it — and a stored log still lists under a
 * name either way, because the fold derives one when nothing recorded it.
 *
 * The record is written rather than derived on every read for the reason a
 * stored image descriptor is: it freezes what this session was called at the
 * moment it was called that, so a later change to how titles are derived cannot
 * silently rename every session already on disk. It also puts the name inside
 * the bounded prefix `persistence.list()` reads, a few lines after the prompt
 * it came from.
 */
import type { Context, Plugin } from '../../kernel/index.ts'
import { SESSION_EVENT, SESSION_TITLE, matches, scanSessionTitle, USER_MESSAGE, type Session } from '../../core/session/index.ts'

/**
 * The append is deferred to a microtask, and that is a rule rather than a
 * style: a `session/event` listener may not append synchronously (ARCHITECTURE
 * §4). Delivery is where the JSONL writer emits its line and the relational
 * invariant commits its staged trace, so an append made inside it reaches the
 * file and the wire BEFORE the event that caused it — and a stored log whose
 * seqs run N+1, N is `damaged` at the next resume. A microtask still runs
 * before the caller resumes, so the title lands directly after its prompt.
 */
function recordLater(session: Session, title: string, messageSeqs: readonly number[]): void {
  queueMicrotask(() => {
    // Re-read: another writer may have recorded one on this same tick, and a
    // session may have been disposed out from under the queued append.
    if (scanSessionTitle(session.facts).recorded !== undefined) return
    try {
      session.append(SESSION_TITLE, { title, messageSeqs: [...messageSeqs], source: { kind: 'fallback' } })
    } catch {
      /* the session went away; a reader still derives the same name */
    }
  })
}

/** Writes one `session/title` per session, the first time a person's prompt gives it a name. */
export const sessionTitlePlugin: Plugin = {
  name: 'session-title',
  apply(ctx: Context) {
    // Per session, so a long conversation does not rescan its own log on every
    // prompt. A session that has not yet seen an ELIGIBLE message is not done:
    // an injected note and a compaction summary are `user/message`s too, and
    // neither names anything.
    const named = new WeakSet<Session>()
    ctx.on(SESSION_EVENT, (session, event) => {
      if (named.has(session) || !matches(event, USER_MESSAGE)) return
      const state = scanSessionTitle(session.facts)
      // A resumed session whose log predates titles is named from the FIRST
      // eligible prompt in its seed, not from the one that just arrived.
      if (state.recorded === undefined && state.fallback === undefined) return
      named.add(session)
      if (state.recorded === undefined) recordLater(session, state.fallback!.title, state.fallback!.messageSeqs)
    })
  },
}
