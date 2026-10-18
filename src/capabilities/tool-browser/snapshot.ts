/**
 * The page as text, and the refs that let an action name what the text shows.
 *
 * The text is the accessibility tree rendered the way Playwright's AI snapshot
 * renders it, so a model that has read one reads this: one line per node, two
 * spaces per level, `- role "name" [flags] [ref=eN]`, then `: text` when the
 * node holds only text or `:` when lines follow. Chrome's own tree is read
 * (`Accessibility.getFullAXTree`, one call per same-process frame) rather than
 * computed in the page, so a page script cannot shape what the model sees.
 *
 * A REF IS A PROMISE ABOUT ONE DOCUMENT. It names (frame, document, backend
 * node), and it resolves only while that frame still shows that document
 * (`loaderId`) and the node is still in it. Backend node ids are unique only
 * within a renderer, and a cross-origin navigation swaps renderers, so a ref
 * is never resolved to "whatever node now has that id": a changed document, a
 * replaced node or another launch is `BROWSER_STALE_REF`, and the model
 * snapshots again. Numbers come from the agent's counter (`RefCounter`), which
 * outlives relaunches, so no two refs an agent ever saw share a name.
 *
 * Text nodes render as `- text:` lines without a ref, as Playwright renders
 * them: a click lands on an element, and the element holding the text has one.
 */
import { BrowserError } from './errors.ts'
import type { CallBudget, RefCounter, Viewport } from './types.ts'

/** What the snapshot and the actions borrow from the page that owns the CDP session (`page.ts`). */
export interface PageSession {
  /** One command on the page's session, bounded by the call's budget. */
  send<T>(method: string, params: Record<string, unknown>, budget: CallBudget): Promise<T>
  /** Waits `ms`, or until the deadline if that is sooner; rejects when the call is cancelled. */
  sleep(ms: number, budget: CallBudget): Promise<void>
  /** The document a frame shows now, or `undefined` for a frame this page no longer has. */
  documentOf(frameId: string): string | undefined
  /** A frame's parent; `undefined` for the main frame. */
  parentOf(frameId: string): string | undefined
  /** What a fresh `Page.getFrameTree` said a frame shows: authoritative at the moment it was read. */
  frameSeen(frameId: string, loaderId: string, parentId: string | undefined): void
  readonly refs: RefTable
  /** In CSS pixels: where a pointer can land. */
  readonly viewport: Viewport
}

/** The object group every remote object this module creates joins, released after each operation (`page.ts`). */
export const OBJECT_GROUP = 'minidsh'

export interface RefEntry {
  readonly ref: string
  readonly generation: number
  readonly frameId: string
  readonly loaderId: string
  readonly backendNodeId: number
  /** As the latest snapshot rendered it: what an action's account of itself calls the element. */
  role: string
  name: string
}

/** Past this many live refs the least recently rendered goes; resolving it then says "snapshot again", which is true. */
const MAX_REFS = 20_000

/** The page's refs. A node seen again in the same document keeps its ref, so two snapshots of a quiet page agree. */
export class RefTable {
  readonly generation: number
  private readonly counter: RefCounter
  private readonly byRef = new Map<string, RefEntry>()
  private readonly byNode = new Map<string, string>()

  constructor(counter: RefCounter, generation: number) {
    this.counter = counter
    this.generation = generation
  }

  /** The ref of this node in this document, minted the first time it is rendered. */
  refFor(frameId: string, loaderId: string, backendNodeId: number, role: string, name: string): string {
    const key = `${loaderId} ${backendNodeId}`
    const known = this.byNode.get(key)
    const entry = known === undefined ? undefined : this.byRef.get(known)
    if (entry !== undefined) {
      entry.role = role
      entry.name = name
      // Re-inserted, so the bound drops the refs not rendered for longest.
      this.byRef.delete(entry.ref)
      this.byRef.set(entry.ref, entry)
      return entry.ref
    }
    const ref = `e${this.counter.next++}`
    this.byRef.set(ref, { ref, generation: this.generation, frameId, loaderId, backendNodeId, role, name })
    this.byNode.set(key, ref)
    if (this.byRef.size > MAX_REFS) {
      const oldest = this.byRef.values().next().value
      if (oldest !== undefined) this.drop(oldest)
    }
    return ref
  }

  get(ref: string): RefEntry | undefined {
    return this.byRef.get(ref)
  }

  /** A frame committed a document: every ref into another document of that frame is retired. */
  documentChanged(frameId: string, loaderId: string): void {
    for (const entry of Array.from(this.byRef.values())) if (entry.frameId === frameId && entry.loaderId !== loaderId) this.drop(entry)
  }

  frameGone(frameId: string): void {
    for (const entry of Array.from(this.byRef.values())) if (entry.frameId === frameId) this.drop(entry)
  }

  /** A crash: no document survives it. */
  clear(): void {
    this.byRef.clear()
    this.byNode.clear()
  }

  private drop(entry: RefEntry): void {
    this.byRef.delete(entry.ref)
    this.byNode.delete(`${entry.loaderId} ${entry.backendNodeId}`)
  }
}

/** How an action names its element: `button "Add one" [ref=e4]`. */
export function describeRef(entry: RefEntry): string {
  return `${entry.role}${entry.name === '' ? '' : ` ${JSON.stringify(entry.name)}`} [ref=${entry.ref}]`
}

/**
 * The live node a ref names, or `BROWSER_STALE_REF`. Four checks, each a way a
 * ref outlives its node: an unknown ref, another launch's, a frame that shows
 * another document now, and a node the document no longer holds — which
 * `DOM.resolveNode` still resolves while anything keeps the node alive, so
 * `isConnected` is asked rather than inferred.
 */
export async function resolveRef(session: PageSession, ref: string, budget: CallBudget): Promise<{ readonly entry: RefEntry; readonly objectId: string }> {
  const stale = (): BrowserError => new BrowserError('BROWSER_STALE_REF', `ref ${ref} is from a page that has changed since that snapshot; take a new snapshot`)
  const entry = session.refs.get(ref)
  if (entry === undefined || entry.generation !== session.refs.generation || session.documentOf(entry.frameId) !== entry.loaderId) throw stale()
  const objectId = await resolveNode(session, entry.backendNodeId, budget)
  if (objectId === undefined) throw stale()
  if ((await callFunction(session, objectId, 'function () { return this.isConnected }', [], budget)) !== true) throw stale()
  return { entry, objectId }
}

/** A node as a remote object in the page, or `undefined` when the page no longer has it. */
export async function resolveNode(session: PageSession, backendNodeId: number, budget: CallBudget): Promise<string | undefined> {
  try {
    const answer = await session.send<{ object?: unknown }>('DOM.resolveNode', { backendNodeId, objectGroup: OBJECT_GROUP }, budget)
    return text(record(answer.object)?.objectId)
  } catch (error) {
    if (isProtocolError(error)) return undefined
    throw error
  }
}

export type CallArgument = { readonly value: unknown } | { readonly objectId: string }

/** Calls a function with `this` bound to the object and returns its value; a throw inside is a protocol fault (these helpers do not throw). */
export async function callFunction(session: PageSession, objectId: string, declaration: string, args: readonly CallArgument[], budget: CallBudget): Promise<unknown> {
  const answer = await session.send<{ result?: unknown; exceptionDetails?: unknown }>(
    'Runtime.callFunctionOn',
    { objectId, functionDeclaration: declaration, arguments: args, returnByValue: true, awaitPromise: true },
    budget,
  )
  const details = record(answer.exceptionDetails)
  if (details !== undefined) throw new BrowserError('BROWSER_PROTOCOL', `a helper failed in the page: ${exceptionText(details)}`)
  return record(answer.result)?.value
}

/**
 * The snapshot. With `ref`, only the subtree that element roots; a ref the
 * page has changed under is `BROWSER_STALE_REF`, and an element that is in the
 * page but not in the accessibility tree (hidden) renders as nothing. `read`
 * is a tree already read (`waitForText` hands over the one it found the text
 * in), so a large page is not read twice.
 */
export async function renderSnapshot(session: PageSession, budget: CallBudget, ref?: string, read?: FrameAX): Promise<string> {
  const target = ref === undefined ? undefined : (await resolveRef(session, ref, budget)).entry
  const main = read ?? (await readTree(session, budget))
  if (main?.root === undefined) return ''
  const renderer = new Renderer(session.refs)
  if (target === undefined) {
    renderer.content(contentOf(main, main.root), 0)
  } else {
    const found = findNode(main, target.frameId, target.backendNodeId)
    if (found !== undefined) {
      if (found.node.ignored || TRANSPARENT.has(found.node.role)) renderer.content(contentOf(found.frame, found.node), 0)
      else renderer.node(found.frame, found.node, 0)
    }
  }
  return renderer.lines.join('\n')
}

/** One read of the page's accessibility tree: the main frame's, with every same-process frame's below it. */
export async function readTree(session: PageSession, budget: CallBudget): Promise<FrameAX | undefined> {
  const answer = await session.send<{ frameTree?: unknown }>('Page.getFrameTree', {}, budget)
  return readFrame(session, answer.frameTree, budget)
}

/** Reads no more often than this, and no more often than one read takes: a large page's tree costs as much as a snapshot. */
const WAIT_POLL_MS = 200

/**
 * Reads the tree until the text the snapshot would show contains `wanted`,
 * and hands back that read for the snapshot to render. The snapshot's own
 * text, not `innerText`: measured, `document.body.innerText` never shows a
 * shadow root's text (closed or open), which the accessibility tree does,
 * along with same-process frames. The first read always happens, so text that
 * is already there is found however short the wait; after that, past `until`,
 * rejects `BROWSER_TIMEOUT` naming the text. Each read runs under the whole
 * budget, so a read begun before `until` may end after it. A read that lands
 * between documents counts as "not yet".
 */
export async function waitForText(session: PageSession, wanted: string, until: number, budget: CallBudget): Promise<FrameAX> {
  const missing = (): BrowserError => new BrowserError('BROWSER_TIMEOUT', `the text ${JSON.stringify(wanted)} did not appear on the page before the wait ended`)
  const needle = collapse(wanted)
  for (;;) {
    const started = Date.now()
    try {
      const main = await readTree(session, budget)
      if (main?.root !== undefined && textOf(main).includes(needle)) return main
    } catch (error) {
      if (error instanceof BrowserError && error.code === 'BROWSER_TIMEOUT') throw missing()
      if (!isProtocolError(error)) throw error
    }
    const now = Date.now()
    if (now >= until) throw missing()
    await session.sleep(Math.min(Math.max(WAIT_POLL_MS, now - started), until - now), budget)
  }
}

/** The words the snapshot shows — text, names and values, one line each — for `waitForText` to search. */
function textOf(main: FrameAX): string {
  const out: string[] = []
  const walk = (frame: FrameAX, node: AXNode): void => {
    for (const item of contentOf(frame, node)) {
      if ('text' in item) {
        out.push(item.text)
        continue
      }
      const child = item.node
      if (child.name !== '') out.push(collapse(child.name))
      if (child.value !== undefined) out.push(collapse(child.value))
      if (child.role !== 'Iframe') {
        walk(item.frame, child)
        continue
      }
      const inner = child.backendNodeId === undefined ? undefined : item.frame.children.get(child.backendNodeId)
      if (inner?.root !== undefined) walk(inner, inner.root)
    }
  }
  if (main.root !== undefined) walk(main, main.root)
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// The tree

interface AXNode {
  readonly id: string
  readonly ignored: boolean
  readonly role: string
  readonly name: string
  readonly value: string | undefined
  readonly properties: ReadonlyMap<string, unknown>
  readonly childIds: readonly string[]
  readonly backendNodeId: number | undefined
}

/** One frame's accessibility tree as read (`readTree`); opaque outside this module. */
export interface FrameAX {
  readonly frameId: string
  readonly loaderId: string
  readonly nodes: ReadonlyMap<string, AXNode>
  readonly root: AXNode | undefined
  /** The child frames this page can read, by the backend id of the iframe element holding each. */
  readonly children: ReadonlyMap<number, FrameAX>
}

type Item = { readonly text: string } | { readonly node: AXNode; readonly frame: FrameAX }

/**
 * Chrome's internal role names, as the ARIA vocabulary a Playwright snapshot
 * uses (a `<summary>` is Chrome's DisclosureTriangle). The picker inputs are
 * textboxes there, as Playwright names every input type without a role of
 * its own; measured on Chrome 155: date is `Date`, time `InputTime`,
 * datetime-local, month and week `DateTime`, colour `ColorWell`, each with its
 * value as the field holds it (2024-01-15, 13:45) — and as textboxes they show
 * that value, not the spin fields and picker button Chrome puts inside them.
 * An `<svg>` already reads `image` there; `SvgRoot` is its role where it does not.
 */
const ROLE_NAMES: Readonly<Record<string, string>> = {
  Iframe: 'iframe',
  image: 'img',
  SvgRoot: 'img',
  LabelText: 'generic',
  MenuListOption: 'option',
  DisclosureTriangle: 'button',
  Date: 'textbox',
  DateTime: 'textbox',
  InputTime: 'textbox',
  ColorWell: 'textbox',
}
/** Wrappers whose children stand in their place: `<select>`'s popup and explicit `role=none`. */
const TRANSPARENT = new Set(['none', 'presentation', 'MenuListPopup', 'RootWebArea'])
/** Layout detail with no meaning of its own: line boxes, and list bullets (which a Playwright snapshot omits). */
const SKIPPED = new Set(['InlineTextBox', 'ListMarker'])
/** Whose content IS their value: the inner editor's text would only repeat it. */
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'spinbutton'])

/**
 * One frame's tree, and every same-process frame below it. A frame that is
 * not in the frame tree runs in another process (cross-origin): it renders
 * as a note, and this page never attaches to it. A frame that goes away while
 * it is read is left out.
 */
async function readFrame(session: PageSession, raw: unknown, budget: CallBudget): Promise<FrameAX | undefined> {
  const tree = record(raw)
  const frame = record(tree?.frame)
  const frameId = text(frame?.id)
  const loaderId = text(frame?.loaderId)
  if (frameId === undefined || loaderId === undefined) return undefined
  session.frameSeen(frameId, loaderId, text(frame?.parentId))
  const answer = await session.send<{ nodes?: unknown }>('Accessibility.getFullAXTree', { frameId }, budget)
  const nodes = new Map<string, AXNode>()
  let root: AXNode | undefined
  for (const rawNode of list(answer.nodes)) {
    const node = toNode(rawNode)
    if (node === undefined) continue
    nodes.set(node.id, node)
    root ??= node
  }
  const children = new Map<number, FrameAX>()
  await Promise.all(
    list(tree?.childFrames).map(async (child) => {
      const childId = text(record(record(child)?.frame)?.id)
      if (childId === undefined) return
      try {
        const owner = await session.send<{ backendNodeId?: unknown }>('DOM.getFrameOwner', { frameId: childId }, budget)
        const ownerId = numberOf(owner.backendNodeId)
        const read = await readFrame(session, child, budget)
        if (ownerId !== undefined && read !== undefined) children.set(ownerId, read)
      } catch (error) {
        if (!isProtocolError(error)) throw error
      }
    }),
  )
  return { frameId, loaderId, nodes, root, children }
}

function toNode(raw: unknown): AXNode | undefined {
  const node = record(raw)
  const id = text(node?.nodeId)
  if (node === undefined || id === undefined) return undefined
  const properties = new Map<string, unknown>()
  for (const property of list(node.properties)) {
    const entry = record(property)
    const name = text(entry?.name)
    if (name !== undefined) properties.set(name, record(entry?.value)?.value)
  }
  const value = record(node.value)?.value
  return {
    id,
    ignored: node.ignored === true,
    role: text(record(node.role)?.value) ?? '',
    name: text(record(node.name)?.value) ?? '',
    value: typeof value === 'string' || typeof value === 'number' ? String(value) : undefined,
    properties,
    childIds: list(node.childIds).filter((child): child is string => typeof child === 'string'),
    backendNodeId: numberOf(node.backendDOMNodeId),
  }
}

function findNode(frame: FrameAX, frameId: string, backendNodeId: number): { readonly frame: FrameAX; readonly node: AXNode } | undefined {
  if (frame.frameId === frameId) {
    for (const node of frame.nodes.values()) if (node.backendNodeId === backendNodeId) return { frame, node }
    return undefined
  }
  for (const child of frame.children.values()) {
    const found = findNode(child, frameId, backendNodeId)
    if (found !== undefined) return found
  }
  return undefined
}

/** A node's rendered children: ignored and transparent nodes replaced by theirs, adjacent text merged. */
function contentOf(frame: FrameAX, node: AXNode): Item[] {
  const raw: Item[] = []
  gather(frame, node, raw)
  const out: Item[] = []
  let pending = ''
  const flush = (): void => {
    const merged = collapse(pending)
    if (merged !== '') out.push({ text: merged })
    pending = ''
  }
  for (const item of raw) {
    if ('text' in item) {
      pending += item.text
    } else {
      flush()
      out.push(item)
    }
  }
  flush()
  return out
}

function gather(frame: FrameAX, parent: AXNode, out: Item[]): void {
  for (const id of parent.childIds) {
    const child = frame.nodes.get(id)
    if (child === undefined || SKIPPED.has(child.role)) continue
    if (child.ignored || TRANSPARENT.has(child.role)) gather(frame, child, out)
    else if (child.role === 'StaticText') out.push({ text: child.name })
    else if (child.role === 'LineBreak') out.push({ text: '\n' })
    else out.push({ node: child, frame })
  }
}

class Renderer {
  readonly lines: string[] = []
  private readonly refs: RefTable

  constructor(refs: RefTable) {
    this.refs = refs
  }

  node(frame: FrameAX, node: AXNode, depth: number): void {
    const role = ROLE_NAMES[node.role] ?? node.role
    const name = collapse(node.name)
    let line = `${indent(depth)}- ${role}`
    if (name !== '') line += ` ${JSON.stringify(name)}`
    line += flagsOf(role, node.properties)
    if (node.backendNodeId !== undefined) line += ` [ref=${this.refs.refFor(frame.frameId, frame.loaderId, node.backendNodeId, role, name)}]`

    if (node.role === 'Iframe') {
      const child = node.backendNodeId === undefined ? undefined : frame.children.get(node.backendNodeId)
      if (child?.root === undefined) this.lines.push(`${line}: (cross-origin frame, not shown)`)
      else this.open(line, contentOf(child, child.root), depth)
      return
    }
    const content = contentOf(frame, node)
    // A `<select>` shows its options, each `[selected]` or not; a combobox
    // with nothing below it (an ARIA input) shows its value like a textbox.
    if (VALUE_ROLES.has(role) || (role === 'combobox' && !content.some((item) => 'node' in item))) {
      const value = node.value === undefined ? '' : collapse(node.value)
      this.lines.push(value === '' ? line : `${line}: ${value}`)
      return
    }
    const only = content.length === 1 ? content[0] : undefined
    if (only !== undefined && 'text' in only) {
      // Playwright's rule: text that only repeats the name is not said twice.
      this.lines.push(only.text === name ? line : `${line}: ${only.text}`)
      return
    }
    this.open(line, content, depth)
  }

  content(items: readonly Item[], depth: number): void {
    for (const item of items) {
      if ('text' in item) this.lines.push(`${indent(depth)}- text: ${item.text}`)
      else this.node(item.frame, item.node, depth)
    }
  }

  private open(line: string, items: readonly Item[], depth: number): void {
    if (items.length === 0) {
      this.lines.push(line)
      return
    }
    this.lines.push(`${line}:`)
    this.content(items, depth + 1)
  }
}

/**
 * Playwright's flags, in Playwright's order. `focused` is the element with
 * focus, which Playwright calls `[active]`. A level is a heading's: Chrome
 * also gives every list item its nesting depth, which Playwright shows only
 * when the page set `aria-level` — and the tree cannot tell the two apart.
 */
function flagsOf(role: string, properties: ReadonlyMap<string, unknown>): string {
  let out = ''
  const checked = properties.get('checked')
  if (checked === 'true' || checked === true) out += ' [checked]'
  else if (checked === 'mixed') out += ' [checked=mixed]'
  if (properties.get('disabled') === true) out += ' [disabled]'
  if (properties.get('expanded') === true) out += ' [expanded]'
  if (properties.get('focused') === true) out += ' [active]'
  const level = properties.get('level')
  if (role === 'heading' && typeof level === 'number') out += ` [level=${level}]`
  const pressed = properties.get('pressed')
  if (pressed === 'true' || pressed === true) out += ' [pressed]'
  else if (pressed === 'mixed') out += ' [pressed=mixed]'
  if (properties.get('selected') === true) out += ' [selected]'
  return out
}

const indent = (depth: number): string => '  '.repeat(depth)
const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim()

// ---------------------------------------------------------------------------
// Reading protocol payloads. Everything CDP sends is `unknown` until one of
// these has looked at it; there is no cast to a payload type anywhere.

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

export function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/** True for the browser's answer "no" (a node, frame or context it does not have), as opposed to a dead connection, a deadline or a cancellation. */
export function isProtocolError(error: unknown): boolean {
  return error instanceof BrowserError && error.code === 'BROWSER_PROTOCOL'
}

/** An exception as the page would print it: the message, without the stack. */
export function exceptionText(details: Record<string, unknown>): string {
  const exception = record(details.exception)
  const description = text(exception?.description)
  if (description !== undefined) return description.split(/\n\s+at /)[0] ?? description
  if (exception !== undefined && 'value' in exception) return `${text(details.text) ?? 'Uncaught'} ${typeof exception.value === 'string' ? exception.value : JSON.stringify(exception.value)}`
  return text(details.text) ?? 'an exception'
}
