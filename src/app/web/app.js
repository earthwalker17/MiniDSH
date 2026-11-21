// @ts-check
/**
 * The browser surface: wiring only. It renders durable events and drives the
 * same control plane the terminal does, and holds no semantics of its own:
 *
 * - The transcript is the log in seq order, grouped for reading by
 *   `conversation.js` (presentation, never a fold of the surface), drawn by
 *   `transcript.js`.
 * - Context pressure, the open approvals, the authority, the route, the jobs
 *   and whether a session may be driven arrive in `SessionView`, because a
 *   client holding one PAGE cannot fold them; what every OTHER session wants
 *   from a person arrives as `control.summary`.
 * - Every switch it asks for becomes a durable event it then reads back; a
 *   refused one appends nothing, so the controls redraw from what the runtime
 *   last published.
 * - Which card a tool's call draws is the TOOL's declaration (`display`, in
 *   `initialize` and `session/attach`), never a name this file knows.
 */
import { createApproval } from './approval.js'
import { createComposer } from './composer.js'
import { humanPreset, humanSandbox, shortId } from './format.js'
import { icon, mark } from './icons.js'
import { createPanel } from './panel.js'
import { tokens } from './rows.js'
import { createSettings } from './settings.js'
import { createSidebar } from './sidebar.js'
import { createTranscript } from './transcript.js'
import { announce, byId, closeMenus, confirmDialog, copyText, fail, h, iconButton, showMenu, toast } from './ui.js'
import { SessionWindow, Wire } from './wire.js'

/** @typedef {import('../../capabilities/protocol/frames.ts').InitializeResult} InitializeResult */
/** @typedef {import('../../capabilities/protocol/frames.ts').SessionSummary} SessionSummary */
/** @typedef {import('../../capabilities/protocol/frames.ts').SessionView} SessionView */
/** @typedef {import('../../capabilities/protocol/frames.ts').ControlSummary} ControlSummary */
/** @typedef {import('../../core/tools/types.ts').ToolDisplay} ToolDisplay */
/** @typedef {import('../../core/approval/events.ts').OpenApproval} OpenApproval */

const state = {
  /** @type {Wire} */
  wire: /** @type {any} */ (undefined),
  /** @type {InitializeResult | undefined} */
  init: undefined,
  /** @type {SessionWindow | undefined} */
  window: undefined,
  /** @type {SessionSummary[]} */
  sessions: [],
  /** The latest `control.summary` per session: whole-state and superseding. @type {Map<string, ControlSummary>} */
  summaries: new Map(),
  /** The live status, kept beside the view (a flip publishes both since S22, but `session.status` is the faster). @type {string | undefined} */
  status: undefined,
  /** Each tool's declared presentation: the catalog, overlaid by the open agent's own. @type {Map<string, ToolDisplay | undefined>} */
  tools: new Map(),
  /** @type {Map<string, ToolDisplay | undefined>} */
  sessionTools: new Map(),
  /** Jobs whose stop this client asked for and has no answer to yet. @type {Set<string>} */
  stopping: new Set(),
  /** What the next NEW session starts with, chosen before its first message. */
  pendingNew: /** @type {{ agentOptions?: { provider: string, model: string, reasoningEffort?: string }, authority?: { preset?: string, sandbox?: string, approval?: string, accepts?: string }, workspaceId?: string }} */ ({}),
  /** Messages sent and not yet in the log, by the id `session/prompt` returned. @type {Map<string, HTMLElement>} */
  pending: new Map(),
  connected: false,
  wasOffline: false,
  panelOpen: false,
  /** @type {Map<string, Promise<string>>} */
  images: new Map(),
  imageQueue: Promise.resolve(),
}

// ---- the parts ------------------------------------------------------------------

const main = byId('main')
const sidebar = createSidebar({
  app: byId('app'),
  sidebar: byId('sidebar'),
  brand: byId('brand'),
  newButton: /** @type {HTMLButtonElement} */ (byId('new')),
  listHead: byId('list-head'),
  filter: /** @type {HTMLInputElement} */ (byId('filter')),
  list: byId('sessions'),
  foot: byId('sidebar-foot'),
  scrim: byId('scrim'),
  main: byId('main'),
  onOpen: (id) => void openSession(id).catch(fail),
  onNew: () => newSession(),
  onSettings: () => settings.open(),
})

const transcript = createTranscript({
  rows: byId('rows'),
  live: byId('live'),
  working: byId('working'),
  scroller: byId('log'),
  more: /** @type {HTMLButtonElement} */ (byId('more')),
  historyStart: byId('history-start'),
  toBottom: /** @type {HTMLButtonElement} */ (byId('to-bottom')),
  display: (name) => (state.sessionTools.has(name) ? state.sessionTools.get(name) : state.tools.get(name)),
  loadImage,
  openSession: (id) => void openSession(id).catch(fail),
  loadOlder: () => void state.window?.older().catch(fail),
})

const composer = createComposer({
  form: /** @type {HTMLFormElement} */ (byId('composer')),
  textarea: /** @type {HTMLTextAreaElement} */ (byId('prompt')),
  bar: byId('composer-bar'),
  meta: byId('composer-meta'),
  onSend: (text, mode) => void send(text, mode),
  onStop: () => cancelTurn(),
  onPlus: (anchor) => plusMenu(anchor),
  onPermission: (anchor) => permissionMenu(anchor),
  onModel: (anchor) => modelMenu(anchor),
})

const approval = createApproval({ host: byId('approval'), onAnswer: answer })

const panel = createPanel({
  host: byId('panel'),
  onRevoke: (grantId) => void revoke(grantId),
  onStopJob: (jobId) => void stopJob(jobId),
  onOpen: (id) => {
    togglePanel(false)
    void openSession(id).catch(fail)
  },
})

const settings = createSettings({ dialog: /** @type {HTMLDialogElement} */ (byId('settings')), wire: () => state.wire, init: () => state.init })

// ---- the top bar ------------------------------------------------------------------

const topbar = byId('topbar')
const drawerOpener = iconButton('panel-left', 'Open sessions', () => sidebar.openDrawer(), 'icon-btn drawer-opener')
const crumbs = h('nav', { class: 'crumbs', attrs: { 'aria-label': 'Session' } })
const chips = h('div', { class: 'chip-row' })
const panelToggle = iconButton('sliders', 'Session details', () => togglePanel())
panelToggle.setAttribute('aria-expanded', 'false')
panelToggle.setAttribute('aria-controls', 'panel')
const more = iconButton('more', 'More', () => moreMenu(more))
more.setAttribute('aria-haspopup', 'menu')
more.setAttribute('aria-expanded', 'false')
topbar.append(drawerOpener, crumbs, chips, h('span', { class: 'spacer' }), panelToggle, more)

/** @param {boolean} [open] */
function togglePanel(open = !state.panelOpen) {
  const panelNode = byId('panel')
  const was = state.panelOpen
  const held = panelNode.contains(document.activeElement)
  state.panelOpen = open && state.window !== undefined
  panelNode.hidden = !state.panelOpen
  panelToggle.setAttribute('aria-expanded', String(state.panelOpen))
  if (state.panelOpen) {
    renderPanel()
    if (!was) panelNode.focus()
    void refreshSessions().catch(() => undefined)
  } else if (was && held) panelToggle.focus()
}
document.addEventListener('keydown', (event) => {
  // A menu's or a dialog's Escape closes that alone (the menu marks it handled).
  if (event.key === 'Escape' && !event.defaultPrevented && state.panelOpen && !document.querySelector('dialog[open], .menu')) togglePanel(false)
})
document.addEventListener('pointerdown', (event) => {
  const target = /** @type {Node} */ (event.target)
  if (state.panelOpen && !byId('panel').contains(target) && !panelToggle.contains(target) && !document.querySelector('.menu')?.contains(target)) togglePanel(false)
})

// ---- rendering what the host published ----------------------------------------------

/** The open session's listing entry, when the list has it. */
const currentSummary = () => state.sessions.find((session) => session.id === state.window?.sessionId)

function isLive() {
  const id = state.window?.sessionId
  if (!id) return false
  const control = state.summaries.get(id)
  if (control) return control.status !== 'closed'
  return currentSummary()?.live === true || state.status !== undefined
}

/** The open session's view, as the host publishes it: whole (frames.ts `SessionView`). */
const viewOf = () => /** @type {SessionView | undefined} */ (state.window?.view)

function renderAll() {
  const window_ = state.window
  const view = viewOf()
  const empty = window_ === undefined
  main.toggleAttribute('data-empty', empty && transcript.empty)
  main.toggleAttribute('data-started', !empty)
  panelToggle.hidden = empty
  byId('damaged').hidden = !window_?.damaged
  renderHero()
  renderCrumbs()
  renderChips()
  const pending = view?.pendingApprovals ?? []
  const asking = approval.render(pending)
  const readOnly = view?.drivable === false
  const readonlyBar = byId('readonly')
  readonlyBar.hidden = !readOnly || asking
  if (readOnly && !asking) {
    const parent = view?.drivenBy
    const openParent = h('button', { class: 'text-btn', text: 'Open parent', attrs: { type: 'button' } })
    openParent.addEventListener('click', () => {
      if (parent) void openSession(parent).catch(fail)
    })
    readonlyBar.replaceChildren(icon('users', { size: 16 }), h('span', { class: 'grow', text: 'A subagent at work: read-only until its parent’s delegation ends.' }), parent ? openParent : '')
  }
  byId('composer').hidden = asking || readOnly
  byId('composer-meta').hidden = asking || readOnly
  composer.render(composerState(view))
  renderAttention()
  if (state.panelOpen) renderPanel()
}

/** The dock's height, for what floats above it: kept on every resize, not only on a render. */
new ResizeObserver(() => main.style.setProperty('--dock-h', `${byId('dock').offsetHeight}px`)).observe(byId('dock'))

/**
 * Sessions OTHER than the open one that wait on a person. The list says so on
 * each row; below 1024px the list is hidden, so the control that reveals it
 * carries the count — a question parked elsewhere must still be findable.
 */
let attentionShown = 0
function renderAttention() {
  let count = 0
  for (const summary of state.summaries.values()) {
    if (summary.sessionId === state.window?.sessionId || summary.status === 'closed') continue
    if (state.sessions.find((session) => session.id === summary.sessionId)?.delegatedBy) continue
    if (summary.pendingApprovals > 0 || summary.heldNotices > 0) count++
  }
  sidebar.setAttention(count)
  drawerOpener.querySelector('.attention-dot')?.remove()
  if (count > 0) drawerOpener.append(h('span', { class: 'attention-dot', attrs: { 'aria-hidden': 'true' } }))
  drawerOpener.setAttribute('aria-label', count > 0 ? `Open sessions — ${count} other session${count === 1 ? ' needs' : 's need'} you` : 'Open sessions')
  if (count > attentionShown) announce(count === 1 ? 'Another session needs you.' : `${count} other sessions need you.`)
  attentionShown = count
}

function renderHero() {
  const hero = byId('hero')
  const empty = state.window === undefined
  hero.hidden = !empty
  const workspaceRow = byId('workspace-row')
  workspaceRow.hidden = !empty || (state.init?.workspaces.length ?? 0) < 2
  if (!empty) return
  const version = state.init?.serverInfo.version
  const workspace = chosenWorkspace()
  hero.replaceChildren(
    h('div', { class: 'hero-title' }, mark(34), h('span', { text: 'MiniDSH' }), version ? h('span', { class: 'version-pill', text: version }) : undefined),
    h('p', { class: 'hero-line', text: workspace ? `A new session works in ${workspace.name}. Its log is kept; nothing it does is hidden from you.` : 'Connecting to the host…' }),
  )
  if (!workspaceRow.hidden && workspace) {
    const chip = h('button', { class: 'chip', attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': `Workspace: ${workspace.name}` } }, icon('folder', { size: 14 }), h('span', { class: 'value', text: workspace.name }), icon('chevron-down', { size: 12, className: 'chev' }))
    chip.addEventListener('click', () =>
      showMenu(
        chip,
        (state.init?.workspaces ?? []).map((entry) => ({
          label: entry.name,
          desc: entry.root,
          checked: entry.id === workspace.id,
          onSelect: () => {
            state.pendingNew.workspaceId = entry.id
            renderAll()
          },
        })),
        { label: 'Workspace for the new session' },
      ),
    )
    workspaceRow.replaceChildren(chip)
  }
}

function chosenWorkspace() {
  const workspaces = state.init?.workspaces ?? []
  return workspaces.find((workspace) => workspace.id === state.pendingNew.workspaceId) ?? workspaces[0]
}

function renderCrumbs() {
  crumbs.replaceChildren()
  const window_ = state.window
  if (!window_) return
  const summary = currentSummary()
  const title = summary?.title ?? `Session ${shortId(window_.sessionId)}`
  const parentId = window_.header?.delegatedBy ?? summary?.delegatedBy
  if (parentId) {
    const parent = state.sessions.find((session) => session.id === parentId)
    const crumb = h('button', { class: 'crumb', text: parent?.title ?? `Session ${shortId(parentId)}`, attrs: { type: 'button', title: parentId } })
    crumb.addEventListener('click', () => void openSession(parentId).catch(fail))
    crumbs.append(crumb, h('span', { class: 'crumb-sep', text: '/', attrs: { 'aria-hidden': 'true' } }))
  }
  crumbs.append(h('span', { class: 'crumb current', text: title, attrs: { title: `${title}\n${window_.sessionId}`, 'data-session': window_.sessionId, 'aria-current': 'page' } }))
  document.title = `${title} — MiniDSH`
}

function renderChips() {
  chips.replaceChildren()
  const view = viewOf()
  if (!view) return
  const running = view.jobs.filter((job) => job.state === 'running').length
  const jobsWords = running === 1 ? '1 background job' : `${running} background jobs`
  if (running > 0) chips.append(h('span', { class: 'status-chip', attrs: { title: jobsWords } }, h('span', { class: 'state-dot jobs' }), h('span', { class: 'words', text: jobsWords })))
  // Working now, from the delegations this session's log shows open; a child whose agent merely stays live is not one.
  const children = transcript.runningChildren().size
  const childWords = children === 1 ? '1 subagent working' : `${children} subagents working`
  if (children > 0) chips.append(h('span', { class: 'status-chip', attrs: { title: childWords } }, icon('users', { size: 12 }), h('span', { class: 'words', text: childWords })))
  if (view.drivable === false) chips.append(h('span', { class: 'status-chip', text: 'Read-only' }))
}

/** @param {SessionView | undefined} view */
function composerState(view) {
  const live = isLive()
  const window_ = state.window
  const running = (state.status ?? view?.status) === 'running' && live
  const fresh = window_ === undefined
  const authority = fresh ? pendingAuthority() : view?.authority
  const sandbox = authority?.sandbox ?? 'workspace-write'
  const approvalPolicy = authority?.approval ?? 'ask'
  const accepts = authority?.accepts ?? 'full'
  const preset = authority?.preset
  const options = (fresh ? state.pendingNew.agentOptions : undefined) ?? view?.options ?? (fresh ? state.init?.defaultAgentOptions : undefined)
  const stored = !fresh && !live
  const sub = [approvalPolicy === 'never' ? 'no prompts' : undefined, accepts !== 'full' ? `shell ${accepts}` : undefined].filter(Boolean).join(' · ')
  const placeholder = fresh ? 'Describe what you want MiniDSH to do…' : stored ? 'Send a message to resume this session…' : running ? 'Steer the running turn, or queue for after it (Ctrl+Enter)…' : 'Reply, or ask for the next thing…'
  return {
    canSend: state.connected && view?.drivable !== false,
    running,
    permission: {
      label: preset && preset !== 'custom' ? humanPreset(preset) : humanSandbox(sandbox),
      ...(sub ? { sub } : {}),
      warn: sandbox === 'danger-full-access' || accepts !== 'full',
      disabled: stored || view?.drivable === false,
      ...(stored ? { title: 'Send a message to resume this session; its authority can change once it is live.' } : {}),
    },
    model: {
      label: options ? modelName(options.provider, options.model) : 'Model',
      ...(options?.reasoningEffort ? { sub: options.reasoningEffort } : {}),
      disabled: stored || view?.drivable === false || !state.init,
      ...(stored ? { title: 'Send a message to resume this session; its model can change once it is live.' } : {}),
    },
    ...(view?.context && view.context.budgetTokens > 0
      ? { context: { ratio: view.context.ratio, label: `${tokens(view.context.projectedTokens)} of ${tokens(view.context.budgetTokens)} tokens of context` } }
      : {}),
    held: view?.jobs.filter((job) => job.held).length ?? 0,
    placeholder,
  }
}

/** @param {string} provider @param {string} model */
function modelName(provider, model) {
  const entry = state.init?.providers.find((one) => one.id === provider)?.models.find((one) => one.id === model)
  return entry?.name ?? model
}

/**
 * The authority a NEW session would open with: the person's choices so far
 * over the deployment's default. A chosen preset brings its own sandbox and
 * approval policy — the chip and the menu must not show the default's.
 */
function pendingAuthority() {
  const base = state.init?.defaultAuthority
  const chosen = state.pendingNew.authority
  const preset = chosen?.preset === undefined ? undefined : state.init?.presets.find((entry) => entry.name === chosen.preset)
  return {
    sandbox: chosen?.sandbox ?? preset?.sandbox ?? base?.sandbox ?? 'workspace-write',
    approval: chosen?.approval ?? preset?.approval ?? base?.approval ?? 'ask',
    accepts: chosen?.accepts ?? base?.accepts ?? 'full',
    preset: chosen ? chosen.preset : base?.preset,
    enforcement: base?.enforcement,
  }
}

function renderPanel() {
  const window_ = state.window
  if (!window_) return
  const view = viewOf()
  const summary = currentSummary()
  const workspace = summary?.workspaceId === undefined ? undefined : state.init?.workspaces.find((one) => one.id === summary.workspaceId)?.name
  panel.render({
    sessionId: window_.sessionId,
    ...(window_.header ? { header: window_.header } : {}),
    ...(view ? { view } : {}),
    ...(summary ? { summary } : {}),
    children: state.sessions.filter((session) => session.delegatedBy === window_.sessionId),
    stopping: state.stopping,
    working: transcript.runningChildren(),
    ...(workspace ? { workspace } : {}),
  })
}

// ---- menus ---------------------------------------------------------------------------

/** @param {HTMLElement} anchor */
function plusMenu(anchor) {
  const live = isLive()
  showMenu(
    anchor,
    [
      { label: 'Compact the context', desc: live ? 'Summarize older history so the model keeps working room' : 'Available while the session is live', icon: 'compact', disabled: !live, onSelect: () => compact() },
      ...(state.window ? [{ label: 'Session details', icon: 'sliders', onSelect: () => togglePanel(true) }] : []),
    ],
    { above: true, label: 'Actions' },
  )
}

/** @param {HTMLElement} anchor */
function moreMenu(anchor) {
  const window_ = state.window
  showMenu(
    anchor,
    [
      ...(window_
        ? [
            { label: 'Copy session id', desc: 'To resume it from a terminal', icon: 'copy', onSelect: () => void copyText(window_.sessionId).then((ok) => toast(ok ? 'Session id copied.' : 'Copying is not available here.')) },
            { label: 'Compact the context', icon: 'compact', disabled: !isLive(), onSelect: () => compact() },
            { separator: /** @type {const} */ (true) },
          ]
        : []),
      { label: 'Settings', icon: 'settings', onSelect: () => settings.open() },
    ],
    { align: 'end' },
  )
}

/** @param {HTMLElement} anchor */
function permissionMenu(anchor) {
  const authority = state.window === undefined ? pendingAuthority() : viewOf()?.authority
  const sandbox = authority?.sandbox
  const policy = authority?.approval
  const accepts = authority?.accepts ?? 'full'
  const preset = authority?.preset
  /** @type {import('./ui.js').MenuEntry[]} */
  const entries = [{ heading: 'Presets' }]
  for (const entry of state.init?.presets ?? []) {
    entries.push({
      label: humanPreset(entry.name),
      desc: entry.description ?? `${entry.sandbox} · approvals ${entry.approval}`,
      checked: preset === entry.name,
      warn: entry.sandbox === 'danger-full-access',
      onSelect: () => void switchAuthority({ preset: entry.name }, entry.sandbox === 'danger-full-access'),
    })
  }
  entries.push({ separator: true }, { heading: 'Sandbox (file effects)' })
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
    entries.push({ label: humanSandbox(mode), checked: sandbox === mode, warn: mode === 'danger-full-access', onSelect: () => void switchAuthority({ sandbox: mode }, mode === 'danger-full-access') })
  }
  entries.push({ separator: true }, { heading: 'Approvals' })
  entries.push({ label: 'Ask before wider access', checked: policy === 'ask', onSelect: () => void switchAuthority({ approval: 'ask' }, false) })
  entries.push({ label: 'Never ask', desc: 'Anything wider than the sandbox is refused', checked: policy === 'never', onSelect: () => void switchAuthority({ approval: 'never' }, false) })
  entries.push({ separator: true }, { heading: `Shell (this host enforces ${authority?.enforcement ?? '…'})` })
  entries.push({ label: 'Require an enforced shell', checked: accepts === 'full', onSelect: () => void switchAuthority({ accepts: 'full' }, false) })
  entries.push({ label: 'Accept an unconfined shell', desc: 'Commands run without a sandbox; only the file fence stays', checked: accepts === 'none', warn: true, onSelect: () => void switchAuthority({ accepts: 'none' }, true) })
  showMenu(anchor, entries, { above: true, label: 'Permissions' })
}

/**
 * One switch, held to the runtime's own rules: a live session's is its
 * durable event (read back from the view); a new session's waits for its
 * first message, which creates the session with it before any turn.
 * @param {{ preset?: string, sandbox?: string, approval?: string, accepts?: string }} change
 * @param {boolean} risky
 */
async function switchAuthority(change, risky) {
  if (risky) {
    const ok = await confirmDialog({
      title: change.accepts === 'none' ? 'Accept an unconfined shell?' : 'Allow full access?',
      text:
        change.accepts === 'none'
          ? 'Shell commands will run without a sandbox on this host. The file fence still refuses writes outside the workspace, but a command can reach anything your account can.'
          : 'The agent may write anywhere your account can, without the workspace fence. Every switch is recorded in the session log.',
      confirm: change.accepts === 'none' ? 'Accept unconfined' : 'Allow full access',
    })
    if (!ok) return
  }
  if (!state.window) {
    const current = state.pendingNew.authority ?? {}
    // A preset replaces the sandbox and approval choices; the shell's
    // acceptance is no part of a preset, so choosing it keeps the preset.
    if (change.preset) state.pendingNew.authority = { preset: change.preset, ...(current.accepts ? { accepts: current.accepts } : {}) }
    else if (change.accepts && current.preset) state.pendingNew.authority = { preset: current.preset, accepts: change.accepts }
    else state.pendingNew.authority = { ...(current.preset ? (current.accepts ? { accepts: current.accepts } : {}) : current), ...change }
    renderAll()
    return
  }
  try {
    await state.wire.request('session/authority', { sessionId: state.window.sessionId, ...change })
  } catch (error) {
    fail(error)
  }
  renderAll()
}

/** @param {HTMLElement} anchor */
function modelMenu(anchor) {
  const view = viewOf()
  const current = (state.window ? view?.options : state.pendingNew.agentOptions) ?? state.init?.defaultAgentOptions
  /** @type {import('./ui.js').MenuEntry[]} */
  const entries = []
  for (const provider of state.init?.providers ?? []) {
    entries.push({ heading: provider.id })
    for (const model of provider.models) {
      entries.push({
        label: model.name,
        desc: `${tokens(model.contextWindow)} window${model.inputModalities?.includes('image') ? ' · images' : ''}`,
        checked: current?.provider === provider.id && current?.model === model.id,
        onSelect: () => void switchModel({ provider: provider.id, model: model.id }),
      })
    }
  }
  const entry = state.init?.providers.find((one) => one.id === current?.provider)?.models.find((one) => one.id === current?.model)
  const efforts = entry?.reasoning?.efforts ?? []
  if (efforts.length > 0) {
    entries.push({ separator: true }, { heading: 'Reasoning effort' })
    for (const effort of efforts) {
      entries.push({ label: effort, ...(effort === entry?.reasoning?.defaultEffort ? { desc: 'default' } : {}), checked: (current?.reasoningEffort ?? entry?.reasoning?.defaultEffort) === effort, onSelect: () => void switchModel({ reasoningEffort: effort }) })
    }
  }
  showMenu(anchor, entries, { above: true, align: 'end', label: 'Model' })
}

/** @param {{ provider?: string, model?: string, reasoningEffort?: string }} change */
async function switchModel(change) {
  if (!state.window) {
    const base = state.pendingNew.agentOptions ?? state.init?.defaultAgentOptions
    if (!base) return
    const next = { provider: change.provider ?? base.provider, model: change.model ?? base.model }
    const effort = change.reasoningEffort ?? (change.model === undefined ? base.reasoningEffort : undefined)
    state.pendingNew.agentOptions = effort ? { ...next, reasoningEffort: effort } : next
    renderAll()
    return
  }
  try {
    await state.wire.request('session/model', { sessionId: state.window.sessionId, ...change })
  } catch (error) {
    fail(error)
  }
  renderAll()
}

// ---- commands ----------------------------------------------------------------------------

/**
 * A message is shown the moment it is sent, dimmed, and replaced by the
 * durable one when the log holds it — keyed by the id `session/prompt`
 * returns, since a steer lands at a step boundary and a followup at the next
 * turn, either of which can be a while.
 * @param {string} text @param {'auto' | 'followup'} mode
 */
async function send(text, mode) {
  const window_ = state.window
  const ticket = openTicket
  const bubble = h('div', { class: 'bubble-wrap' }, h('div', { class: 'bubble pending', text, attrs: { 'aria-label': `Sending: ${text}` } }))
  if (window_) showPending(bubble)
  /** @type {Record<string, unknown>} */
  const params = window_
    ? { sessionId: window_.sessionId, text, mode }
    : {
        text,
        ...(state.pendingNew.agentOptions ? { agentOptions: state.pendingNew.agentOptions } : {}),
        ...(state.pendingNew.authority ? { authority: state.pendingNew.authority } : {}),
        ...(chosenWorkspace() ? { workspaceId: chosenWorkspace()?.id } : {}),
      }
  let result
  try {
    result = await state.wire.request('session/prompt', params)
  } catch (error) {
    // Refused: the message went nowhere, so the person gets it back.
    bubble.remove()
    composer.restore(text)
    fail(error)
    return
  }
  if (!window_) {
    // Opened only if the person is still on the new-session page this send started from.
    if (ticket !== openTicket || state.window !== undefined) {
      bubble.remove()
      void refreshSessions().catch(() => undefined)
      return
    }
    state.pendingNew = {}
    try {
      await openSession(result.sessionId)
    } catch (error) {
      // The message was ACCEPTED and its turn runs: only showing its session
      // failed. Said as that, and the text is not handed back, since a second
      // Enter would deliver the same message again. The list names the session.
      toast(`Your message was sent, but its session could not be shown: ${String(/** @type {{ message?: unknown }} */ (error)?.message ?? error)}`, 'error')
      void refreshSessions().catch(() => undefined)
    }
    // Re-read after the await: the open replaced the window.
    const opened = /** @type {SessionWindow | undefined} */ (state.window)
    if (opened && opened.sessionId === result.sessionId && !holds(opened, result.messageId)) showPending(bubble)
  }
  const now = state.window
  if (!now || now.sessionId !== result.sessionId || holds(now, result.messageId)) bubble.remove()
  else state.pending.set(result.messageId, bubble)
}

/** @param {SessionWindow} window_ @param {string} messageId */
const holds = (window_, messageId) => window_.events.some((event) => event.type === 'user/message' && /** @type {any} */ (event.data)?.message?.id === messageId)

/** @param {HTMLElement} bubble */
function showPending(bubble) {
  byId('live').prepend(bubble)
  // A person's own send: the bottom is where they look next, wherever they were.
  transcript.toBottom()
}

function cancelTurn() {
  // Another client's queued prompts are not this one's to discard.
  if (state.window) void state.wire.request('session/cancel', { sessionId: state.window.sessionId, keepQueued: true }).catch(fail)
}

function compact() {
  if (!state.window) return
  // The same three outcomes the terminal reports, in the same words: two of
  // them write no durable event, and a silent click reads as a broken button.
  void state.wire
    .request('session/compact', { sessionId: state.window.sessionId })
    .then((result) => {
      if (result.kind === 'compacted') toast(`Compacted ${result.shadowedNodes} messages (~${tokens(result.surfaceTokensBefore)} → ~${tokens(result.surfaceTokensAfter)} tokens).`)
      else if (result.kind === 'scheduled') toast('The turn is still running; compaction runs before its next step.')
      else toast('Nothing worth compacting yet.')
    })
    .catch(fail)
}

/** @param {OpenApproval} open @param {'allowed-once' | 'rejected'} outcome @param {'grant-session'} [offer] */
async function answer(open, outcome, offer) {
  if (!state.window) return
  try {
    const result = await state.wire.request('approval/answer', { sessionId: state.window.sessionId, id: open.id, outcome, ...(offer ? { offer } : {}) })
    // Another client may have answered first; the durable decision is the truth.
    if (result.outcome === 'not-pending') toast('That approval was already answered.')
    composer.focus()
  } catch (error) {
    fail(error)
  }
}

/** @param {string} grantId */
async function revoke(grantId) {
  if (!state.window) return
  try {
    await state.wire.request('approval/revoke', { sessionId: state.window.sessionId, grantId })
    toast('Grant revoked. The next such action asks again.')
  } catch (error) {
    fail(error)
    renderAll()
  }
}

/** @param {string} jobId */
async function stopJob(jobId) {
  if (!state.window) return
  state.stopping.add(jobId)
  try {
    const result = await state.wire.request('job/cancel', { sessionId: state.window.sessionId, jobId })
    if (result.state !== 'ended') toast(`Job ${jobId}: a stop was requested, but it has not ended yet.`)
  } catch (error) {
    fail(error)
  } finally {
    state.stopping.delete(jobId)
    renderAll()
  }
}

/**
 * An image a call or a person attached, read through the host — one read at
 * a time (a burst of screenshots must not fill the socket's send queue) and
 * once per attachment id (ids are content addresses).
 * @param {Record<string, any>} ref
 * @returns {Promise<string>}
 */
function loadImage(ref) {
  const id = String(ref.id)
  const cached = state.images.get(id)
  if (cached) return cached
  const sessionId = state.window?.sessionId
  if (!sessionId) return Promise.reject(new Error('no session'))
  const read = state.imageQueue.then(async () => {
    const result = await state.wire.request('attachment/read', { sessionId, attachmentId: id })
    const binary = atob(result.data)
    const bytes = new Uint8Array(binary.length)
    for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at)
    return URL.createObjectURL(new Blob([bytes], { type: result.mediaType }))
  })
  state.imageQueue = read.then(
    () => undefined,
    () => undefined,
  )
  state.images.set(id, read)
  read.catch(() => state.images.delete(id))
  return read
}

/** The blob URLs a window made: revoked as it goes, so a long-lived tab holds one session's images at most. */
function dropImages() {
  for (const read of state.images.values()) void read.then((url) => URL.revokeObjectURL(url)).catch(() => undefined)
  state.images.clear()
}

// ---- sessions ------------------------------------------------------------------------------

/**
 * Which navigation is current: every open and every new session takes a new
 * ticket, and one that finds a later ticket after an await stands down — two
 * quick clicks must not leave the first session attached behind the second.
 */
let openTicket = 0
/** The session a navigation in flight is detaching, while it waits. @type {string | undefined} */
let leaving

/** @param {string} sessionId */
async function openSession(sessionId) {
  const ticket = ++openTicket
  if (state.window?.sessionId === sessionId) {
    // Back to the session a newer click was leaving: that click's detach may
    // already have gone out, so this one re-attaches what it shows.
    if (leaving === sessionId) await state.window.attach()
    return
  }
  leaving = state.window?.sessionId
  if (state.window) await state.wire.request('session/detach', { sessionId: state.window.sessionId }).catch(() => undefined)
  leaving = undefined
  if (ticket !== openTicket) return
  closeMenus()
  dropImages()
  state.status = undefined
  state.sessionTools = new Map()
  for (const node of state.pending.values()) node.remove()
  state.pending.clear()
  // Its own identity, so a change from a window this client has moved on from
  // cannot paint into the transcript that replaced it (S7).
  const opened = new SessionWindow(state.wire, sessionId, (change) => {
    if (state.window === opened) onWindowChange(opened, change)
  })
  state.window = opened
  sidebar.setCurrent(sessionId)
  // The identity and the content change together: the session left behind is
  // never shown under the new one's name, neither while the new page is
  // fetched (a cold log is a whole-file parse) nor for good if it is refused.
  transcript.clear()
  renderAll()
  /** @type {Awaited<ReturnType<SessionWindow['attach']>>} */
  let attached
  try {
    attached = await opened.attach()
  } catch (error) {
    // Refused (no such session, a log this build cannot read): nothing is
    // open, and the page says so instead of keeping a composer addressed to a
    // session it does not show. A connection that DROPPED keeps the window:
    // the reconnect re-attaches it.
    if (state.window === opened && state.connected) {
      state.window = undefined
      sidebar.setCurrent(undefined)
      document.title = 'MiniDSH'
      togglePanel(false)
      renderAll()
    }
    throw error
  }
  if (state.window !== opened) {
    // Moved on while attaching: this window's stream is nobody's.
    if (state.window?.sessionId !== sessionId) void state.wire.request('session/detach', { sessionId }).catch(() => undefined)
    return
  }
  state.sessionTools = new Map((attached.tools ?? []).map((tool) => [tool.name, tool.display]))
  transcript.refreshCards()
  await refreshSessions()
}

function newSession() {
  // Detach FIRST: a connection still watching the old session would be
  // counted as an answerer for its approvals and park a question no window
  // here could display (S7).
  const previous = state.window?.sessionId
  openTicket++
  if (previous) void state.wire.request('session/detach', { sessionId: previous }).catch(() => undefined)
  dropImages()
  state.window = undefined
  state.status = undefined
  state.pendingNew = {}
  for (const node of state.pending.values()) node.remove()
  state.pending.clear()
  togglePanel(false)
  transcript.clear()
  sidebar.setCurrent(undefined)
  document.title = 'MiniDSH'
  renderAll()
  composer.focus()
}

/**
 * @param {SessionWindow} opened
 * @param {{ kind: string, events?: readonly any[] }} change
 */
function onWindowChange(opened, change) {
  if (change.kind === 'reset') {
    transcript.reset(opened.events, { sessionId: opened.sessionId, ...(opened.header?.seedLength ? { seedLength: opened.header.seedLength } : {}), cwd: opened.header?.cwd ?? '', hasMore: opened.hasMore, live: isLive() })
    transcript.setView(viewOf(), isLive())
    // A reconnect's fresh page may already hold what was pending.
    for (const [id, node] of state.pending) {
      if (!holds(opened, id)) continue
      node.remove()
      state.pending.delete(id)
    }
  } else if (change.kind === 'append' && change.events) {
    transcript.append(change.events)
    // A child the listing has not seen yet: the panel and the crumbs name it from the listing.
    if (change.events.some((event) => event.type === 'subagent/start' || event.type === 'subagent/end')) refreshSoon()
    for (const event of change.events) {
      if (event.type !== 'user/message') continue
      const id = event.data?.message?.id
      const node = id === undefined ? undefined : state.pending.get(id)
      if (node) {
        node.remove()
        state.pending.delete(id)
      }
    }
  } else if (change.kind === 'prepend' && change.events) transcript.prepend(change.events, opened.hasMore)
  else if (change.kind === 'view') transcript.setView(viewOf(), isLive())
  renderAll()
}

/** One list refresh for a burst of summaries about sessions the list does not show yet. */
let refreshPending = false
function refreshSoon() {
  if (refreshPending) return
  refreshPending = true
  setTimeout(() => {
    refreshPending = false
    void refreshSessions().catch(() => undefined)
  }, 250)
}

async function refreshSessions() {
  const { sessions } = await state.wire.request('sessions/list')
  state.sessions = sessions
  sidebar.render({ sessions, workspaces: state.init?.workspaces ?? [], current: state.window?.sessionId, summaries: state.summaries })
  renderAll()
}

// ---- wiring ----------------------------------------------------------------------------------

function start() {
  state.wire = new Wire(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`, {
    onOpen: async () => {
      // Only pushes that land while THIS connection subscribes outrank its baseline.
      pushedSinceOpen.clear()
      state.connected = true
      sidebar.setConnection(state.wasOffline ? 'back' : 'online')
      drawerOpener.querySelector('.badge-dot')?.remove()
      if (state.wasOffline) {
        announce('Connected again.')
        setTimeout(() => sidebar.setConnection('online'), 2000)
      }
      state.wasOffline = false
      try {
        state.init = await state.wire.request('initialize')
        state.tools = new Map((state.init?.tools ?? []).map((tool) => [tool.name, tool.display]))
        // The browser narrows its EVENT stream to the open session, but stays
        // a control subscriber for all of them: one session's transcript is
        // what it renders, every session's wants are what its list shows.
        // Subscribed BEFORE it narrows: a fresh connection watches everything,
        // so a question asked since the socket opened is parked for it, and
        // narrowing while it is neither a watcher nor yet a subscriber settles
        // that question `unavailable` a moment before this page would show it.
        // A fresh connection's baseline replaces what an old one pushed — but
        // a push that lands before the answer is no older than it, so it stays.
        const fresh = new Map()
        const { sessions: baseline } = await state.wire.request('control/subscribe', {})
        for (const summary of baseline) fresh.set(summary.sessionId, summary)
        for (const [id, summary] of state.summaries) if (!fresh.has(id) && pushedSinceOpen.has(id)) fresh.set(id, summary)
        state.summaries = fresh
        pushedSinceOpen.clear()
        await state.wire.request('session/detach')
        // A reconnect re-attaches and REPLACES the window: there is no
        // resume-from-seq in the protocol, by design.
        if (state.window) {
          const attached = await state.window.attach()
          state.sessionTools = new Map((attached.tools ?? []).map((tool) => [tool.name, tool.display]))
        }
        transcript.refreshCards()
        await refreshSessions()
      } catch (error) {
        fail(error)
      }
    },
    onClose: () => {
      if (state.connected) announce('Disconnected from the host. Reconnecting.')
      state.connected = false
      // The re-attach's view says whether a turn runs; a flip seen before the drop is stale.
      state.status = undefined
      state.wasOffline = true
      sidebar.setConnection('offline')
      if (!drawerOpener.querySelector('.badge-dot')) drawerOpener.append(h('span', { class: 'badge-dot' }))
      renderAll()
    },
    onNotification: (method, params) => {
      // Before the filter below: a summary is about ANY session.
      if (method === 'control.summary') {
        state.summaries.set(params.sessionId, params)
        pushedSinceOpen.add(params.sessionId)
        // A live session the list was drawn without (another client made it) gets a row.
        if (!sidebar.has(params.sessionId) && params.status !== 'closed') refreshSoon()
        else sidebar.updateRow(params.sessionId)
        if (params.sessionId === state.window?.sessionId) renderAll()
        else renderAttention()
        return
      }
      if (method === 'settings.changed') {
        settings.changed()
        return
      }
      if (params?.sessionId && params.sessionId !== state.window?.sessionId) return
      if (method === 'session.event') {
        if (params.event.type === 'assistant/chunk') {
          transcript.chunk(params.event)
          // Seen, not stored: the window must still count it, or the next
          // event looks like a hole and pays for a repair that returns nothing.
          state.window?.noted(params.event)
          return
        }
        // A session is named a moment after it is created: its title event is
        // when a name exists, and it arrives once per session.
        if (params.event.type === 'session/title') void refreshSessions().catch(fail)
        void state.window?.apply(params.event).catch(fail)
      } else if (method === 'session.view') {
        const before = state.window?.view?.pendingApprovals?.length ?? 0
        state.window?.setView(params.view)
        const after = params.view?.pendingApprovals?.length ?? 0
        if (after > before) announce('Approval needed.')
      } else if (method === 'session.status') {
        const was = state.status
        state.status = params.status
        if (was === 'running' && params.status === 'idle') announce('The turn finished.')
        transcript.setView(viewOf(), isLive())
        renderAll()
      }
    },
  })
}
/** Sessions whose summary was pushed since the last (re)connect began. @type {Set<string>} */
const pushedSinceOpen = new Set()

renderAll()
start()
