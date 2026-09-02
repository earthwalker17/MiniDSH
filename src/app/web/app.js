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
  streaming: undefined,
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

const messageText = (message) =>
  (message?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
const preview = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/**
 * Every image descriptor a result carries, at any depth.
 *
 * The same line the plain-text projection renders, deliberately: this client is
 * a different projection, not a second copy of one, and the two are allowed to
 * differ in FORM — but not in whether an event is visible at all. Every image
 * MiniDSH produces arrives inside a `tool/result`, so without this the browser
 * shows a bare checkmark for the one event a vision session exists to produce.
 */
const imagesIn = (blocks) => {
  const out = []
  for (const block of blocks ?? []) {
    if (block.type === 'image') out.push(block.text ?? '[image]')
    else if (block.type === 'tool-result') out.push(...imagesIn(block.content))
  }
  return out
}
const tokens = (count) => (count < 1000 ? String(count) : `${(count / 1000).toFixed(count < 100_000 ? 1 : 0).replace(/\.0$/, '')}k`)

/**
 * One row per event. A DIFFERENT projection from `app/present.ts` on purpose:
 * that one is the single projection every PLAIN-TEXT surface shares, and this
 * one renders structure a terminal cannot. Neither folds the surface.
 */
function row(event) {
  const data = event.data ?? {}
  switch (event.type) {
    case 'user/message': {
      const text = messageText(data.message)
      if (!text) return undefined
      const kind = data.message?.source?.kind
      if (kind !== 'user') return el('div', 'row note', `context (${kind}${data.message?.source?.form ? `: ${data.message.source.form}` : ''})`)
      const node = el('div', 'row user')
      node.append(el('div', 'who', 'you'), el('div', 'body', text))
      return node
    }
    case 'assistant/message': {
      const text = messageText(data.message)
      if (!text) return undefined
      const node = el('div', 'row assistant')
      node.append(el('div', 'who', data.message?.source?.model ?? 'assistant'), el('div', 'body', text))
      return node
    }
    case 'tool/call':
      return el('div', 'row tool', `→ ${data.name} ${preview(data.arguments ?? '', 160)}`)
    case 'tool/result': {
      if (data.error) return el('div', 'row denied', `✗ ${data.error.code}`)
      const images = imagesIn(data.message?.content)
      return el('div', 'row ok', images.length === 0 ? '✓' : `✓ ${images.join(' ')}`)
    }
    case 'approval/asked':
      return el('div', 'row note', `? ${data.toolName}${data.reason ? `: ${data.reason}` : ''}`)
    case 'approval/decided':
      return el('div', 'row note', `! ${data.outcome}`)
    case 'sandbox/mode':
      return el('div', 'row note', `[sandbox: ${data.mode} (${data.reason}; enforcement ${data.enforcement})]`)
    case 'approval/policy':
      return el('div', 'row note', `[approvals: ${data.policy}]`)
    case 'authority/preset':
      return el('div', 'row note', `[preset: ${data.name}]`)
    case 'agent/options':
      return data.reason === 'initial'
        ? undefined
        : el('div', 'row note', `[model: ${data.options.provider}/${data.options.model}${data.options.reasoningEffort ? ` · ${data.options.reasoningEffort}` : ''}]`)
    case 'compaction/start':
      return el('div', 'row note', `[compacting ${data.plannedNodes ?? 0} messages · ${data.trigger}]`)
    case 'compaction/end':
      // The applied path already has its own record; a DECLINE had no line
      // anywhere, and an automatic one has no RPC result to carry it either.
      return data.outcome?.kind === 'applied' ? undefined : el('div', 'row note', `[compaction declined: ${data.outcome?.reason}]`)
    case 'compaction/applied':
      return el('div', 'row note', `[compacted ${data.shadowedSeqs?.length ?? 0} messages · ${data.trigger}]`)
    case 'subagent/start':
      return el('div', 'row note', `[subagent ${data.childId} · depth ${data.depth} · ${data.sandbox}, approvals never]`)
    case 'subagent/end':
      return el('div', 'row note', `[subagent ${data.childId} ${data.reason?.kind}]`)
    case 'turn/end':
      return data.reason?.kind === 'completed' ? undefined : el('div', 'row note', `[turn ${data.reason?.kind}${data.reason?.code ? `: ${data.reason.code}` : ''}]`)
    default:
      return undefined
  }
}

function renderTranscript() {
  const window_ = state.window
  const log = $('log')
  log.replaceChildren()
  if (!window_) return
  if (window_.damaged) log.append(el('div', 'row note', '[the stored log is damaged: what follows is the readable prefix, not the whole session]'))
  if (window_.hasMore) {
    // No number: `oldest` is an inclusive lower SEQ bound, not a count, and seq
    // space includes the trace tier a page never carries — so on exactly the
    // chunk-heavy sessions paging exists for it overstated by two orders of
    // magnitude. One click fetches one more page either way.
    const more = el('button', 'more', 'load earlier events')
    more.addEventListener('click', () => void window_.older().catch(fail))
    log.append(more)
  }
  for (const event of window_.events) {
    const node = row(event)
    if (node) log.append(node)
  }
  state.streaming = undefined
  log.scrollTop = log.scrollHeight
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

/** Live text goes straight into a growing row, so the answer types itself out. */
function stream(event) {
  const chunk = event.data?.chunk
  if (!chunk) return
  if (chunk.type === 'text-delta') {
    if (!state.streaming) {
      state.streaming = el('div', 'row assistant streaming')
      state.streaming.append(el('div', 'who', 'assistant'), el('div', 'body', ''))
      $('log').append(state.streaming)
    }
    state.streaming.querySelector('.body').textContent += chunk.text
    $('log').scrollTop = $('log').scrollHeight
  } else if (chunk.type === 'finish') {
    state.streaming = undefined
  }
}

// ---- session plumbing ------------------------------------------------------

const fail = (error) => {
  $('error').textContent = String(error?.message ?? error)
  $('error').hidden = false
  setTimeout(() => void ($('error').hidden = true), 6000)
}

async function openSession(sessionId) {
  if (state.window && state.window.sessionId !== sessionId) await state.wire.request('session/detach', { sessionId: state.window.sessionId }).catch(() => undefined)
  state.window = new SessionWindow(state.wire, sessionId, renderAll)
  state.status = undefined
  await state.window.attach()
  $('session-id').textContent = sessionId
  await refreshSessions()
}

function renderAll() {
  renderTranscript()
  renderView()
}

async function refreshSessions() {
  const { sessions } = await state.wire.request('sessions/list', state.workspaceId ? { workspaceId: state.workspaceId } : undefined)
  const list = $('sessions')
  list.replaceChildren()
  for (const session of sessions) {
    const item = el('button', `session${session.id === state.window?.sessionId ? ' current' : ''}`)
    item.append(el('span', 'name', session.id.replace(/^session-/, '').slice(0, 8)), el('span', 'when', new Date(session.createdAt).toLocaleString()))
    if (session.live) item.append(el('span', 'live', 'live'))
    if (session.delegatedBy) item.append(el('span', 'tag', 'child'))
    item.addEventListener('click', () => void openSession(session.id).catch(fail))
    list.append(item)
  }
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
        } else void state.window?.apply(params.event).catch(fail)
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
  $('new').addEventListener('click', () => {
    state.window = undefined
    $('session-id').textContent = 'new session'
    renderAll()
  })
  $('cancel').addEventListener('click', () => {
    // Another client's queued prompts are not this one's to discard.
    if (state.window) void state.wire.request('session/cancel', { sessionId: state.window.sessionId, keepQueued: true }).catch(fail)
  })
  $('compact').addEventListener('click', () => {
    if (state.window) void state.wire.request('session/compact', { sessionId: state.window.sessionId }).catch(fail)
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
