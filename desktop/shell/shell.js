// The desktop shell's views, drawn from the state main sends (`shell:view`).
// Nodes and text only: the page's CSP has Trusted Types with no policy, so an
// HTML-string sink would throw — and the stopped view shows a runtime's
// stderr, which is text a model's tool output may have shaped.
'use strict'

/** @type {any} */
const api = /** @type {any} */ (window).minidshShell
const root = /** @type {HTMLElement} */ (document.getElementById('shell'))

/**
 * @param {string} tag
 * @param {{ class?: string, text?: string, attrs?: Record<string, string>, on?: Record<string, (event: Event) => void> }} [props]
 * @param {...(Node | null | undefined | false)} children
 */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  if (props.class) node.className = props.class
  if (props.text !== undefined) node.textContent = props.text
  for (const [name, value] of Object.entries(props.attrs ?? {})) node.setAttribute(name, value)
  for (const [name, handler] of Object.entries(props.on ?? {})) node.addEventListener(name, handler)
  for (const child of children) if (child) node.append(child)
  return node
}

const mark = () => h('img', { class: 'mark', attrs: { src: 'mark.svg', alt: '' } })

/** @param {string} label @param {() => unknown} action @param {boolean} [primary] */
function button(label, action, primary = false) {
  const node = h('button', { class: primary ? 'primary' : '', text: label, attrs: { type: 'button' } })
  node.addEventListener('click', async () => {
    node.setAttribute('disabled', '')
    try {
      await action()
    } finally {
      node.removeAttribute('disabled')
    }
  })
  return node
}

const SOURCES = /** @type {Record<string, [string, string]>} */ ({
  env: ['set in the environment', 'ok'],
  store: ['saved', 'ok'],
  absent: ['not set', 'warn'],
})

/**
 * The provider-key rows: presence only, never a value (`minidsh credentials
 * list`). Returned at once with a placeholder and filled when the list
 * arrives: the list boots the runtime's composition, a second or more cold.
 */
function keyRows() {
  const box = h('div', {}, h('p', { class: 'note', text: 'Checking provider keys…' }))
  void fillKeys(box)
  return box
}

/** @param {HTMLElement} box */
async function fillKeys(box) {
  const result = await api.listKeys().catch((/** @type {unknown} */ error) => ({ ok: false, message: String(error) }))
  box.replaceChildren()
  if (!result || result.ok === false) {
    box.append(h('p', { class: 'error', text: `Could not read the provider keys: ${result?.message ?? 'no answer'}` }))
    return
  }
  for (const ref of result.refs) {
    const [label, tone] = SOURCES[ref.source] ?? ['unknown', 'warn']
    const row = h('div', { class: 'row' }, h('span', { class: 'name', text: ref.name }), h('span', { class: `badge ${tone}`, text: label }))
    if (ref.source !== 'env' && result.store !== null) {
      const input = /** @type {HTMLInputElement} */ (h('input', { attrs: { type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-label': `${ref.name} value`, placeholder: ref.source === 'store' ? 'Replace the saved key' : 'Paste the key' } }))
      const status = h('span', { class: 'note' })
      const save = button('Save', async () => {
        const value = input.value.trim()
        if (value.length === 0) return
        const saved = await api.saveKey(ref.name, value).catch((/** @type {unknown} */ error) => ({ ok: false, message: String(error) }))
        input.value = ''
        if (saved && saved.ok !== false) await render()
        else status.textContent = saved?.message ?? 'not saved'
      })
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') save.click()
      })
      row.append(h('div', { class: 'keyform' }, input, save), status)
    }
    box.append(row)
  }
  box.append(
    h('p', {
      class: 'note',
      text:
        result.store === null
          ? 'This MiniDSH reads keys from the environment only: its composition mounts no key store, so none can be saved here.'
          : `Saved keys live in ${result.store}; a key set in the environment wins. DeepSeek is the default provider (DEEPSEEK_API_KEY).`,
    }),
  )
}

/** @param {any} state */
async function draw(state) {
  const view = state.view ?? { kind: 'starting' }
  const card = h('div', { class: 'card' }, mark())
  switch (view.kind) {
    case 'starting':
      card.append(h('h1', { text: 'Starting MiniDSH…' }), h('div', { class: 'progress', attrs: { role: 'progressbar', 'aria-label': 'Starting' } }))
      break
    case 'stopping':
      card.append(
        h('h1', { text: view.restarting ? 'Restarting MiniDSH…' : 'Stopping MiniDSH…' }),
        h('p', { text: 'Finishing what is running and saving every session.' }),
        h('div', { class: 'progress', attrs: { role: 'progressbar', 'aria-label': 'Stopping' } }),
      )
      break
    case 'welcome': {
      card.append(
        h('h1', { text: 'Welcome to MiniDSH' }),
        view.notice ? h('p', { class: 'error', text: view.notice }) : null,
        h('p', { text: 'Choose a folder for MiniDSH to work in. It reads and edits files there and runs commands there with your approval; every session keeps a log you can resume, fork and audit.' }),
        h('div', { class: 'actions' }, button('Choose a folder…', () => api.chooseFolder(), true)),
      )
      const before = h('div', { class: 'section' }, h('h2', { text: 'Before you start' }))
      if (state.platform === 'win32') {
        before.append(
          h(
            'div',
            { class: 'row' },
            h('span', { text: 'PowerShell 7' }),
            h('span', { class: `badge ${state.pwsh ? 'ok' : 'bad'}`, text: state.pwsh ? 'found' : 'not found' }),
            state.pwsh ? null : h('span', { class: 'hint' }, document.createTextNode('Shell commands need it. Install it with '), h('code', { text: 'winget install Microsoft.PowerShell' }), document.createTextNode(', then restart MiniDSH.')),
          ),
        )
      }
      before.append(h('h2', { text: 'Provider keys' }), keyRows())
      card.append(before)
      break
    }
    case 'keys':
      card.append(h('h1', { text: 'Provider keys' }), h('p', { text: 'A key saved here is used by the next request; nothing restarts.' }), keyRows(), h('div', { class: 'actions' }, button('Done', () => api.closeKeys(), true)))
      break
    case 'stopped':
      card.append(
        h('h1', { text: view.title }),
        h('p', { text: view.detail }),
        view.tail ? h('pre', { class: 'tail', text: view.tail }) : null,
        h('div', { class: 'actions' }, button('Restart', () => api.restart(), true), button('Show logs', () => api.showLogs()), button('Quit', () => api.quit())),
      )
      break
    default:
      card.append(h('h1', { text: 'MiniDSH' }))
  }
  root.replaceChildren(card)
  const focus = root.querySelector('button.primary')
  if (focus instanceof HTMLElement) focus.focus()
}

/** @type {any} */
let last
async function render() {
  await draw(last ?? (await api.state()))
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && last?.view?.kind === 'keys') void api.closeKeys()
})

if (api) {
  api.onView((/** @type {any} */ state) => {
    last = state
    void draw(state)
  })
  void render()
}
