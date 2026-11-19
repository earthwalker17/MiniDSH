// @ts-check
/**
 * The sidebar: the mark, a new-session button, the session list, settings
 * and the connection's state.
 *
 * What a row says about its session comes from that session's latest
 * `control.summary` alone (whole-state and superseding, `frames.ts`), never
 * from a fold of this client's own: a question waiting, a notice held for the
 * next message, a turn running, jobs running — in that order, because the
 * first is the one a person must act on. Children are not listed (DSH does
 * the same): a subagent is reached from the card that started it and from
 * the session panel.
 *
 * Below 1024px it is a rail of icons; below 768px a drawer over a scrim.
 */
import { compactAgo, shortId } from './format.js'
import { icon, mark } from './icons.js'
import { h, iconButton } from './ui.js'

/** @typedef {import('../../capabilities/protocol/frames.ts').SessionSummary} SessionSummary */
/** @typedef {import('../../capabilities/protocol/frames.ts').ControlSummary} ControlSummary */
/** @typedef {import('../../capabilities/protocol/frames.ts').WorkspaceInfo} WorkspaceInfo */

/**
 * @typedef {{
 *   app: HTMLElement, sidebar: HTMLElement, brand: HTMLElement, newButton: HTMLButtonElement,
 *   listHead: HTMLElement, filter: HTMLInputElement, list: HTMLElement, foot: HTMLElement, scrim: HTMLElement, main: HTMLElement,
 *   onOpen: (id: string) => void, onNew: () => void, onSettings: () => void,
 * }} SidebarOptions
 */

const NARROW = window.matchMedia('(max-width: 1023px)')
const PHONE = window.matchMedia('(max-width: 767px)')

/** @param {SidebarOptions} options */
export function createSidebar(options) {
  const { app, list } = options
  /** @type {readonly SessionSummary[]} */
  let sessions = []
  /** @type {readonly WorkspaceInfo[]} */
  let workspaces = []
  /** @type {string | undefined} */
  let current
  /** @type {Map<string, ControlSummary>} */
  let summaries = new Map()
  /** @type {Map<string, HTMLElement>} */
  const rows = new Map()
  /** The person's own choice of rail on a wide screen; undefined follows the width. @type {boolean | undefined} */
  let railChosen

  // ---- the frame ----------------------------------------------------------

  const toggle = iconButton('panel-left', 'Collapse sidebar', () => {
    if (PHONE.matches) {
      setDrawer(false)
      return
    }
    railChosen = app.dataset.sidebar !== 'rail'
    layout()
  })
  toggle.classList.add('attention-host')
  options.brand.append(mark(22), h('span', { class: 'brand-name', text: 'MiniDSH' }), toggle)
  options.newButton.append(icon('new-chat', { size: 16 }), h('span', { class: 'label', text: 'New session' }))
  options.newButton.setAttribute('aria-label', 'New session')
  options.newButton.addEventListener('click', () => {
    setDrawer(false)
    options.onNew()
  })
  const search = iconButton('search', 'Filter sessions', () => {
    // The rail has no room for a list: filtering opens the sidebar first.
    if (app.dataset.sidebar === 'rail') {
      railChosen = false
      layout()
      options.filter.hidden = true
    }
    options.filter.hidden = !options.filter.hidden
    search.setAttribute('aria-pressed', String(!options.filter.hidden))
    if (!options.filter.hidden) options.filter.focus()
    else {
      options.filter.value = ''
      render()
    }
  })
  search.setAttribute('aria-pressed', 'false')
  options.listHead.append(h('span', { class: 'label', text: 'Sessions' }), search)
  options.filter.addEventListener('input', () => render())
  options.filter.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      options.filter.value = ''
      search.click()
    }
  })
  const settings = h('button', { class: 'foot-btn', attrs: { type: 'button', 'aria-label': 'Settings' } }, icon('settings', { size: 16 }), h('span', { class: 'label', text: 'Settings' }))
  settings.addEventListener('click', () => {
    setDrawer(false)
    options.onSettings()
  })
  const connection = h('span', { class: 'connection', attrs: { role: 'status' }, hidden: true })
  options.foot.append(settings, connection)
  options.scrim.addEventListener('click', () => setDrawer(false))
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && app.dataset.drawer === 'open') setDrawer(false)
  })

  function layout() {
    // A phone's drawer is the whole sidebar, never the rail.
    const rail = !PHONE.matches && (railChosen ?? NARROW.matches)
    app.dataset.sidebar = rail ? 'rail' : 'full'
    const words = PHONE.matches ? 'Close sessions' : rail ? 'Expand sidebar' : 'Collapse sidebar'
    toggle.setAttribute('aria-label', attention > 0 && rail ? `${words} — ${attentionWords()}` : words)
    toggle.setAttribute('title', words)
    // The rail hides the list, so its toggle carries the dot.
    toggle.querySelector('.attention-dot')?.remove()
    if (attention > 0 && rail) toggle.append(h('span', { class: 'attention-dot', attrs: { 'aria-hidden': 'true' } }))
  }
  for (const query of [NARROW, PHONE]) {
    query.addEventListener('change', () => {
      railChosen = undefined
      setDrawer(false)
      layout()
    })
  }

  /** @type {HTMLElement | undefined} */
  let returnTo
  /** @param {boolean} open */
  function setDrawer(open) {
    if (!PHONE.matches) open = false
    const was = app.dataset.drawer === 'open'
    if (open) app.dataset.drawer = 'open'
    else delete app.dataset.drawer
    options.scrim.hidden = !open
    // While the drawer is open the page behind it takes no focus and no clicks.
    options.main.inert = open
    if (open && !was) {
      returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
      options.newButton.focus()
    }
    if (!open && was && returnTo?.isConnected && options.sidebar.contains(document.activeElement)) returnTo.focus()
    if (!open) returnTo = undefined
  }

  /** Other sessions waiting on a person: a question, or a job update held for them. */
  let attention = 0
  const attentionWords = () => `${attention} other session${attention === 1 ? ' needs' : 's need'} you`
  layout()

  // ---- rows -----------------------------------------------------------------

  function render() {
    rows.clear()
    const query = options.filter.value.trim().toLowerCase()
    // Children are reached from their parent's card and panel, not listed.
    const shown = sessions.filter((session) => !session.delegatedBy && (query.length === 0 || (session.title ?? '').toLowerCase().includes(query) || session.id.toLowerCase().includes(query)))
    if (shown.length === 0) {
      list.replaceChildren(h('div', { class: 'list-empty', text: query ? 'No session matches.' : 'No sessions yet. Start one with a message.' }))
      return
    }
    /** @type {Node[]} */
    const out = []
    const grouped = workspaces.length > 1
    if (!grouped) for (const session of shown) out.push(row(session))
    else {
      const byWorkspace = new Map(workspaces.map((workspace) => [workspace.id, /** @type {SessionSummary[]} */ ([])]))
      /** @type {SessionSummary[]} */
      const other = []
      for (const session of shown) {
        const members = session.workspaceId === undefined ? undefined : byWorkspace.get(session.workspaceId)
        if (members) members.push(session)
        else other.push(session)
      }
      for (const workspace of workspaces) {
        const members = byWorkspace.get(workspace.id) ?? []
        if (members.length === 0) continue
        const holdsCurrent = members.some((session) => session.id === current)
        out.push(h('div', { class: `workspace-row${holdsCurrent ? ' current' : ''}`, attrs: { title: workspace.root } }, icon(holdsCurrent ? 'folder-open' : 'folder', { size: 16 }), h('span', { text: workspace.name })))
        for (const session of members) out.push(row(session))
      }
      if (other.length > 0) {
        out.push(h('div', { class: 'workspace-row' }, icon('folder', { size: 16 }), h('span', { text: 'Elsewhere' })))
        for (const session of other) out.push(row(session))
      }
    }
    list.replaceChildren(...out)
  }

  /** @param {SessionSummary} session */
  function row(session) {
    const short = shortId(session.id)
    const name = session.title ?? `Session ${short}`
    const button = h('button', {
      class: `session-row${session.id === current ? ' current' : ''}`,
      attrs: {
        type: 'button',
        'aria-current': session.id === current ? 'page' : undefined,
        title: [session.title, session.id, session.cwd, `Created ${new Date(session.createdAt).toLocaleString()}`].filter(Boolean).join('\n'),
      },
    })
    button.addEventListener('click', () => {
      setDrawer(false)
      options.onOpen(session.id)
    })
    rows.set(session.id, button)
    fill(button, session, name)
    return button
  }

  /** @param {HTMLElement} button @param {SessionSummary} session @param {string} name */
  function fill(button, session, name) {
    const summary = summaries.get(session.id)
    const dot = h('span', { class: 'dot' })
    const when = h('span', { class: 'when', text: compactAgo(session.updatedAt ?? session.createdAt, Date.now()) })
    let state = ''
    if (summary && summary.status !== 'closed') {
      if (summary.pendingApprovals > 0) {
        dot.append(h('span', { class: 'state-dot ask' }))
        when.textContent = 'Approval'
        when.classList.add('wants')
        state = `${summary.pendingApprovals} question${summary.pendingApprovals === 1 ? '' : 's'} waiting`
      } else if (summary.heldNotices > 0) {
        dot.append(h('span', { class: 'state-dot held' }))
        when.textContent = 'Update'
        when.classList.add('wants')
        state = 'a job update waits for your next message'
      } else if (summary.status === 'running') {
        dot.append(h('span', { class: 'spinner' }))
        state = 'running'
      } else if (summary.runningJobs > 0) {
        dot.append(h('span', { class: 'state-dot jobs' }))
        state = `${summary.runningJobs} job${summary.runningJobs === 1 ? '' : 's'} running`
      }
    }
    button.replaceChildren(dot, h('span', { class: 'title', text: name }), when)
    button.setAttribute('aria-label', state ? `${name}, ${state}` : name)
  }

  return {
    /**
     * @param {{ sessions: readonly SessionSummary[], workspaces: readonly WorkspaceInfo[], current: string | undefined, summaries: Map<string, ControlSummary> }} next
     */
    render(next) {
      sessions = next.sessions
      workspaces = next.workspaces
      current = next.current
      summaries = next.summaries
      render()
    },
    /** One session's summary moved: its row changes in place. @param {string} sessionId */
    updateRow(sessionId) {
      const button = rows.get(sessionId)
      const session = sessions.find((entry) => entry.id === sessionId)
      if (button && session) fill(button, session, session.title ?? `Session ${shortId(session.id)}`)
    },
    /** @param {string} sessionId */
    has(sessionId) {
      return sessions.some((session) => session.id === sessionId)
    },
    /** @param {string | undefined} id */
    setCurrent(id) {
      current = id
      for (const [sessionId, button] of rows) {
        button.classList.toggle('current', sessionId === id)
        if (sessionId === id) button.setAttribute('aria-current', 'page')
        else button.removeAttribute('aria-current')
      }
    },
    /** @param {'online' | 'offline' | 'back'} state */
    setConnection(state) {
      connection.hidden = state === 'online'
      connection.classList.toggle('ok', state === 'back')
      connection.replaceChildren(state === 'offline' ? icon('refresh', { size: 12 }) : icon('check', { size: 12 }), h('span', { class: 'label', text: state === 'offline' ? 'Reconnecting…' : 'Connected' }))
      connection.setAttribute('aria-label', state === 'offline' ? 'The host is not reachable; reconnecting' : 'Connected')
    },
    openDrawer() {
      setDrawer(true)
    },
    /**
     * How many OTHER sessions wait on a person. The rail and the drawer hide
     * the list, so its toggle carries the dot and the count in its name.
     * @param {number} count
     */
    setAttention(count) {
      attention = count
      layout()
    },
  }
}
