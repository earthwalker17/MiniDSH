// @ts-check
/**
 * The composer: one card holding the message, the permission and model
 * chips, and the send button that becomes Stop while a turn runs (DSH's
 * composer, with MiniDSH's three authority knobs behind the chip).
 *
 * Keys: Enter sends — the HOST decides whether it steers the running turn or
 * waits for the next (`mode: 'auto'`, `protocol/host.ts`), the only correct
 * choice for a client that cannot know whether the turn it saw is still
 * running; Ctrl/⌘+Enter queues it for after this turn (`followup`); Shift+Enter
 * is a newline; Escape twice within half a second stops the turn. Nothing
 * sends while an input method is composing (a CJK user's Enter confirms a
 * candidate, it does not send).
 */
import { icon } from './icons.js'
import { h, iconButton } from './ui.js'

/**
 * @typedef {{
 *   canSend: boolean,
 *   running: boolean,
 *   permission: { label: string, sub?: string, warn?: boolean, disabled?: boolean, title?: string },
 *   model: { label: string, sub?: string, disabled?: boolean, title?: string },
 *   context?: { ratio: number, label: string },
 *   held: number,
 *   placeholder: string,
 * }} ComposerState
 */

/**
 * @param {{
 *   form: HTMLFormElement, textarea: HTMLTextAreaElement, bar: HTMLElement, meta: HTMLElement,
 *   onSend: (text: string, mode: 'auto' | 'followup') => void,
 *   onStop: () => void,
 *   onPlus: (anchor: HTMLElement) => void,
 *   onPermission: (anchor: HTMLElement) => void,
 *   onModel: (anchor: HTMLElement) => void,
 * }} options
 */
export function createComposer(options) {
  const { textarea, bar, meta } = options
  /** @type {ComposerState | undefined} */
  let state
  let lastEscape = 0

  const plus = iconButton('plus', 'Actions', () => options.onPlus(plus), 'round-btn')
  plus.setAttribute('aria-haspopup', 'menu')
  plus.setAttribute('aria-expanded', 'false')
  const permission = h('button', { class: 'chip', attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' } })
  permission.addEventListener('click', () => options.onPermission(permission))
  const model = h('button', { class: 'chip', attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' } })
  model.addEventListener('click', () => options.onModel(model))
  const send = h('button', { class: 'round-btn send', attrs: { type: 'submit' } })
  bar.append(plus, permission, h('span', { class: 'grow' }), model, send)

  const autosize = () => {
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 336)}px`
  }

  const submit = (/** @type {'auto' | 'followup'} */ mode) => {
    const text = textarea.value.trim()
    if (!text || !state?.canSend) return
    textarea.value = ''
    autosize()
    syncSend()
    options.onSend(text, mode)
  }

  options.form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (state?.running && textarea.value.trim().length === 0) {
      options.onStop()
      return
    }
    submit('auto')
  })
  textarea.addEventListener('input', () => {
    autosize()
    syncSend()
  })
  textarea.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit(event.ctrlKey || event.metaKey ? 'followup' : 'auto')
      return
    }
    if (event.key === 'Escape' && state?.running) {
      const now = Date.now()
      if (now - lastEscape < 500) {
        lastEscape = 0
        options.onStop()
      } else lastEscape = now
    }
  })

  function syncSend() {
    const draft = textarea.value.trim().length > 0
    const stop = state?.running === true && !draft
    send.classList.toggle('stop', stop)
    send.replaceChildren(icon(stop ? 'stop' : 'send', { size: stop ? 12 : 16 }))
    const label = stop ? 'Stop the turn' : state?.running ? 'Send — it steers the running turn' : 'Send'
    send.setAttribute('aria-label', label)
    send.setAttribute('title', stop ? 'Stop the turn (Esc Esc)' : state?.running ? 'Send now (Enter) · after this turn (Ctrl+Enter)' : 'Send (Enter)')
    send.disabled = !state?.canSend || (!draft && !stop)
  }

  return {
    /** @param {ComposerState} next */
    render(next) {
      state = next
      textarea.placeholder = next.placeholder
      textarea.disabled = !next.canSend
      permission.replaceChildren(icon('shield', { size: 14 }), h('span', { class: 'value', text: next.permission.label }), next.permission.sub ? h('span', { class: 'sub', text: next.permission.sub }) : '', icon('chevron-down', { size: 12, className: 'chev' }))
      permission.classList.toggle('warn', next.permission.warn === true)
      permission.disabled = next.permission.disabled === true
      permission.setAttribute('aria-label', `Permissions: ${next.permission.label}${next.permission.sub ? `, ${next.permission.sub}` : ''}`)
      if (next.permission.title) permission.title = next.permission.title
      else permission.removeAttribute('title')
      model.replaceChildren(icon('sparkle', { size: 14 }), h('span', { class: 'value', text: next.model.label }), next.model.sub ? h('span', { class: 'sub', text: next.model.sub }) : '', icon('chevron-down', { size: 12, className: 'chev' }))
      model.disabled = next.model.disabled === true
      model.setAttribute('aria-label', `Model: ${next.model.label}${next.model.sub ? `, effort ${next.model.sub}` : ''}`)
      if (next.model.title) model.title = next.model.title
      else model.removeAttribute('title')
      syncSend()
      /** @type {Node[]} */
      const items = []
      if (next.held > 0) items.push(h('span', { class: 'held-chip' }, icon('clock', { size: 12 }), h('span', { text: next.held === 1 ? 'A job update waits for your next message' : `${next.held} job updates wait for your next message` })))
      if (next.context) {
        const percent = Math.max(0, Math.min(100, Math.round(next.context.ratio * 100)))
        const ring = h('span', { class: `ring${percent >= 80 ? ' high' : ''}`, attrs: { 'aria-hidden': 'true' } })
        ring.style.setProperty('--p', String(percent))
        items.push(h('span', { class: 'meta-item', attrs: { title: next.context.label } }, ring, h('span', { text: `${percent}% of context` })))
      }
      meta.replaceChildren(...items)
    },
    focus() {
      textarea.focus()
    },
    /** @param {string} text */
    restore(text) {
      if (textarea.value.length === 0) {
        textarea.value = text
        autosize()
        syncSend()
      }
    },
  }
}
