// @ts-check
/**
 * The session panel: the facts about the open session a person may want and
 * the few things they may do about them — the grants they gave (and can take
 * back), the background jobs (and their stop), the subagents (opened
 * read-only), where it works and what it runs on.
 *
 * Every fact is the host's: the view (`SessionView`, the folds a page cannot
 * compute), the header, the listing. A button only asks; its effect arrives
 * as a durable event and a view push like any other.
 */
import { clock, compactAgo, duration } from './format.js'
import { icon } from './icons.js'
import { jobEnded, subjectText, tokens } from './rows.js'
import { copyButton, h } from './ui.js'

/** @typedef {import('../../capabilities/protocol/frames.ts').SessionView} SessionView */
/** @typedef {import('../../capabilities/protocol/frames.ts').SessionSummary} SessionSummary */
/** @typedef {import('../../core/session/types.ts').SessionHeader} SessionHeader */

/**
 * @typedef {{
 *   sessionId: string,
 *   header?: SessionHeader,
 *   view?: SessionView,
 *   summary?: SessionSummary,
 *   children: readonly SessionSummary[],
 *   stopping: ReadonlySet<string>,
 *   workspace?: string,
 * }} PanelState
 */

/**
 * @param {{ host: HTMLElement, onRevoke: (grantId: string) => void, onStopJob: (jobId: string) => void, onOpen: (sessionId: string) => void }} options
 */
export function createPanel(options) {
  const { host } = options

  /** @param {PanelState} state */
  function render(state) {
    const view = state.view
    /** @type {Node[]} */
    const sections = []

    const created = state.header?.createdAt ?? state.summary?.createdAt
    const updated = state.summary?.updatedAt
    sections.push(
      section(
        'Session',
        'info',
        kv([
          ['Id', h('span', { class: 'mono' }, h('span', { text: state.sessionId }), copyButton(() => state.sessionId, 'Copy session id'))],
          ...(created ? [/** @type {[string, Node | string]} */ (['Created', `${clock(created, Date.now())} · ${compactAgo(created, Date.now())} ago`])] : []),
          ...(updated ? [/** @type {[string, Node | string]} */ (['Last write', `${compactAgo(updated, Date.now())} ago`])] : []),
          ...(state.workspace ? [/** @type {[string, Node | string]} */ (['Workspace', state.workspace])] : []),
          ...(state.header?.cwd ? [/** @type {[string, Node | string]} */ (['Folder', h('span', { class: 'mono', text: state.header.cwd })])] : []),
          ...(state.header?.delegatedBy ? [/** @type {[string, Node | string]} */ (['Delegated by', openLink(state.header.delegatedBy, 'parent session')])] : []),
        ]),
      ),
    )

    if (view) {
      const base = view.options
      const route = view.route
      /** @type {[string, Node | string][]} */
      const rows = []
      if (base) rows.push(['Model', `${base.provider}/${base.model}${base.reasoningEffort ? ` · ${base.reasoningEffort}` : ''}`])
      if (route && (!base || route.provider !== base.provider || route.model !== base.model)) rows.push(['Last step ran on', `${route.provider}/${route.model}`])
      if (route?.contextWindow) rows.push(['Window', `${tokens(route.contextWindow)} tokens`])
      if (view.context && view.context.budgetTokens > 0) rows.push(['Context', `${Math.round(view.context.ratio * 100)}% · ${tokens(view.context.projectedTokens)} of ${tokens(view.context.budgetTokens)}`])
      sections.push(section('Model and context', 'gauge', kv(rows)))

      const authority = view.authority
      const shell = authority.accepts === 'full' ? `enforced (${authority.enforcement} on this host)` : `accepts ${authority.accepts} · host enforces ${authority.enforcement}`
      const authorityRows = kv([
        ['Sandbox', authority.sandbox],
        ['Approvals', authority.approval === 'ask' ? 'ask before wider access' : 'never ask'],
        ['Shell', shell],
        ...(authority.preset ? [/** @type {[string, Node | string]} */ (['Preset', authority.preset])] : []),
      ])
      /** @type {Node[]} */
      const grants = []
      for (const grant of authority.grants) {
        const revoke = h('button', { class: 'btn outline sm', text: 'Revoke', attrs: { type: 'button', 'aria-label': `Revoke grant ${grant.id}` } })
        revoke.disabled = view.drivable === false
        revoke.addEventListener('click', () => {
          revoke.disabled = true
          options.onRevoke(grant.id)
        })
        grants.push(h('div', { class: 'panel-row' }, icon('check-circle', { size: 14 }), h('span', { class: 'grow mono', text: `${grant.toolName}: ${subjectText(grant.subject)}`, attrs: { title: `${grant.id}\n${subjectText(grant.subject)}` } }), revoke))
      }
      sections.push(
        section(
          'Authority',
          'shield',
          authorityRows,
          h('div', { class: 'panel-title', text: 'Standing grants' }),
          grants.length > 0 ? h('div', {}, ...grants) : h('div', { class: 'panel-empty', text: 'None. "Allow for this session" on an approval adds one.' }),
        ),
      )

      /** @type {Node[]} */
      const jobs = []
      for (const job of view.jobs) {
        const end = h('span', { class: 'muted' })
        if (job.state === 'running') {
          const stop = h('button', { class: 'btn outline sm', text: state.stopping.has(job.jobId) ? 'Stopping…' : 'Stop', attrs: { type: 'button', 'aria-label': `Stop job ${job.label}` } })
          stop.disabled = state.stopping.has(job.jobId) || view.drivable === false
          stop.addEventListener('click', () => {
            stop.disabled = true
            stop.textContent = 'Stopping…'
            options.onStopJob(job.jobId)
          })
          end.append(stop)
        } else end.textContent = job.end ? jobEnded(job.end) : 'no end recorded'
        jobs.push(
          h(
            'div',
            { class: 'panel-row', attrs: { title: `${job.label}\n${job.jobId}${job.pid === undefined ? '' : `\npid ${job.pid}`}` } },
            h('span', { class: `state-dot${job.state === 'running' ? ' jobs' : ''}` }),
            h('span', { class: 'grow mono', text: job.label }),
            job.held ? h('span', { class: 'held-chip', text: 'held' }) : undefined,
            end,
          ),
        )
      }
      sections.push(section('Background jobs', 'clock', jobs.length > 0 ? h('div', {}, ...jobs) : h('div', { class: 'panel-empty', text: 'None.' })))
    }

    /** @type {Node[]} */
    const children = []
    for (const child of state.children) {
      const took = child.updatedAt ? ` · ${duration(child.updatedAt - child.createdAt)}` : ''
      children.push(h('div', { class: 'panel-row' }, icon('users', { size: 14 }), h('span', { class: 'grow', text: child.title ?? child.id, attrs: { title: child.id } }), h('span', { class: 'muted', text: child.live ? 'running' : `done${took}` }), openLink(child.id, 'Open')))
    }
    sections.push(section('Subagents', 'users', children.length > 0 ? h('div', {}, ...children) : h('div', { class: 'panel-empty', text: 'None.' })))

    host.replaceChildren(...sections)
  }

  /** @param {string} title @param {string} glyph @param {...(Node | undefined)} content */
  function section(title, glyph, ...content) {
    return h('section', { class: 'panel-section' }, h('h3', { class: 'panel-title' }, icon(glyph, { size: 14 }), h('span', { text: title })), ...content)
  }

  /** @param {readonly [string, Node | string][]} rows */
  function kv(rows) {
    const list = h('dl', { class: 'kv' })
    for (const [key, value] of rows) list.append(h('dt', { text: key }), h('dd', {}, value))
    return list
  }

  /** @param {string} sessionId @param {string} label */
  function openLink(sessionId, label) {
    const link = h('button', { class: 'child-link', attrs: { type: 'button', title: sessionId } }, h('span', { text: label }), icon('open', { size: 12 }))
    link.addEventListener('click', () => options.onOpen(sessionId))
    return link
  }

  return { render }
}
