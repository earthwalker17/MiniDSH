// @ts-check
/**
 * The conversation on the page: `conversation.js`'s blocks as elements.
 *
 * Three rules from earlier sessions are kept here, where they bite:
 *
 * - **The live path GROWS the transcript, never rebuilds it** (ARCHITECTURE
 *   §8, S10): an op appends a block, adds an item, or re-renders the ONE
 *   block or item it names. An older page goes in at the head with an
 *   element anchor restored, because late images and collapsible groups make
 *   a height delta wrong.
 * - **Scroll ownership is sampled just before each mutation and written in
 *   the same task** (S10): a reader at the tail follows, a reader who went
 *   looking stays. The live preview re-renders at most once a frame, and the
 *   sample and the write are both in that frame.
 * - **The view decides pending and running** (`cards.js`): a call with no
 *   result is redrawn when the view changes, never assumed in flight.
 *
 * Expand state lives in a map keyed by block or item key, outside the DOM,
 * so a re-render keeps what the person opened.
 */
import { cardFor, processTitle } from './cards.js'
import { createConversation, fold, prepend, step } from './conversation.js'
import { bytes, clock, duration } from './format.js'
import { icon } from './icons.js'
import { fillMarkdown, highlighted, markdown } from './md.js'
import { subjectParts, tokens } from './rows.js'
import { copyButton, h, lightbox } from './ui.js'

/** @typedef {import('./conversation.js').Model} Model */
/** @typedef {import('./conversation.js').Block} Block */
/** @typedef {import('./conversation.js').Item} Item */
/** @typedef {import('./conversation.js').ToolItem} ToolItem */
/** @typedef {import('./conversation.js').Op} Op */
/** @typedef {import('./conversation.js').Live} Live */
/** @typedef {import('./cards.js').Card} Card */
/** @typedef {import('../../core/session/types.ts').EventEnvelope} EventEnvelope */
/** @typedef {import('../../core/llm/types.ts').ContentBlock} ContentBlock */
/** @typedef {import('../../core/tools/types.ts').ToolDisplay} ToolDisplay */

/**
 * @typedef {{
 *   status?: string,
 *   pendingApprovals?: readonly { id: string, callId?: string }[],
 * }} ViewLike
 */

/**
 * @typedef {{
 *   rows: HTMLElement, live: HTMLElement, working: HTMLElement, scroller: HTMLElement,
 *   more: HTMLButtonElement, historyStart: HTMLElement, toBottom: HTMLButtonElement,
 *   display: (name: string) => ToolDisplay | undefined,
 *   loadImage: (ref: Record<string, any>) => Promise<string>,
 *   openSession: (id: string) => void,
 *   loadOlder: () => void,
 * }} TranscriptOptions
 */

/** Within this of the bottom is "reading the tail" (S10's number). */
const STICK_SLACK_PX = 40

/** The icon each card draws, by the card its tool declared. */
const CARD_ICONS = /** @type {Readonly<Record<string, string>>} */ ({
  terminal: 'terminal',
  edit: 'edit',
  read: 'read',
  search: 'globe',
  browse: 'globe',
  image: 'image',
  delegate: 'users',
  recall: 'layers',
  job: 'clock',
  generic: 'sparkle',
})

/** @param {TranscriptOptions} options */
export function createTranscript(options) {
  const { rows, scroller } = options
  /** @type {Model} */
  let model = createConversation()
  /** @type {Map<string, HTMLElement>} */
  const blockNodes = new Map()
  /** @type {Map<string, HTMLElement>} */
  const itemNodes = new Map()
  /** Expand state by key; absent means the block's default. @type {Map<string, boolean>} */
  const open = new Map()
  /** @type {ViewLike | undefined} */
  let view
  let liveSession = false
  let cwd = ''
  /** @type {Live | undefined} */
  let pendingLive
  let liveFrame = 0
  /** @type {HTMLElement | undefined} */
  let liveNode
  let workingTimer = 0

  const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= STICK_SLACK_PX
  const toBottom = () => {
    scroller.scrollTop = scroller.scrollHeight
  }

  /** The card context the view supplies. */
  const context = () => ({
    cwd,
    running: liveSession && view?.status === 'running',
    pendingCallIds: new Set((view?.pendingApprovals ?? []).map((ask) => ask.callId).filter((id) => typeof id === 'string')),
    asked: model.asked,
    decided: model.decided,
  })

  // ---- blocks ----------------------------------------------------------------

  /** @param {Block} block @returns {HTMLElement} */
  function renderBlock(block) {
    const node = buildBlock(block)
    node.dataset.key = block.key
    node.classList.add('block')
    return node
  }

  /** @param {Block} block @returns {HTMLElement} */
  function buildBlock(block) {
    switch (block.kind) {
      case 'bubble':
        return bubble(block)
      case 'reply': {
        const node = markdown(block.text, { className: `reply${block.interrupted ? ' interrupted' : ''}` })
        return node
      }
      case 'process':
        return processBlock(block)
      case 'context':
        return contextBlock(block)
      case 'opening':
        return openingBlock(block)
      case 'system':
        return h('div', { class: 'system' }, receipt(systemText(block), systemTone(block), block.type === 'approval/decided' && block.data.grantId ? `grant ${block.data.grantId}` : block.type === 'approval/grant' ? `grant ${block.data.id}` : undefined))
      case 'compaction':
        return compactionBlock(block)
      case 'tail':
        return tailBlock(block)
      case 'note':
        return noteBlock(block)
      case 'fork':
        return h('div', { class: 'divider', attrs: { role: 'separator' } }, h('span', { text: 'Forked here — everything above was inherited' }))
    }
  }

  /** @param {Extract<Block, { kind: 'bubble' }>} block */
  function bubble(block) {
    const wrap = h('div', { class: 'bubble-wrap' })
    if (block.images.length > 0) wrap.append(h('div', { class: 'bubble-images' }, ...block.images.map((image) => thumb(image))))
    if (block.text.length > 0) wrap.append(h('div', { class: 'bubble', text: block.text }))
    wrap.append(h('div', { class: 'msg-actions' }, h('span', { class: 'clock', text: clock(block.time, Date.now()), attrs: { title: new Date(block.time).toLocaleString() } }), copyButton(() => block.text, 'Copy message')))
    return wrap
  }

  /** @param {Extract<Block, { kind: 'process' }>} block */
  function processBlock(block) {
    const node = h('div', { class: 'process' })
    syncProcess(node, block)
    return node
  }

  /**
   * A group's header and items. A settled group of two or more items
   * collapses to one line naming the kinds of work it did (DSH's process
   * groups); while its turn runs, every row is in sight.
   * @param {HTMLElement} node @param {Extract<Block, { kind: 'process' }>} block
   */
  function syncProcess(node, block) {
    const settled = isSettled(block)
    const collapsible = settled && block.items.length >= 2
    const expanded = open.get(block.key) ?? false
    node.toggleAttribute('data-collapsible', collapsible)
    node.toggleAttribute('data-open', collapsible && expanded)
    let head = /** @type {HTMLButtonElement | null} */ (node.querySelector(':scope > .group-head'))
    let list = /** @type {HTMLElement | null} */ (node.querySelector(':scope > .group-items'))
    if (!list) {
      list = h('div', { class: 'group-items' })
      node.append(list)
    }
    if (collapsible) {
      const cards = block.items.filter((item) => item.kind === 'tool').map((item) => cardFor(/** @type {ToolItem} */ (item), options.display(/** @type {ToolItem} */ (item).name ?? ''), context()))
      const thoughts = block.items.filter((item) => item.kind === 'thought').length
      const took = groupDuration(block)
      const content = [icon('chevron-right', { size: 14, className: 'chev' }), h('span', { text: processTitle(cards, thoughts) }), took ? h('span', { class: 'took', text: took }) : undefined]
      if (!head) {
        head = h('button', { class: 'group-head', attrs: { type: 'button' } })
        head.addEventListener('click', () => {
          open.set(block.key, !(open.get(block.key) ?? false))
          mutate(() => syncProcess(node, block))
        })
        node.prepend(head)
      }
      head.setAttribute('aria-expanded', String(expanded))
      head.replaceChildren(...content.filter((child) => child !== undefined))
    } else head?.remove()
    // Keyed: an item node is reused (and moved) rather than rebuilt.
    const wanted = block.items.map((item) => itemNode(item))
    for (let at = 0; at < wanted.length; at++) {
      const child = wanted[at]
      if (!child) continue
      if (list.children[at] !== child) list.insertBefore(child, list.children[at] ?? null)
    }
    while (list.children.length > wanted.length) list.lastElementChild?.remove()
  }

  /** @param {Extract<Block, { kind: 'process' }>} block */
  function isSettled(block) {
    const at = model.blocks.indexOf(block)
    for (let next = at + 1; next < model.blocks.length; next++) if (model.blocks[next]?.kind === 'tail') return true
    return false
  }

  /** @param {Extract<Block, { kind: 'process' }>} block */
  function groupDuration(block) {
    let end = 0
    for (const item of block.items) if (item.kind === 'tool' && item.result) end = Math.max(end, item.result.time)
    // Under a second is no news: a refused call answered at once would read "0.0s".
    return end - block.time >= 1000 ? duration(end - block.time) : ''
  }

  /** @param {Item} item @returns {HTMLElement} */
  function itemNode(item) {
    let node = itemNodes.get(item.key)
    if (!node) {
      node = h('div', { class: 'item', attrs: { 'data-item': item.key } })
      itemNodes.set(item.key, node)
      renderItem(node, item)
    }
    return node
  }

  /** @param {HTMLElement} node @param {Item} item */
  function renderItem(node, item) {
    if (item.kind === 'thought') node.replaceChildren(...thoughtItem(item))
    else if (item.kind === 'note') node.replaceChildren(h('div', { class: 'row' }, h('span', { class: 'glyph' }, icon('info', { size: 14 })), h('span', { class: 'summary', text: plain(item.row.text) })))
    else node.replaceChildren(...toolItem(item))
  }

  /** @param {Extract<Item, { kind: 'thought' }>} item */
  function thoughtItem(item) {
    const expanded = open.get(item.key) ?? false
    const first = item.text.trim().split('\n').find((line) => line.trim().length > 0) ?? ''
    const row = h(
      'button',
      { class: 'row', attrs: { type: 'button', 'aria-expanded': String(expanded) } },
      h('span', { class: 'glyph' }, icon('think', { size: 14 })),
      h('span', { class: 'row-title', text: 'Thought' }),
      h('span', { class: 'sep' }),
      h('span', { class: 'summary', text: first }),
    )
    row.addEventListener('click', () => toggleItem(item))
    return expanded ? [row, h('div', { class: 'card' }, markdown(item.text))] : [row]
  }

  /** @param {ToolItem} item */
  function toolItem(item) {
    const card = cardFor(item, options.display(item.name ?? ''), context())
    const expanded = open.get(item.key) ?? false
    const summary = card.status === 'failed' && card.failure ? card.failure : card.summary
    /** @type {(Node | undefined)[]} */
    const parts = [
      h('span', { class: 'glyph' }, icon(CARD_ICONS[card.card] ?? 'sparkle', { size: 14 })),
      h('span', { class: 'row-title', text: card.title }),
    ]
    if (summary) parts.push(h('span', { class: 'sep' }), h('span', { class: `summary${card.path && summary === card.summary ? ' path' : ''}`, text: summary, attrs: { title: summary } }))
    if (card.diffStat) parts.push(h('span', { class: 'suffix' }, h('span', { class: 'stat-add', text: `+${card.diffStat.added}` }), document.createTextNode(' '), h('span', { class: 'stat-del', text: `−${card.diffStat.removed}` })))
    const end = h('span', { class: 'end' })
    if (card.exit) end.append(h('span', { class: 'capsule', text: card.exit.timedOut ? 'timed out' : card.exit.signal ? card.exit.signal : `exit ${card.exit.code}` }))
    if (card.status === 'waiting') end.append(h('span', { class: 'capsule wait', text: 'Waiting for approval' }))
    if (card.status === 'stopped') end.append(h('span', { class: 'capsule wait', text: 'Not run' }))
    if (card.status === 'unknown') end.append(h('span', { class: 'capsule plain', text: item.result ? 'Outcome unknown' : 'No result recorded' }))
    if (card.child) end.append(childLink(card.child.childId))
    if (end.childElementCount > 0) parts.push(end)
    const row = h('button', { class: `row ${card.status}`, attrs: { type: 'button', 'aria-expanded': String(expanded) } }, ...parts.filter((part) => part !== undefined))
    row.addEventListener('click', () => toggleItem(item))
    /** @type {HTMLElement[]} */
    const out = [row]
    if (card.images.length > 0 && (card.card === 'image' || card.card === 'browse')) out.push(h('div', { class: 'thumbs' }, ...card.images.map((image) => thumb(image))))
    if (expanded) out.push(cardBody(card, item))
    return out
  }

  /** @param {string} childId */
  function childLink(childId) {
    const link = h('button', { class: 'child-link', attrs: { type: 'button' } }, h('span', { text: 'Open subagent' }), icon('open', { size: 12 }))
    link.addEventListener('click', (event) => {
      event.stopPropagation()
      options.openSession(childId)
    })
    return link
  }

  /** @param {Item} item */
  function toggleItem(item) {
    open.set(item.key, !(open.get(item.key) ?? false))
    const node = itemNodes.get(item.key)
    if (!node) return
    mutate(() => renderItem(node, item))
    const button = /** @type {HTMLElement | null} */ (node.querySelector('button.row'))
    button?.focus()
  }

  /** @param {Card} card @param {ToolItem} item */
  function cardBody(card, item) {
    const body = h('div', { class: 'card' })
    if (card.receipts.length > 0) body.append(section('Record', h('div', { class: 'receipts' }, ...card.receipts.map((text) => receipt(text, card.exit ? 'bad' : undefined)))))
    for (const part of card.sections) {
      if (part.kind === 'command') body.append(section('Command', h('pre', { class: 'command', text: part.text }), copyButton(() => part.text, 'Copy command')))
      else if (part.kind === 'output') body.append(section(card.card === 'terminal' ? 'Output' : 'Result', part.text.length > 0 ? h('div', { class: `out${part.error ? ' error' : ''}`, text: part.text }) : h('div', { class: 'out empty', text: 'No output' })))
      else if (part.kind === 'diff') {
        const lines = h('div', { class: 'diff' }, ...part.lines.map((line) => h('span', { class: `line ${line.type}`, text: line.text || ' ' })))
        if (part.hidden > 0) lines.append(h('span', { class: 'line hidden', text: `… ${part.hidden} more lines` }))
        body.append(section('Change', lines))
      } else if (part.kind === 'code') {
        const pre = h('pre')
        pre.append(highlighted(part.text, part.lang))
        body.append(section(card.card === 'edit' ? 'Content' : 'Arguments', pre, copyButton(() => part.text)))
      } else if (part.kind === 'markdown') body.append(section(card.card === 'delegate' && part === card.sections[0] && item.result?.text !== part.text ? 'Task' : 'Result', markdown(part.text)))
      else if (part.kind === 'approvals') {
        const list = h('div', { class: 'approvals-list' })
        for (const ask of part.items) {
          list.append(
            h('div', {}, h('div', { class: 'subject', text: ask.subject }), ask.reason ? h('div', { class: 'reason', text: `The model said: ${ask.reason}` }) : undefined, h('div', { class: 'muted', text: decisionWords(ask.outcome, ask.decidedBy) })),
          )
        }
        body.append(section('Approval', list))
      } else if (part.kind === 'fields') {
        const list = h('dl', { class: 'card-fields' })
        for (const [key, value] of part.rows) list.append(h('dt', { text: key }), h('dd', { text: value }))
        body.append(section('Details', list))
      }
    }
    if (card.child) {
      const facts = [['Session', card.child.childId], ...(card.child.route ? [['Model', card.child.route]] : []), ...(card.child.sandbox ? [['Sandbox', card.child.sandbox]] : []), ['State', card.child.ended ?? (context().running ? 'running' : 'no end recorded')]]
      const list = h('dl', { class: 'card-fields' })
      for (const [key, value] of facts) list.append(h('dt', { text: key ?? '' }), h('dd', { text: value ?? '' }))
      body.append(section('Subagent', list))
    }
    if (card.job) {
      const list = h('dl', { class: 'card-fields' })
      for (const [key, value] of [['Job', card.job.jobId], ...(card.job.label ? [['Command', card.job.label]] : []), ['State', card.job.ended ?? 'running or unclosed']]) list.append(h('dt', { text: key ?? '' }), h('dd', { text: value ?? '' }))
      body.append(section('Background job', list))
    }
    return body
  }

  /** @param {string} label @param {...(Node | undefined)} children */
  function section(label, ...children) {
    const [content, action] = children
    return h('div', { class: 'card-section' }, h('div', { class: 'card-label' }, h('span', { text: label }), action), content)
  }

  /** @param {string} [outcome] @param {string} [by] */
  function decisionWords(outcome, by) {
    if (outcome === undefined) return 'No decision recorded'
    const what = outcome === 'allowed-once' ? 'Allowed once' : outcome === 'rejected' ? 'Rejected' : outcome === 'cancelled' ? 'Cancelled' : outcome === 'unavailable' ? 'Nobody could answer' : outcome
    const who = by === 'user' ? ' by you' : by ? ` by ${by}` : ''
    return `${what}${who}`
  }

  /** @param {Extract<Block, { kind: 'context' }>} block */
  function contextBlock(block) {
    const node = h('div', { class: 'context-card' })
    const expanded = open.get(block.key) ?? false
    const title = contextTitle(block)
    const toggle = h('button', { class: 'quiet-toggle', attrs: { type: 'button', 'aria-expanded': String(expanded) } }, icon('context', { size: 14 }), h('span', { text: title }))
    toggle.addEventListener('click', () => {
      open.set(block.key, !expanded)
      replaceBlock(block)
    })
    node.append(toggle)
    if (expanded && block.text.length > 0) node.append(block.replace ? markdown(block.text) : h('pre', { text: block.text }))
    return node
  }

  /** @param {Extract<Block, { kind: 'context' }>} block */
  function contextTitle(block) {
    if (block.replace) return 'Context summary · what the model keeps of the history above'
    const known = /** @type {Record<string, string>} */ ({
      'workspace-instructions': 'Workspace instructions',
      skills: 'Skills available',
      'context-runtime': 'Runtime context',
      'compaction-basic': 'Context summary',
      'tool-jobs': 'Background job update',
      jobs: 'Background job update',
    })
    return known[block.plugin] ?? `Context from ${block.plugin}${block.form ? ` (${block.form})` : ''}`
  }

  /** @param {Extract<Block, { kind: 'opening' }>} block */
  function openingBlock(block) {
    const node = h('div', { class: 'opening' })
    const expanded = open.get(block.key) ?? false
    const summary = block.rows.map((entry) => plain(entry.row.text)).join(' · ')
    const toggle = h(
      'button',
      { class: 'quiet-toggle', attrs: { type: 'button', 'aria-expanded': String(expanded) } },
      icon('shield', { size: 14 }),
      h('span', { text: block.resumed ? 'Session resumed' : 'Session opened' }),
      h('span', { class: 'muted', text: `· ${summary}` }),
    )
    toggle.addEventListener('click', () => {
      open.set(block.key, !expanded)
      replaceBlock(block)
    })
    node.append(toggle)
    if (expanded) node.append(h('div', { class: 'opening-rows' }, ...block.rows.map((entry) => receipt(plain(entry.row.text)))))
    return node
  }

  /** @param {Extract<Block, { kind: 'compaction' }>} block */
  function compactionBlock(block) {
    let text = 'Compacting context…'
    if (block.applied) text = `Context compacted · ${block.applied.shadowedSeqs?.length ?? 0} messages · ~${tokens(Number(block.applied.surfaceTokensBefore))} → ~${tokens(Number(block.applied.surfaceTokensAfter))} tokens`
    else if (block.end?.outcome?.kind === 'declined') text = `Compaction declined · ${block.end.outcome.reason}`
    else if (block.end) text = 'Context compacted'
    return h('div', { class: 'quiet' }, icon('compact', { size: 14 }), h('span', { text }))
  }

  /** @param {Extract<Block, { kind: 'tail' }>} block */
  function tailBlock(block) {
    const reason = block.reason
    const started = model.turnStarts.get(block.turn)
    const took = started === undefined ? '' : duration(block.time - started)
    if (reason.kind === 'completed') {
      return h(
        'div',
        { class: 'tail' },
        h('div', { class: 'msg-actions' }, h('span', { class: 'took', text: took ? `Worked for ${took}` : 'Done' }), h('span', { class: 'clock', text: clock(block.time, Date.now()), attrs: { title: new Date(block.time).toLocaleString() } }), copyButton(() => lastReplyBefore(block), 'Copy reply')),
      )
    }
    const words = /** @type {Record<string, [string, string]>} */ ({
      error: ['This turn failed', String(reason.message ?? '')],
      cancelled: ['Stopped', 'The turn was cancelled before it finished.'],
      interrupted: ['Interrupted', 'The host stopped before this turn ended; the next resume repairs it.'],
      'max-tokens': ['Output limit reached', 'Send "continue" to let the model resume.'],
      'max-steps': ['Step limit reached', 'The turn used every step it was allowed.'],
      blocked: ['Blocked', 'A policy stopped this turn before its first step.'],
    })
    const [what, why] = words[String(reason.kind)] ?? [String(reason.kind), '']
    const stopped = reason.kind !== 'error'
    return h(
      'div',
      { class: `turn-error${stopped ? ' stopped' : ''}` },
      h('span', { class: 'state-dot' }),
      h('span', { class: 'what', text: what }),
      h('span', { class: 'code', text: reason.kind === 'error' ? String(reason.code) : took }),
      why ? h('span', { class: 'why', text: why }) : undefined,
    )
  }

  /** @param {Block} tail */
  function lastReplyBefore(tail) {
    for (let at = model.blocks.indexOf(tail) - 1; at >= 0; at--) {
      const block = model.blocks[at]
      if (block?.kind === 'reply') return block.text
      if (block?.kind === 'bubble') break
    }
    return ''
  }

  /** @param {Extract<Block, { kind: 'note' }>} block */
  function noteBlock(block) {
    if (block.type === 'request/context') {
      const data = block.data
      const window_ = typeof data.contextWindow === 'number' ? ` · ${tokens(data.contextWindow)} window` : ''
      return h('div', { class: 'divider' }, h('span', { class: 'mono', text: `${data.provider}/${data.model}${window_}` }))
    }
    return h('div', { class: 'quiet' }, icon('info', { size: 14 }), h('span', { text: plain(block.row.text) }))
  }

  /** @param {Extract<Block, { kind: 'system' }>} block */
  function systemText(block) {
    const data = block.data
    switch (block.type) {
      case 'sandbox/mode':
        return `Sandbox set to ${data.mode} · enforcement ${data.enforcement}`
      case 'approval/policy':
        return `Approvals set to ${data.policy}`
      case 'sandbox/acceptance':
        return `Shell enforcement accepted: ${data.accepts} under ${data.forMode}`
      case 'authority/preset':
        return `Preset ${data.name}`
      case 'agent/options': {
        const route = data.options ?? {}
        return `Model set to ${route.provider}/${route.model}${route.reasoningEffort ? ` · ${route.reasoningEffort}` : ''}`
      }
      case 'approval/grant':
        return data.op === 'revoke' ? [{ text: 'A session grant was revoked; the next such action asks again' }] : [{ text: `Standing grant for ${data.toolName}: ` }, ...subjectParts(data.subject)]
      case 'approval/decided': {
        const asked = model.asked.get(String(data.id))?.data
        const subject = asked?.subject ? subjectParts(asked.subject) : [{ text: asked?.toolName ? `use ${asked.toolName}` : String(data.id) }]
        const words = data.grantId && data.outcome === 'allowed-once' ? `Allowed for this session${data.decidedBy === 'user' ? ' by you' : ''}` : decisionWords(String(data.outcome), data.decidedBy === undefined ? undefined : String(data.decidedBy))
        return [{ text: `${words}: ` }, ...subject]
      }
      default:
        return plain(block.row.text)
    }
  }

  /** @param {Extract<Block, { kind: 'system' }>} block @returns {'bad' | 'warn' | undefined} */
  function systemTone(block) {
    if (block.type === 'approval/decided') return block.data.outcome === 'allowed-once' ? undefined : 'bad'
    if (block.type === 'sandbox/mode' && block.data.mode === 'danger-full-access') return 'warn'
    if (block.type === 'sandbox/acceptance' && block.data.accepts !== 'full') return 'warn'
    return undefined
  }

  /**
   * A mono receipt. Its parts keep the model-chosen value (a command, a
   * payload) apart from the runtime's words, as the approval card does —
   * never re-split from text, so a backtick in a command flips nothing.
   * @param {string | readonly ({ text: string } | { code: string })[]} content @param {'bad' | 'warn'} [tone] @param {string} [extra]
   */
  function receipt(content, tone, extra) {
    const parts = typeof content === 'string' ? [{ text: content }] : content
    const flat = parts.map((part) => ('code' in part ? part.code : part.text)).join('')
    const node = h('span', { class: `receipt${tone ? ` ${tone}` : ''}`, attrs: { title: extra ? `${flat}\n${extra}` : flat } })
    node.append(...parts.map((part) => ('code' in part ? h('code', { text: part.code }) : document.createTextNode(part.text))))
    return node
  }

  /**
   * An image block's thumbnail: its space reserved from the stored size, so a
   * late load moves nothing; its pixels fetched only when it scrolls near.
   * @param {ContentBlock} image
   */
  function thumb(image) {
    if (image.type !== 'image') return h('span')
    const ref = image.attachment
    const img = h('img', { attrs: { alt: image.text, width: String(ref.width), height: String(ref.height), decoding: 'async' } })
    img.style.aspectRatio = `${ref.width} / ${ref.height}`
    const button = h('button', { class: 'thumb thumb-button', attrs: { type: 'button', 'aria-label': `Open ${image.text}` } }, img, h('span', { class: 'caption', text: `${ref.name ?? ref.mediaType} · ${ref.width}×${ref.height} · ${bytes(ref.bytes)}` }))
    let src = ''
    button.addEventListener('click', () => {
      if (src) lightbox(src, image.text)
    })
    lazy(button, () =>
      options
        .loadImage(ref)
        .then((url) => {
          src = url
          img.src = url
        })
        .catch(() => void img.setAttribute('alt', `${image.text} (not readable)`)),
    )
    return button
  }

  /** @type {IntersectionObserver | undefined} */
  let observer
  /** @type {WeakMap<Element, () => void>} */
  const onVisible = new WeakMap()
  /** @param {Element} node @param {() => void} load */
  function lazy(node, load) {
    observer ??= new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          observer?.unobserve(entry.target)
          onVisible.get(entry.target)?.()
          onVisible.delete(entry.target)
        }
      },
      { root: scroller, rootMargin: '400px 0px' },
    )
    onVisible.set(node, load)
    observer.observe(node)
  }

  /** A row's text without the projection's brackets: `[route: …]` reads as `route: …`. @param {string} text */
  const plain = (text) => text.replace(/^\[(.*)\]$/s, '$1')

  // ---- applying ops ---------------------------------------------------------

  /** Runs one DOM change with S10's rule: sample just before, write in the same task. @param {() => void} change */
  function mutate(change) {
    const stick = atBottom()
    change()
    if (stick) toBottom()
    syncToBottom()
  }

  /** @param {Block} block */
  function replaceBlock(block) {
    const node = blockNodes.get(block.key)
    if (!node) return
    const next = renderBlock(block)
    blockNodes.set(block.key, next)
    keepFocus(node, next, () => node.replaceWith(next))
  }

  /**
   * A redraw that would take the focused control with it hands focus to the
   * same control in what replaced it — a toggle that rebuilt its block, a
   * call row the view re-rendered — instead of dropping it to <body>.
   * @param {HTMLElement} before @param {HTMLElement} after @param {() => void} change
   */
  function keepFocus(before, after, change) {
    const held = before.contains(document.activeElement)
    change()
    if (held && !after.contains(document.activeElement)) /** @type {HTMLElement | null} */ (after.querySelector('button'))?.focus()
  }

  /** The latest turn's tail and the latest bubble show their actions without a hover. */
  function markLatest() {
    for (const node of rows.querySelectorAll(':scope > .latest')) node.classList.remove('latest')
    const children = [...rows.children]
    children.findLast((node) => node.classList.contains('tail'))?.classList.add('latest')
    children.findLast((node) => node.classList.contains('bubble-wrap'))?.classList.add('latest')
  }

  /** @param {readonly Op[]} ops */
  function applyOps(ops) {
    let settle = false
    for (const op of ops) {
      if (op.op === 'append') {
        const node = renderBlock(op.block)
        blockNodes.set(op.block.key, node)
        rows.append(node)
        if (op.block.kind === 'tail') settle = true
        if (node.classList.contains('turn-error') && !node.classList.contains('stopped')) node.setAttribute('role', 'alert')
      } else if (op.op === 'update') {
        const block = model.blocksByKey.get(op.key)
        if (!block) continue
        if (block.kind === 'process') {
          const node = blockNodes.get(op.key)
          if (!node) continue
          if (op.item && !op.added) {
            const item = block.items.find((entry) => entry.key === op.item)
            const itemNodeNow = itemNodes.get(op.item)
            if (item && itemNodeNow) keepFocus(itemNodeNow, itemNodeNow, () => renderItem(itemNodeNow, item))
          } else syncProcess(node, block)
        } else replaceBlock(block)
      } else if (op.op === 'remove') {
        blockNodes.get(op.key)?.remove()
        blockNodes.delete(op.key)
      } else if (op.op === 'live') {
        scheduleLive(op.live)
      } else if (op.op === 'live-clear') {
        clearLive()
      }
    }
    // A turn just ended: the groups it holds settle and may collapse.
    if (settle) {
      for (let at = model.blocks.length - 2; at >= 0; at--) {
        const block = model.blocks[at]
        if (!block || block.kind === 'tail') break
        if (block.kind === 'process') {
          const node = blockNodes.get(block.key)
          if (node) syncProcess(node, block)
        }
      }
    }
  }

  // ---- the live preview -------------------------------------------------------

  /** @param {Live} live */
  function scheduleLive(live) {
    pendingLive = live
    if (liveFrame) return
    liveFrame = requestAnimationFrame(() => {
      liveFrame = 0
      const current = pendingLive
      if (!current) return
      mutate(() => renderLive(current))
    })
  }

  /** @param {Live} live */
  function renderLive(live) {
    liveNode ??= h('div', { class: 'live' })
    if (!liveNode.isConnected) options.live.append(liveNode)
    const children = []
    if (live.reasoning && !live.text) {
      const first = live.reasoning.trim().split('\n').filter((line) => line.trim()).at(-1) ?? ''
      children.push(h('div', { class: 'row preparing' }, h('span', { class: 'glyph' }, icon('think', { size: 14 })), h('span', { class: 'row-title', text: 'Thinking' }), h('span', { class: 'sep' }), h('span', { class: 'summary', text: first })))
    }
    if (live.text) {
      const reply = h('div', { class: 'md reply' })
      fillMarkdown(reply, live.text, { streaming: true })
      children.push(reply)
    }
    liveNode.replaceChildren(...children)
  }

  function clearLive() {
    pendingLive = undefined
    if (liveFrame) cancelAnimationFrame(liveFrame)
    liveFrame = 0
    liveNode?.remove()
    liveNode = undefined
  }

  // ---- the working line and the back-to-bottom button -------------------------

  function syncWorking() {
    const running = liveSession && view?.status === 'running'
    options.working.hidden = !running
    clearInterval(workingTimer)
    if (!running) return
    const render = () => {
      let started = 0
      for (const time of model.turnStarts.values()) started = Math.max(started, time)
      const took = started > 0 ? ` · ${duration(Date.now() - started)}` : ''
      options.working.replaceChildren(h('span', { class: 'pulse' }), h('span', { class: 'label', text: `Working${took}` }))
    }
    render()
    workingTimer = window.setInterval(render, 1000)
  }

  function syncToBottom() {
    options.toBottom.hidden = atBottom() || model.blocks.length === 0
  }

  /**
   * Whether the reader was at the bottom at the last scroll. A resize (the
   * approval card replacing the composer, a long draft, a rotated phone)
   * moves the bottom without a scroll event; a reader who was there stays.
   */
  let stuck = true
  scroller.addEventListener(
    'scroll',
    () => {
      stuck = atBottom()
      syncToBottom()
    },
    { passive: true },
  )
  new ResizeObserver(() => {
    if (stuck) toBottom()
    syncToBottom()
  }).observe(scroller)

  /** Everything a window held for its own blocks: nodes, expand state, pending thumbnails. */
  function forget() {
    blockNodes.clear()
    itemNodes.clear()
    open.clear()
    observer?.disconnect()
    observer = undefined
  }
  options.toBottom.addEventListener('click', () => {
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  })
  options.toBottom.append(icon('chevron-down', { size: 16 }))
  options.more.addEventListener('click', () => options.loadOlder())
  // Earlier history loads itself as the reader nears the top, as DSH's does.
  new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !options.more.hidden) options.loadOlder()
    },
    { root: scroller, rootMargin: '600px 0px 0px 0px' },
  ).observe(options.more)

  // ---- the surface ---------------------------------------------------------------

  return {
    /**
     * A fresh window: the attach's page replaces everything held.
     * @param {readonly EventEnvelope[]} events
     * @param {{ seedLength?: number, cwd?: string, hasMore: boolean, live: boolean }} meta
     */
    reset(events, meta) {
      clearLive()
      forget()
      cwd = meta.cwd ?? ''
      liveSession = meta.live
      model = fold(events, meta.seedLength === undefined ? {} : { seedLength: meta.seedLength })
      const fragment = document.createDocumentFragment()
      for (const block of model.blocks) {
        const node = renderBlock(block)
        blockNodes.set(block.key, node)
        fragment.append(node)
      }
      rows.replaceChildren(fragment)
      markLatest()
      this.setHasMore(meta.hasMore)
      syncWorking()
      toBottom()
      syncToBottom()
    },
    /** Live facts, in order (the window already deduplicated and repaired them). @param {readonly EventEnvelope[]} events */
    append(events) {
      mutate(() => {
        for (const event of events) applyOps(step(model, event))
        markLatest()
      })
    },
    /** A person's own send: the bottom is where they will look. */
    toBottom() {
      toBottom()
      stuck = true
      syncToBottom()
    },
    /** The trace tier: streamed, never stored. @param {EventEnvelope} event */
    chunk(event) {
      applyOps(step(model, event))
    },
    /**
     * An older page at the head. The reader keeps their place: the first
     * block they could see stays where it was.
     * @param {readonly EventEnvelope[]} events @param {boolean} hasMore
     */
    prepend(events, hasMore) {
      const known = new Set(itemNodes.keys())
      const ops = prepend(model, events)
      // The anchor is a block this prepend leaves where it is: one it removes
      // or re-draws at the head cannot hold the reader's place.
      const moving = new Set(ops.flatMap((op) => (op.op === 'remove' ? [op.key] : op.op === 'prepend' ? op.blocks.map((block) => block.key) : [])))
      const top = scroller.getBoundingClientRect().top
      const anchor = [...rows.children].find((node) => node instanceof HTMLElement && !moving.has(node.dataset.key ?? '') && node.getBoundingClientRect().bottom > top)
      const before = anchor instanceof HTMLElement ? anchor.getBoundingClientRect().top : 0
      for (const op of ops) {
        if (op.op !== 'prepend') continue
        const fragment = document.createDocumentFragment()
        for (const block of op.blocks) {
          // A bracket the older page reclaimed is drawn here; its old node goes.
          blockNodes.get(block.key)?.remove()
          const node = renderBlock(block)
          blockNodes.set(block.key, node)
          fragment.append(node)
          // A call this page completed (its name, its arguments) moved here with its node: redraw it.
          if (block.kind === 'process') for (const item of block.items) if (known.has(item.key)) renderItem(/** @type {HTMLElement} */ (itemNodes.get(item.key)), item)
        }
        rows.prepend(fragment)
      }
      applyOps(ops.filter((op) => op.op !== 'prepend'))
      markLatest()
      // Hidden BEFORE the anchor is measured: the button sits above the rows.
      this.setHasMore(hasMore)
      if (anchor instanceof HTMLElement && anchor.isConnected) scroller.scrollTop += anchor.getBoundingClientRect().top - before
    },
    /** @param {boolean} hasMore */
    setHasMore(hasMore) {
      options.more.hidden = !hasMore
      options.historyStart.hidden = hasMore || model.blocks.length === 0
    },
    /**
     * The control plane moved: calls with no result may change state.
     * @param {ViewLike | undefined} next @param {boolean} live
     */
    setView(next, live) {
      view = next
      liveSession = live
      mutate(() => {
        for (const item of model.items.values()) {
          if (item.result) continue
          const node = itemNodes.get(item.key)
          if (node) renderItem(node, item)
        }
      })
      syncWorking()
    },
    /** Redraws every call card: the tool catalog arrived after the page. */
    refreshCards() {
      mutate(() => {
        for (const item of model.items.values()) {
          const node = itemNodes.get(item.key)
          if (node) renderItem(node, item)
        }
      })
    },
    /** Children this session is delegating to right now: started, not ended, while the live view says it runs. */
    runningChildren() {
      /** @type {Set<string>} */
      const ids = new Set()
      if (!liveSession || view?.status !== 'running') return ids
      for (const item of model.items.values()) if (item.subagent?.start && !item.subagent.end) ids.add(String(item.subagent.start.childId))
      return ids
    },
    get empty() {
      return model.blocks.length === 0
    },
    clear() {
      clearLive()
      forget()
      model = createConversation()
      rows.replaceChildren()
      view = undefined
      liveSession = false
      syncWorking()
      this.setHasMore(false)
      syncToBottom()
    },
  }
}
