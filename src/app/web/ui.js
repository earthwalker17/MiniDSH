// @ts-check
/**
 * The few DOM primitives every part of the client shares: element building,
 * menus, dialogs, toasts, copying and the image lightbox.
 *
 * Everything is built with `createElement` and `textContent`. The page runs
 * under a strict CSP with Trusted Types (`app/web.ts`), so an HTML string can
 * never become markup here, by construction and by the browser's refusal.
 */
import { icon } from './icons.js'

/**
 * A node with a class, attributes and children in one call.
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {{ class?: string | undefined, text?: string | undefined, attrs?: Record<string, string | undefined>, on?: Record<string, (event: any) => void>, hidden?: boolean }} [props]
 * @param {...(Node | string | undefined | false | null)} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  if (props.class) node.className = props.class
  if (props.text !== undefined) node.textContent = props.text
  if (props.hidden) node.hidden = true
  for (const [key, value] of Object.entries(props.attrs ?? {})) if (value !== undefined) node.setAttribute(key, value)
  for (const [name, handler] of Object.entries(props.on ?? {})) node.addEventListener(name, handler)
  for (const child of children) if (child !== undefined && child !== false && child !== null) node.append(child)
  return node
}

/**
 * An icon-only button: the label is its accessible name and its tooltip.
 * @param {string} name @param {string} label @param {(event: MouseEvent) => void} [onClick] @param {string} [className]
 */
export function iconButton(name, label, onClick, className = 'icon-btn') {
  const button = h('button', { class: className, attrs: { type: 'button', 'aria-label': label, title: label } }, icon(name))
  if (onClick) button.addEventListener('click', onClick)
  return button
}

/** @param {string} id @returns {HTMLElement} */
export const byId = (id) => {
  const node = document.getElementById(id)
  if (!node) throw new Error(`no #${id} in the page`)
  return node
}

// ---- menus -----------------------------------------------------------------

/**
 * @typedef {{ label: string, desc?: string, icon?: string, checked?: boolean, disabled?: boolean, warn?: boolean, onSelect: () => void }} MenuItem
 * @typedef {MenuItem | { separator: true } | { heading: string }} MenuEntry
 */

/** @type {{ close: () => void } | undefined} */
let openMenu

/**
 * A menu anchored to a control: outside click and Escape close it, focus
 * returns to the anchor, arrows move between items, and it fits the viewport
 * with a margin — DSH's overlay rules (cookbook: overlays).
 * @param {HTMLElement} anchor
 * @param {readonly MenuEntry[]} entries
 * @param {{ align?: 'start' | 'end', above?: boolean, label?: string }} [options]
 */
export function showMenu(anchor, entries, options = {}) {
  openMenu?.close()
  const menu = h('div', { class: 'menu', attrs: { role: 'menu', 'aria-label': options.label ?? anchor.getAttribute('aria-label') ?? undefined } })
  /** @type {HTMLButtonElement[]} */
  const items = []
  // Each heading opens a named group, so a radio set is announced as the set
  // it is and two items with one label are told apart by their group.
  /** @type {HTMLElement} */
  let into = menu
  for (const entry of entries) {
    if ('separator' in entry) {
      menu.append(h('div', { class: 'menu-sep', attrs: { role: 'separator' } }))
      into = menu
      continue
    }
    if ('heading' in entry) {
      into = h('div', { attrs: { role: 'group', 'aria-label': entry.heading } }, h('div', { class: 'menu-label', text: entry.heading, attrs: { 'aria-hidden': 'true' } }))
      menu.append(into)
      continue
    }
    const radio = entry.checked !== undefined
    const item = h(
      'button',
      {
        class: `menu-item${entry.warn ? ' warn' : ''}`,
        attrs: { type: 'button', role: radio ? 'menuitemradio' : 'menuitem', ...(radio ? { 'aria-checked': String(entry.checked) } : {}), ...(entry.disabled ? { disabled: '' } : {}) },
      },
      entry.icon ? icon(entry.icon, { size: 14 }) : undefined,
      h('span', { class: 'text' }, h('span', { text: entry.label }), entry.desc ? h('span', { class: 'desc', text: entry.desc }) : undefined),
      radio ? icon('check', { size: 14, className: 'check' }) : undefined,
    )
    item.addEventListener('click', () => {
      close()
      // Back to the control that opened it BEFORE the choice runs: the item
      // is gone, and focus on a removed node falls to <body>.
      if (anchor.isConnected) anchor.focus()
      entry.onSelect()
    })
    items.push(item)
    into.append(item)
  }
  document.body.append(menu)
  anchor.setAttribute('aria-expanded', 'true')
  place(menu, anchor, options)

  const onKey = (/** @type {KeyboardEvent} */ event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      anchor.focus()
      return
    }
    // Tab leaves the menu, so the menu leaves with it — from the control
    // that opened it, or focus would fall off the end of the page.
    if (event.key === 'Tab') {
      close()
      if (anchor.isConnected) anchor.focus()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const enabled = items.filter((item) => !item.disabled)
    const at = enabled.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement))
    const next = event.key === 'ArrowDown' ? (at + 1) % enabled.length : (at - 1 + enabled.length) % enabled.length
    enabled[next]?.focus()
  }
  const onPointer = (/** @type {PointerEvent} */ event) => {
    if (!menu.contains(/** @type {Node} */ (event.target)) && !anchor.contains(/** @type {Node} */ (event.target))) close()
  }
  const onResize = () => close()
  function close() {
    if (openMenu?.close !== close) return
    openMenu = undefined
    menu.remove()
    anchor.setAttribute('aria-expanded', 'false')
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('pointerdown', onPointer, true)
    window.removeEventListener('resize', onResize)
  }
  openMenu = { close }
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('pointerdown', onPointer, true)
  window.addEventListener('resize', onResize)
  ;(items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items.find((item) => !item.disabled))?.focus()
  return { close }
}

/** @param {HTMLElement} menu @param {HTMLElement} anchor @param {{ align?: 'start' | 'end', above?: boolean }} options */
function place(menu, anchor, options) {
  const margin = 12
  const box = anchor.getBoundingClientRect()
  const width = menu.offsetWidth
  const height = menu.offsetHeight
  let left = options.align === 'end' ? box.right - width : box.left
  left = Math.min(Math.max(margin, left), window.innerWidth - width - margin)
  const below = box.bottom + 4
  const above = box.top - 4 - height
  const fitsBelow = below + height <= window.innerHeight - margin
  const top = options.above ? (above >= margin ? above : below) : fitsBelow || above < margin ? below : above
  menu.style.left = `${Math.round(left)}px`
  menu.style.top = `${Math.round(Math.max(margin, Math.min(top, window.innerHeight - height - margin)))}px`
}

/** Closes any open menu (a view change can take its anchor away). */
export function closeMenus() {
  openMenu?.close()
}

// ---- dialogs ----------------------------------------------------------------

/**
 * A confirmation as a modal `<dialog>`: the browser traps focus and closes it
 * on Escape. Resolves true only when the person chose the action.
 * @param {{ title: string, text: string, confirm: string, cancel?: string, danger?: boolean }} options
 * @returns {Promise<boolean>}
 */
export function confirmDialog(options) {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'modal small', attrs: { 'aria-labelledby': 'confirm-title' } })
    const cancel = h('button', { class: 'btn outline', text: options.cancel ?? 'Cancel', attrs: { type: 'button' } })
    const ok = h('button', { class: `btn primary`, text: options.confirm, attrs: { type: 'button' } })
    dialog.append(
      h('div', { class: 'modal-head' }, h('h2', { text: options.title, attrs: { id: 'confirm-title' } })),
      h('p', { class: 'modal-text', text: options.text }),
      h('div', { class: 'modal-actions' }, cancel, ok),
    )
    let answer = false
    cancel.addEventListener('click', () => dialog.close())
    ok.addEventListener('click', () => {
      answer = true
      dialog.close()
    })
    dialog.addEventListener('close', () => {
      dialog.remove()
      resolve(answer)
    })
    document.body.append(dialog)
    dialog.showModal()
    cancel.focus()
  })
}

/** @param {string} src @param {string} alt */
export function lightbox(src, alt) {
  const dialog = h('dialog', { class: 'lightbox', attrs: { 'aria-label': alt } }, h('img', { attrs: { src, alt } }))
  dialog.addEventListener('click', () => dialog.close())
  dialog.addEventListener('close', () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()
}

// ---- toasts -----------------------------------------------------------------

/**
 * A transient notice, top centre: an outcome worth saying out loud (a command
 * that answers nothing reads as a broken button), or an error in one sentence.
 * @param {string} text @param {'notice' | 'error'} [kind]
 */
export function toast(text, kind = 'notice') {
  // The container is a live region of its own (index.html); an error interrupts.
  const host = byId('toasts')
  const node = h('div', { class: `toast${kind === 'error' ? ' error' : ''}`, text, ...(kind === 'error' ? { attrs: { role: 'alert' } } : {}) })
  host.append(node)
  setTimeout(() => node.remove(), kind === 'error' ? 7000 : 4000)
}

/** An error, said once and plainly. @param {unknown} error */
export const fail = (error) => toast(String(/** @type {{ message?: unknown }} */ (error)?.message ?? error), 'error')

// ---- copying -----------------------------------------------------------------

/**
 * Copies text. `navigator.clipboard` exists only in a secure context, and a
 * `--host` LAN address over plain http is not one, so the old selection
 * route is the fallback.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the selection route.
  }
  const area = h('textarea', { attrs: { 'aria-hidden': 'true', readonly: '' } })
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  area.remove()
  return copied
}

/**
 * A copy button that says "Copied" for a moment, so a click is never silent.
 * @param {() => string} source @param {string} [label]
 */
export function copyButton(source, label = 'Copy') {
  const button = iconButton('copy', label)
  button.addEventListener('click', async (event) => {
    event.stopPropagation()
    const ok = await copyText(source())
    button.replaceChildren(icon(ok ? 'check' : 'warning'))
    button.setAttribute('aria-label', ok ? 'Copied' : 'Copy failed')
    setTimeout(() => {
      button.replaceChildren(icon('copy'))
      button.setAttribute('aria-label', label)
    }, 1200)
  })
  return button
}

/** Says something to screen-reader users without moving focus. @param {string} text */
export function announce(text) {
  const region = document.getElementById('announcer')
  if (!region) return
  region.textContent = ''
  // A fresh node per message, so a repeated status is announced again.
  requestAnimationFrame(() => void (region.textContent = text))
}
