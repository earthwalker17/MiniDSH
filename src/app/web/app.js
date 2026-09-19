/**
 * The browser surface. It renders durable events and drives the same control
 * plane the terminal does — and holds no semantics of its own:
 *
 * - Context pressure, the open approvals, the authority and the route all
 *   arrive in `SessionView`, because a client holding one PAGE cannot fold them.
 * - The transcript is the log in seq order, not model history. Nothing here
 *   folds the surface; a compaction shows as the record it is, and the messages
 *   it shadowed are still there when you page back.
 * - Every switch it asks for becomes a durable event it then reads back, like
 *   any other surface.
 */
import { describeRow, tokens } from './rows.js'
import { SessionWindow, Wire } from './wire.js'

const $ = (id) => document.getElementById(id)
const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const state = {
  wire: undefined,
  init: undefined,
  window: undefined,
  /** The growing assistant row, while text is streaming into it. */
  streaming: undefined,
  /** The "… thinking" row, while a reasoning route is between prompt and first token. */
  thinking: undefined,
  /**
   * Every row streamed since the last durable assistant message — usually one,
   * two when a retried attempt abandoned its partial text. They are removed
   * when the message that replaces them arrives, so nothing else has to.
   */
  streamRows: [],
  pendingApproval: undefined,
  workspaceId: undefined,
  /**
   * The live status, kept beside the view: `session.status` flips at turn end,
   * but the last `session.view` was published mid-turn and still says
   * `running`. Re-rendering from the view alone would put a finished turn back
   * into "running" and leave it there.
   */
  status: undefined,
}

// ---- rendering -------------------------------------------------------------

/**
 * One row per event. WHAT a row says lives in `rows.js`, DOM-free and typed
 * against the core event kinds, where a test holds it to the visibility of the
 * plain-text projection; this only builds the nodes.
 */
function row(event) {
  const described = describeRow(event)
  if (!described) return undefined
  if (described.who === undefined) return el('div', described.cls, described.text)
  const node = el('div', described.cls)
  node.append(el('div', 'who', described.who), el('div', 'body', described.text))
  return node
}

/**
 * Within this of the bottom counts as "reading the tail", so the transcript
 * follows. Further up means the reader went looking for something, and yanking
 * them back is the defect this number exists to avoid.
 */
const STICK_SLACK_PX = 40

const atBottom = () => {
  const log = $('log')
  return log.scrollHeight - log.scrollTop - log.clientHeight <= STICK_SLACK_PX
}

/**
 * Scroll ownership is sampled just BEFORE each mutation and never stored.
 *
 * The reference implementation needs a ledger of its own scroll writes to tell
 * them from the reader's, because it keeps bottom-ownership as state driven by
 * scroll events. Nothing here listens to a scroll event at all, so there is
 * nothing to confuse: the question "was the reader at the bottom a moment ago"
 * is answered by reading the geometry a moment ago.
 *
 * That only stays true if the write happens in the same tick as the sample. A
 * first version deferred it to an animation frame, which reads better and is
 * wrong: a delta arriving between the sample and the frame measures a deficit
 * this code created and has not paid back yet, so a reader following at the
 * bottom is dropped mid-answer. One synchronous write per delta is what the
 * old code did, and the streaming path was never where the cost was.
 */
function toBottom() {
  const log = $('log')
  log.scrollTop = log.scrollHeight
}

/** Drops any partially streamed rows: the durable message replaces them, and a failed attempt leaves none. */
function dropStreamRows() {
  for (const node of state.streamRows.splice(0)) node.remove()
  state.streaming = undefined
  state.thinking = undefined
}

/** A fresh page replaces the window, so it replaces the rows. Everything else extends them. */
function resetTranscript() {
  const window_ = state.window
  $('rows').replaceChildren()
  dropStreamRows()
  $('damaged').hidden = !window_?.damaged
  $('more').hidden = !window_?.hasMore
  if (!window_) return
  appendRows(window_.events)
  toBottom()
}

function appendRows(events) {
  const stick = atBottom()
  const rows = $('rows')
  for (const event of events) {
    // A committed assistant message is what the streamed rows were previewing.
    if (event.type === 'assistant/message' || event.type === 'turn/end') dropStreamRows()
    const node = row(event)
    if (node) rows.append(node)
  }
  if (stick) toBottom()
}

/**
 * An older page goes in at the head, and the reader stays where they were.
 *
 * The height delta is exact here because the prepend is the only mutation in
 * this frame — nothing else resizes, and no image loads late into a row. That
 * is why this needs no anchor element: with one mutation, "how much taller did
 * the content get above me" and "which row was I looking at" are the same
 * answer.
 */
function prependRows(events) {
  const log = $('log')
  const rows = $('rows')
  const before = log.scrollHeight
  const top = log.scrollTop
  const fragment = document.createDocumentFragment()
  for (const event of events) {
    const node = row(event)
    if (node) fragment.append(node)
  }
  rows.prepend(fragment)
  // Hidden BEFORE the height is read, not after: the button sits above the
  // rows, so on the last page — the one that flips `hasMore` — removing it
  // afterwards takes its height off the content above the reader and undoes
  // the compensation just written.
  $('more').hidden = !state.window?.hasMore
  log.scrollTop = top + (log.scrollHeight - before)
}

function renderView() {
  const view = state.window?.view
  // Session-scoped controls mean nothing without a session, and a knob showing
  // its first option reads as a setting that is in force. Disable until there
  // is something for them to act on.
  for (const id of ['sandbox', 'approval', 'compact', 'cancel']) $(id).disabled = !view
  $('status').textContent = view ? (state.status ?? view.status) : ''
  $('context').textContent =
    view?.context && view.context.budgetTokens > 0
      ? `ctx ${Math.round(view.context.ratio * 100)}% · ${tokens(view.context.projectedTokens)}/${tokens(view.context.budgetTokens)}`
      : ''
  $('route').textContent = view?.route ? `${view.route.provider}/${view.route.model}` : view?.options ? `${view.options.provider}/${view.options.model}` : ''
  $('authority').textContent = view ? `${view.authority.sandbox} · approvals ${view.authority.approval}${view.authority.preset ? ` · ${view.authority.preset}` : ''}` : ''
  $('sandbox').value = view?.authority.sandbox ?? ''
  $('approval').value = view?.authority.approval ?? ''

  const open = view?.pendingApprovals?.[0]
  state.pendingApproval = open
  $('approval-bar').hidden = !open
  if (open) $('approval-text').textContent = `allow ${open.toolName}${open.reason ? ` — ${open.reason}` : ''}?`
}

/**
 * Live text goes straight into a growing row, so the answer types itself out.
 *
 * The rows live in `state.streamRows` rather than being rebuilt away: the
 * durable `assistant/message` that replaces them is what removes them, so a
 * `tool/call` or a view push arriving mid-stream no longer wipes the answer a
 * reader is in the middle of.
 */
function stream(event) {
  const chunk = event.data?.chunk
  if (!chunk) return
  if (chunk.type === 'reasoning-delta') {
    // The same decision the terminal already made, in a different form: a
    // reasoning route can think for a long time, and a surface that shows
    // nothing while it does looks broken rather than busy.
    if (!state.thinking) {
      // Sampled BEFORE the append, like every other mutation here: appending
      // the row is itself what would make the answer wrong afterwards.
      const stick = atBottom()
      state.thinking = el('div', 'row note thinking', '… thinking')
      state.streamRows.push(state.thinking)
      $('rows').append(state.thinking)
      if (stick) toBottom()
    }
    return
  }
  if (chunk.type === 'text-delta') {
    const stick = atBottom()
    if (!state.streaming) {
      state.streaming = el('div', 'row assistant streaming')
      state.streaming.append(el('div', 'who', 'assistant'), el('div', 'body', ''))
      state.streamRows.push(state.streaming)
      $('rows').append(state.streaming)
    }
    state.streaming.querySelector('.body').textContent += chunk.text
    // A reader who scrolled away STAYS away. This was the loudest defect the
    // real-browser pass found: parked 200 px down a long transcript, the first
    // delta of the next answer threw the view to the bottom and held it there.
    if (stick) toBottom()
  } else if (chunk.type === 'finish') {
    // The row STAYS until its durable message lands; clearing the handle only
    // means the next attempt opens a row of its own instead of appending to a
    // finished one.
    state.streaming = undefined
    state.thinking = undefined
  }
}

// ---- session plumbing ------------------------------------------------------

function flash(text, kind) {
  const node = $('error')
  node.className = `banner ${kind}`
  node.textContent = text
  node.hidden = false
  setTimeout(() => void (node.hidden = true), 6000)
}

const fail = (error) => flash(String(error?.message ?? error), 'error')
/** An ordinary outcome worth saying out loud. A command that answers nothing reads as a broken button. */
const notice = (text) => flash(text, 'notice')

async function openSession(sessionId) {
  if (state.window && state.window.sessionId !== sessionId) await state.wire.request('session/detach', { sessionId: state.window.sessionId }).catch(() => undefined)
  // The header moves with the window, BEFORE the attach that can fail: a
  // rejected attach (the host is down, and nothing in the sidebar says so)
  // would otherwise leave the previous session's id above a window that is
  // already this one, and the reconnect then paints this session's transcript
  // under that name.
  $('session-id').textContent = sessionId
  nameSession(undefined)
  state.status = undefined
  // Its own identity, so a change from a window this client has moved on from
  // cannot paint into the transcript that replaced it — a backward page still
  // in flight when `new` is clicked used to render the old session's rows into
  // an empty "new session".
  const opened = new SessionWindow(state.wire, sessionId, (change) => {
    if (state.window === opened) renderAll(change)
  })
  state.window = opened
  await opened.attach()
  await refreshSessions()
}

/**
 * One dispatch over what the window says it did. A `view` push moves the pills
 * and nothing else — it used to rebuild the entire transcript, which is how a
 * mid-turn status update could delete a half-streamed answer.
 */
function renderAll(change) {
  const kind = change?.kind ?? 'reset'
  if (kind === 'reset') resetTranscript()
  else if (kind === 'append') appendRows(change.events)
  else if (kind === 'prepend') prependRows(change.events)
  renderView()
}

async function refreshSessions() {
  const { sessions } = await state.wire.request('sessions/list', state.workspaceId ? { workspaceId: state.workspaceId } : undefined)
  const list = $('sessions')
  list.replaceChildren()
  for (const session of sessions) {
    const item = el('button', `session${session.id === state.window?.sessionId ? ' current' : ''}`)
    const short = session.id.replace(/^session-/, '').slice(0, 8)
    // The name first, the id demoted beside the date: a list of ids is a list
    // nobody can pick from, and the id still has to be here because it is what
    // `minidsh resume` takes.
    item.append(el('span', 'name', session.title ?? short), el('span', 'when', `${short} · ${new Date(session.createdAt).toLocaleString()}`))
    item.title = session.title ? `${session.title}\n${session.id}\n${session.cwd}` : `${session.id}\n${session.cwd}`
    if (session.live) item.append(el('span', 'live', 'live'))
    if (session.delegatedBy) item.append(el('span', 'tag', 'child'))
    item.addEventListener('click', () => void openSession(session.id).catch(fail))
    list.append(item)
    if (session.id === state.window?.sessionId) nameSession(session.title)
  }
}

/** The open session's name, in the header and in the tab — one window per session, so the tab can say which. */
function nameSession(title) {
  $('session-name').textContent = title ?? ''
  document.title = title ? `${title} — MiniDSH` : 'MiniDSH'
}

async function send() {
  const box = $('prompt')
  const text = box.value.trim()
  if (!text) return
  box.value = ''
  try {
    const params = state.window
      ? { sessionId: state.window.sessionId, text, mode: 'auto' }
      : { text, ...(state.workspaceId ? { workspaceId: state.workspaceId } : {}) }
    const result = await state.wire.request('session/prompt', params)
    if (!state.window || state.window.sessionId !== result.sessionId) await openSession(result.sessionId)
  } catch (error) {
    fail(error)
  }
}

// ---- settings --------------------------------------------------------------

async function openSettings() {
  const described = await state.wire.request('settings/describe')
  // A save that finished while this read was in flight already closed the
  // pane; re-opening it here would undo that and look like the save failed.
  if (state.settingsClosed) return
  const pane = $('settings-fields')
  pane.replaceChildren()
  for (const namespace of described.namespaces) {
    const properties = namespace.schema?.properties ?? {}
    for (const [key, spec] of Object.entries(properties)) {
      const line = el('label', 'field')
      line.append(el('span', 'key', `${namespace.ns}.${key}`))
      const input = el('input')
      input.dataset.ns = namespace.ns
      input.dataset.key = key
      input.dataset.revision = String(namespace.revision)
      input.dataset.kind = Array.isArray(spec.type) ? spec.type[0] : (spec.type ?? 'string')
      // The USER layer is what a field holds; the resolved value is only a
      // placeholder. Showing the resolved value would turn "save" into "pin
      // today's defaults forever", and a later deployment change would stop
      // reaching this user.
      input.value = namespace.user?.[key] ?? ''
      input.placeholder = namespace.value?.[key] ?? ''
      line.append(input)
      pane.append(line)
    }
  }
  $('settings').hidden = false
}

async function saveSettings() {
  state.settingsClosed = false
  const byNamespace = new Map()
  for (const input of $('settings-fields').querySelectorAll('input')) {
    const entry = byNamespace.get(input.dataset.ns) ?? { patch: {}, revision: Number(input.dataset.revision) }
    const raw = input.value.trim()
    if (raw.length > 0) entry.patch[input.dataset.key] = input.dataset.kind === 'number' || input.dataset.kind === 'integer' ? Number(raw) : raw
    byNamespace.set(input.dataset.ns, entry)
  }
  try {
    for (const [ns, entry] of byNamespace) {
      // `replace` so clearing a field means clearing the override, and the
      // revision is the one this pane read — a stale write is refused, not
      // silently applied over someone else edit.
      await state.wire.request('settings/set', { ns, patch: entry.patch, expectedRevision: entry.revision, replace: true })
    }
    state.settingsClosed = true
    $('settings').hidden = true
  } catch (error) {
    fail(error)
    await openSettings()
  }
}

// ---- wiring ----------------------------------------------------------------

async function start() {
  state.wire = new Wire(`ws://${location.host}/ws`, {
    onOpen: async () => {
      $('offline').hidden = true
      try {
        state.init = await state.wire.request('initialize')
        // This surface renders one session at a time, so it watches one at a
        // time. Left un-narrowed it would be counted as an answerer for every
        // approval on the host and park questions it never shows.
        await state.wire.request('session/detach')
        const picker = $('workspace')
        picker.replaceChildren(el('option', undefined, 'every workspace'))
        picker.firstChild.value = ''
        for (const workspace of state.init.workspaces) {
          const option = el('option', undefined, workspace.name)
          option.value = workspace.id
          picker.append(option)
        }
        picker.value = state.workspaceId ?? ''
        // A reconnect re-attaches and REPLACES the window; there is no
        // resume-from-seq in the protocol, by design.
        if (state.window) await state.window.attach()
        await refreshSessions()
      } catch (error) {
        fail(error)
      }
    },
    onClose: () => void ($('offline').hidden = false),
    onNotification: (method, params) => {
      if (params?.sessionId && params.sessionId !== state.window?.sessionId) return
      if (method === 'session.event') {
        if (params.event.type === 'assistant/chunk') {
          stream(params.event)
          // Seen, not stored: the window must still count it, or the next
          // event looks like a hole and pays for a repair that returns nothing.
          state.window?.noted(params.event)
        } else {
          // A session is named a moment AFTER it is created: `session/prompt`
          // answers before the driver has entered the prompt, so the listing
          // this client just refreshed had nothing to name it by. The title's
          // own event is when a name exists, and it arrives once per session.
          if (params.event.type === 'session/title') void refreshSessions().catch(fail)
          void state.window?.apply(params.event).catch(fail)
        }
      } else if (method === 'session.view') {
        state.window?.setView(params.view)
      } else if (method === 'session.status') {
        state.status = params.status
        $('status').textContent = params.status
      } else if (method === 'settings.changed') {
        if (!$('settings').hidden) void openSettings().catch(fail)
      }
    },
  })

  $('prompt').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  })
  $('send').addEventListener('click', () => void send())
  $('more').addEventListener('click', () => void state.window?.older().catch(fail))
  $('new').addEventListener('click', () => {
    // Detach FIRST. Dropping the window locally left this connection watching
    // the old session with nothing to show it: the host still counted it as an
    // answerer for that session's approvals, and would park a question no
    // window here could ever display — the hazard `onOpen`'s own comment names.
    const previous = state.window?.sessionId
    if (previous) void state.wire.request('session/detach', { sessionId: previous }).catch(() => undefined)
    state.window = undefined
    $('session-id').textContent = 'new session'
    nameSession(undefined)
    renderAll({ kind: 'reset' })
    void refreshSessions().catch(fail)
  })
  $('cancel').addEventListener('click', () => {
    // Another client's queued prompts are not this one's to discard.
    if (state.window) void state.wire.request('session/cancel', { sessionId: state.window.sessionId, keepQueued: true }).catch(fail)
  })
  $('compact').addEventListener('click', () => {
    if (!state.window) return
    // The same three outcomes the terminal reports, in the same words. Two of
    // them write no durable event at all, so a browser that only rendered the
    // log showed nothing whatever for a click that had worked.
    void state.wire
      .request('session/compact', { sessionId: state.window.sessionId })
      .then((result) => {
        if (result.kind === 'compacted') {
          notice(`compacted ${result.shadowedNodes} messages (~${tokens(result.surfaceTokensBefore)} → ~${tokens(result.surfaceTokensAfter)})`)
        } else if (result.kind === 'scheduled') {
          notice('the turn is still running; compaction will run before its next step')
        } else {
          notice('nothing worth compacting yet')
        }
      })
      .catch(fail)
  })
  $('workspace').addEventListener('change', (event) => {
    state.workspaceId = event.target.value || undefined
    void refreshSessions().catch(fail)
  })
  for (const knob of ['sandbox', 'approval']) {
    $(knob).addEventListener('change', (event) => {
      if (!state.window) return
      void state.wire.request('session/authority', { sessionId: state.window.sessionId, [knob]: event.target.value }).catch(fail)
    })
  }
  $('allow').addEventListener('click', () => void answer('allowed-once'))
  $('deny').addEventListener('click', () => void answer('rejected'))
  $('settings-open').addEventListener('click', () => {
    state.settingsClosed = false
    void openSettings().catch(fail)
  })
  $('settings-save').addEventListener('click', () => void saveSettings())
  $('settings-close').addEventListener('click', () => {
    state.settingsClosed = true
    $('settings').hidden = true
  })
}

async function answer(outcome) {
  const open = state.pendingApproval
  if (!open || !state.window) return
  $('approval-bar').hidden = true
  try {
    const result = await state.wire.request('approval/answer', { sessionId: state.window.sessionId, id: open.id, outcome })
    // Another client may have answered first; the durable decision is the truth.
    if (result.outcome === 'not-pending') fail(new Error('that approval was already answered'))
  } catch (error) {
    fail(error)
  }
}

renderView()
void start()
