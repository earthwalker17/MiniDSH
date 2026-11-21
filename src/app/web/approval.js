// @ts-check
/**
 * The approval card. It takes the composer's place, as DSH's does: a
 * question the runtime is waiting on is the one thing the person must do.
 *
 * It renders what the HOST offered and nothing it did not: the runtime's own
 * account of the call (`subject`, built from validated arguments) leads, the
 * model's `reason` follows as the claim it is, and the literal call is
 * scrollable rather than cut — consent to text a reader cannot reach is not
 * consent. "Allow for this session" appears only where the fold offered that
 * scope. No key answers it: an authority prompt is answered with a button
 * the person chose, never an Enter meant for the composer.
 */
import { subjectParts } from './rows.js'
import { h } from './ui.js'

/** @typedef {import('../../core/approval/events.ts').OpenApproval} OpenApproval */

/**
 * @param {{ host: HTMLElement, onAnswer: (open: OpenApproval, outcome: 'allowed-once' | 'rejected', offer?: 'grant-session') => Promise<void> }} options
 */
export function createApproval(options) {
  const { host } = options
  /** @type {string | undefined} */
  let shownId
  /** The card whose answer is in flight, by its approval's id. @type {string | undefined} */
  let answering
  let arming = 0

  /**
   * @param {readonly OpenApproval[]} pending
   * @returns {boolean} whether a card is showing
   */
  function render(pending) {
    const open = pending[0]
    if (!open) {
      host.hidden = true
      host.replaceChildren()
      shownId = undefined
      return false
    }
    if (open.id === shownId && answering !== open.id) return true
    shownId = open.id
    host.hidden = false
    const head = h('h2', { class: 'approval-head', attrs: { id: 'approval-head', tabindex: '-1' } })
    if (open.subject) head.append(...headline(subjectParts(open.subject)))
    else head.append(document.createTextNode(`Allow ${open.toolName} to run?`))
    const body = h('div', { class: 'approval-body' }, head)
    if (open.reason) body.append(h('p', { class: 'approval-reason', text: open.reason }))
    if (open.call) {
      const omitted = open.call.omittedChars ? `\n… ${open.call.omittedChars} more characters — read the whole call with \`minidsh sessions show --json\`` : ''
      body.append(h('pre', { class: 'approval-call', text: `${open.call.name} ${open.call.arguments}${omitted}`, attrs: { tabindex: '0', 'aria-label': 'The call, verbatim' } }))
    }
    const actions = h('div', { class: 'approval-actions' })
    const reject = h('button', { class: 'btn outline danger', text: 'Reject', attrs: { type: 'button' } })
    const once = h('button', { class: 'btn primary', text: 'Allow once', attrs: { type: 'button' } })
    actions.append(reject)
    if (open.offers?.includes('grant-session')) {
      const session = h('button', { class: 'btn outline', text: 'Allow for this session', attrs: { type: 'button', title: 'Allow this exact action again until the session ends or its authority changes' } })
      session.addEventListener('click', (event) => {
        if (event.detail <= 1) void answer(open, 'allowed-once', 'grant-session')
      })
      actions.append(session)
    }
    actions.append(once)
    reject.addEventListener('click', (event) => {
      if (event.detail <= 1) void answer(open, 'rejected')
    })
    once.addEventListener('click', (event) => {
      if (event.detail <= 1) void answer(open, 'allowed-once')
    })
    const count = pending.length > 1 ? h('span', { class: 'count', text: `1 of ${pending.length}` }) : undefined
    host.replaceChildren(h('div', { class: 'approval-strip' }, h('span', { class: 'state-dot' }), h('span', { text: 'Waiting for your approval' }), count), body, actions)
    head.focus()
    // Armed after a beat. The answer button sits on the same pixels for every
    // card, and the next card arrives within a double-click of the last answer:
    // live at once, a second click would allow a call nobody read (S22 review).
    // A double click's second press (`detail > 1`) never answers either.
    const buttons = [...actions.querySelectorAll('button')]
    for (const button of buttons) button.disabled = true
    clearTimeout(arming)
    arming = window.setTimeout(() => {
      if (shownId === open.id && answering !== open.id) for (const button of buttons) button.disabled = false
    }, ARM_MS)
    return true
  }

  /** @param {OpenApproval} open @param {'allowed-once' | 'rejected'} outcome @param {'grant-session'} [offer] */
  async function answer(open, outcome, offer) {
    if (answering === open.id) return
    answering = open.id
    for (const button of host.querySelectorAll('button')) button.disabled = true
    try {
      await options.onAnswer(open, outcome, offer)
    } finally {
      // The view that follows the decision redraws (or hides) the card; a
      // refused answer leaves it answerable again. THIS card only: one that
      // took its place while the answer was in flight (another client answered
      // first, and the next question arrived before this reply) is a question
      // nobody has read, and it keeps its own arming delay.
      if (answering === open.id) answering = undefined
      if (shownId === open.id) for (const button of host.querySelectorAll('button')) button.disabled = false
    }
  }

  return { render }
}

/** How long a new card's buttons stay disabled: longer than a double-click, shorter than reading it. */
const ARM_MS = 600

/**
 * The subject as the runtime built it: its words as text, the model-chosen
 * value as code — from its parts, never by splitting text on backticks.
 * @param {readonly ({ text: string } | { code: string })[]} parts
 * @returns {Node[]}
 */
function headline(parts) {
  return parts.map((part, index) => {
    if ('code' in part) return h('code', { text: part.code })
    const text = index === 0 ? part.text.charAt(0).toUpperCase() + part.text.slice(1) : part.text
    return document.createTextNode(text)
  })
}
