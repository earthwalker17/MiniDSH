// @ts-check
/**
 * Settings, as one modal with a left nav (DSH's shape): what THIS BROWSER
 * shows (the theme), the HOST's defaults for new sessions (the settings
 * namespaces, revision-checked), and what this host is.
 *
 * The host's defaults keep two rules from S7's real-browser pass: a field
 * holds the USER layer and shows the resolved value only as its placeholder
 * (saving must not pin today's defaults forever), and a save names the
 * revision it read, so a stale write is refused rather than applied over
 * someone else's.
 */
import { icon } from './icons.js'
import { fail, h, iconButton, toast } from './ui.js'

/** @typedef {import('./wire.js').Wire} Wire */
/** @typedef {import('../../capabilities/protocol/frames.ts').InitializeResult} InitializeResult */

/** @typedef {{ get(): 'light' | 'dark' | 'system', set(preference: 'light' | 'dark' | 'system'): void }} ThemeHandle */

/**
 * @param {{ dialog: HTMLDialogElement, wire: () => Wire, init: () => InitializeResult | undefined }} options
 */
export function createSettings(options) {
  const { dialog } = options
  /** @type {'general' | 'defaults' | 'about'} */
  let page = 'general'
  /** A save finished while a read was in flight: do not reopen what it closed. */
  let generation = 0

  dialog.addEventListener('close', () => {
    generation++
  })

  async function show(next = page) {
    page = next
    const mine = ++generation
    const nav = h('nav', { class: 'settings-nav', attrs: { 'aria-label': 'Settings sections' } }, h('h2', { text: 'Settings' }))
    for (const [id, label, glyph] of /** @type {const} */ ([
      ['general', 'General', 'settings'],
      ['defaults', 'New sessions', 'sliders'],
      ['about', 'About', 'info'],
    ])) {
      const item = h('button', { class: 'nav-item', attrs: { type: 'button', ...(page === id ? { 'aria-current': 'page' } : {}) } }, icon(glyph, { size: 16 }), h('span', { text: label }))
      item.addEventListener('click', () => void show(id).catch(fail))
      nav.append(item)
    }
    const close = iconButton('close', 'Close settings', () => dialog.close())
    const titles = { general: 'General', defaults: 'New sessions', about: 'About' }
    const body = h('div', { class: 'settings-body' }, h('div', { class: 'modal-head' }, h('h2', { text: titles[page] }), close))
    const content = page === 'general' ? general() : page === 'defaults' ? await defaults() : about()
    if (mine !== generation) return
    body.append(content)
    dialog.replaceChildren(h('div', { class: 'settings' }, nav, body))
    if (!dialog.open) dialog.showModal()
    const current = /** @type {HTMLElement | null} */ (nav.querySelector('[aria-current="page"]'))
    current?.focus()
  }

  function general() {
    const theme = /** @type {ThemeHandle | undefined} */ (/** @type {any} */ (window).minidshTheme)
    const current = theme?.get() ?? 'system'
    const group = h('div', { class: 'segmented', attrs: { role: 'radiogroup', 'aria-label': 'Theme' } })
    for (const [value, label, glyph] of /** @type {const} */ ([
      ['light', 'Light', 'light'],
      ['dark', 'Dark', 'dark'],
      ['system', 'System', 'system'],
    ])) {
      const button = h('button', { attrs: { type: 'button', role: 'radio', 'aria-checked': String(current === value) } }, icon(glyph, { size: 14 }), h('span', { text: label }))
      button.addEventListener('click', () => {
        theme?.set(value)
        for (const other of group.querySelectorAll('button')) other.setAttribute('aria-checked', String(other === button))
      })
      group.append(button)
    }
    return h(
      'div',
      { class: 'settings-page' },
      h('h3', { text: 'Appearance' }),
      h('p', { class: 'hint', text: 'Kept in this browser only; every session and every other client keep their own.' }),
      group,
    )
  }

  async function defaults() {
    const described = await options.wire().request('settings/describe')
    const content = h('div', { class: 'settings-page' })
    content.append(h('p', { class: 'hint', text: 'Defaults for the next session this host starts. A session that already exists keeps what its log recorded.' }))
    /** @type {HTMLInputElement[]} */
    const inputs = []
    for (const namespace of described.namespaces) {
      const card = h('div', { class: 'settings-card' })
      const properties = namespace.schema?.properties ?? {}
      for (const [key, spec] of Object.entries(properties)) {
        const input = h('input', { attrs: { 'aria-label': `${namespace.ns}.${key}` } })
        input.dataset.ns = namespace.ns
        input.dataset.key = key
        input.dataset.revision = String(namespace.revision)
        input.dataset.kind = Array.isArray(spec.type) ? spec.type[0] : (spec.type ?? 'string')
        if (input.dataset.kind === 'number' || input.dataset.kind === 'integer') input.inputMode = 'numeric'
        // The USER layer is what a field holds; the resolved value only its placeholder (S7).
        input.value = namespace.user?.[key] ?? ''
        input.placeholder = String(namespace.value?.[key] ?? '')
        inputs.push(input)
        card.append(h('label', { class: 'field' }, h('span', { text: label(key) }), input, spec.description ? h('small', { text: spec.description }) : undefined))
      }
      content.append(card)
    }
    const save = h('button', { class: 'btn primary', text: 'Save', attrs: { type: 'button' } })
    save.addEventListener('click', () => void saveDefaults(inputs, save))
    content.append(h('div', { class: 'modal-actions' }, save))
    return content
  }

  /** @param {HTMLInputElement[]} inputs @param {HTMLButtonElement} save */
  async function saveDefaults(inputs, save) {
    /** @type {Map<string, { patch: Record<string, unknown>, revision: number }>} */
    const byNamespace = new Map()
    for (const input of inputs) {
      const ns = input.dataset.ns ?? ''
      const entry = byNamespace.get(ns) ?? { patch: {}, revision: Number(input.dataset.revision) }
      const raw = input.value.trim()
      if (raw.length > 0) entry.patch[input.dataset.key ?? ''] = input.dataset.kind === 'number' || input.dataset.kind === 'integer' ? Number(raw) : raw
      byNamespace.set(ns, entry)
    }
    save.disabled = true
    try {
      for (const [ns, entry] of byNamespace) {
        // `replace`: clearing a field clears the override, never leaves the old one standing.
        await options.wire().request('settings/set', { ns, patch: entry.patch, expectedRevision: entry.revision, replace: true })
      }
      toast('Saved. New sessions start with these defaults.')
      // HERE, not only in the `close` event: this save's own `settings.changed`
      // may have started a refresh whose answer arrives before that event is
      // dispatched, and a refresh still current would reopen what this closes.
      generation++
      dialog.close()
    } catch (error) {
      fail(error)
      await show('defaults')
    } finally {
      save.disabled = false
    }
  }

  function about() {
    const init = options.init()
    const content = h('div', { class: 'settings-page' })
    const rows = h('dl', { class: 'kv' })
    for (const [key, value] of [
      ['Version', init ? `${init.serverInfo.name} ${init.serverInfo.version}` : 'not connected'],
      ['Workspaces', init ? init.workspaces.map((workspace) => `${workspace.name} — ${workspace.root}`).join('\n') : ''],
      ['Providers', init ? init.providers.map((provider) => `${provider.id} (${provider.models.length} models)`).join(', ') : ''],
    ]) {
      rows.append(h('dt', { text: key ?? '' }), h('dd', { class: 'mono', text: value ?? '' }))
    }
    content.append(
      h('div', { class: 'settings-card' }, rows),
      h('p', { class: 'hint', text: 'MiniDSH is an independent, architecture-first harness inspired by DeepSeek Harness; it is not a DeepSeek product.' }),
    )
    return content
  }

  /** `maxParallelToolCalls` → `Max parallel tool calls`. @param {string} key */
  const label = (key) => {
    const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
    return words.charAt(0).toUpperCase() + words.slice(1)
  }

  return {
    /** @param {'general' | 'defaults' | 'about'} [which] */
    open(which) {
      void show(which).catch(fail)
    },
    /** Another client saved settings: a page showing them is stale. */
    changed() {
      if (dialog.open && page === 'defaults') void show('defaults').catch(fail)
    },
  }
}
