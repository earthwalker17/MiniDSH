// @ts-check
/**
 * Markdown on the page: `markdown.js`'s node tree turned into elements, with
 * code blocks highlighted by `highlight.js`.
 *
 * Model-written text is the input, and this client is an authority surface,
 * so nothing here builds markup from a string: every node is an element whose
 * text is set with `textContent`, a link's target was already held to
 * http(s)/mailto by the parser, and the page's Trusted Types CSP would refuse
 * an HTML sink anyway.
 */
import { highlight } from './highlight.js'
import { parseMarkdown } from './markdown.js'
import { copyButton, h, iconButton } from './ui.js'

/** @typedef {import('./markdown.js').Block} Block */
/** @typedef {import('./markdown.js').Inline} Inline */

/**
 * @param {string} text
 * @param {{ streaming?: boolean, className?: string }} [options]
 * @returns {HTMLElement}
 */
export function markdown(text, options = {}) {
  const root = h('div', { class: `md${options.className ? ` ${options.className}` : ''}` })
  fillMarkdown(root, text, options)
  return root
}

/**
 * Replaces an element's children with the rendering of `text` — the live
 * preview re-renders its whole (short) text per frame rather than diffing.
 * @param {HTMLElement} root @param {string} text @param {{ streaming?: boolean }} [options]
 */
export function fillMarkdown(root, text, options = {}) {
  const tree = parseMarkdown(text, { streaming: options.streaming === true })
  root.replaceChildren(...tree.children.map(block))
}

/** @param {Block} node @returns {Node} */
function block(node) {
  if (node.type === 'paragraph') return h('p', {}, ...node.children.map(inline))
  if (node.type === 'heading') return h(/** @type {'h1'} */ (`h${Math.min(6, Math.max(1, node.depth))}`), {}, ...node.children.map(inline))
  if (node.type === 'code') return codeBlock(node.text, node.lang)
  if (node.type === 'blockquote') return h('blockquote', {}, ...node.children.map(block))
  if (node.type === 'rule') return h('hr')
  if (node.type === 'list') {
    const list = h(node.ordered ? 'ol' : 'ul', node.ordered && node.start !== undefined && node.start !== 1 ? { attrs: { start: String(node.start) } } : {})
    for (const item of node.items) {
      const li = h('li', item.checked === undefined ? {} : { class: 'task' })
      if (item.checked !== undefined) li.append(h('input', { attrs: { type: 'checkbox', disabled: '', ...(item.checked ? { checked: '' } : {}), 'aria-label': item.checked ? 'done' : 'not done' } }))
      // A tight item's single paragraph reads as its line, not as a block.
      const children = item.children.length === 1 && item.children[0]?.type === 'paragraph' ? item.children[0].children.map(inline) : item.children.map(block)
      li.append(...children)
      list.append(li)
    }
    return list
  }
  if (node.type === 'table') return table(node)
  return document.createTextNode('')
}

/** @param {Extract<Block, { type: 'table' }>} node */
function table(node) {
  /** @param {number} column */
  const align = (column) => {
    const value = node.align[column]
    return value === 'center' ? 'align-center' : value === 'right' ? 'align-right' : undefined
  }
  const head = h('thead', {}, h('tr', {}, ...node.head.map((cell, column) => h('th', { class: align(column), attrs: { scope: 'col' } }, ...cell.map(inline)))))
  const body = h('tbody', {}, ...node.rows.map((row) => h('tr', {}, ...row.map((cell, column) => h('td', { class: align(column) }, ...cell.map(inline))))))
  return h('div', { class: 'table-wrap' }, h('table', {}, head, body))
}

/** @param {Inline} node @returns {Node} */
function inline(node) {
  if (node.type === 'text') return document.createTextNode(node.text)
  if (node.type === 'strong') return h('strong', {}, ...node.children.map(inline))
  if (node.type === 'emphasis') return h('em', {}, ...node.children.map(inline))
  if (node.type === 'delete') return h('del', {}, ...node.children.map(inline))
  if (node.type === 'code') return h('code', { text: node.text })
  if (node.type === 'break') return h('br')
  if (node.type === 'link') {
    // `noreferrer` too: the page sets no-referrer, but a link should not lean on it.
    return h('a', { attrs: { href: node.href, target: '_blank', rel: 'noopener noreferrer' } }, ...node.children.map(inline))
  }
  return document.createTextNode('')
}

/**
 * A code block: its language, a wrap toggle and a copy button in a quiet
 * bar, the code highlighted below.
 * @param {string} text @param {string} [lang]
 */
export function codeBlock(text, lang) {
  const pre = h('pre')
  pre.append(highlighted(text, lang))
  const box = h('div', { class: 'codeblock' })
  const wrap = iconButton('wrap', 'Wrap lines', () => {
    const on = box.classList.toggle('wrap')
    wrap.setAttribute('aria-pressed', String(on))
  })
  wrap.setAttribute('aria-pressed', 'false')
  box.append(h('div', { class: 'codeblock-bar' }, h('span', { class: 'lang', text: lang ?? 'text' }), wrap, copyButton(() => text, 'Copy code')), pre)
  return box
}

/** @param {string} text @param {string} [lang] @returns {DocumentFragment} */
export function highlighted(text, lang) {
  const fragment = document.createDocumentFragment()
  const code = h('code')
  for (const token of highlight(text, lang ?? '')) {
    code.append(token.kind ? h('span', { class: `tok-${token.kind}`, text: token.text }) : document.createTextNode(token.text))
  }
  fragment.append(code)
  return fragment
}
