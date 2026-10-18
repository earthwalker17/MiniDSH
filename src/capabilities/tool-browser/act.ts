/**
 * The actions, with Playwright's actionability: an element is acted on only
 * when a person could act on it, and otherwise the refusal says why.
 *
 * Pointer actions are REAL INPUT (`Input.dispatchMouseEvent` at the element's
 * centre), never `element.click()`: a script click reaches a covered or
 * disabled element a person could not, and a verifier that clicks through an
 * overlay reports a page that works when it does not. So before the pointer
 * moves: the element is scrolled into view, it has a box inside the viewport,
 * the box holds still across two animation frames, a click target is not
 * disabled, and the hit test at the point lands on the element itself or
 * something inside it — or the refusal names what is on top.
 *
 * Typing is real input too (`Input.insertText` after selecting the old
 * content), so a framework that tracks a field's value through its setter
 * sees a change; an assigned `.value` it would not.
 *
 * Coordinates are CSS pixels in the main frame's viewport. Measured on Chrome
 * 155: `DOM.getContentQuads` of a node inside a same-process iframe already
 * answers in those coordinates (the frame's offset applied), and
 * `DOM.getNodeForLocation` at that point answers the node inside the frame
 * with that frame's id — so one point serves both, and the hit test climbs
 * from the hit frame to the target's through `DOM.getFrameOwner`.
 */
import { BrowserError } from './errors.ts'
import { callFunction, describeRef, isProtocolError, list, numberOf, record, resolveNode, resolveRef, text, type PageSession, type RefEntry } from './snapshot.ts'
import type { Action, CallBudget } from './types.ts'

/** Performs one action and returns its one-line account; the page runs the settle after it (`page.ts`). */
export async function performAction(session: PageSession, action: Action, budget: CallBudget): Promise<string> {
  switch (action.kind) {
    case 'click':
      return pointer(session, action.ref, true, budget)
    case 'hover':
      return pointer(session, action.ref, false, budget)
    case 'type':
      return typeText(session, action.ref, action.text, action.submit, budget)
    case 'press':
      return press(session, action.key, action.ref, budget)
    case 'select':
      return select(session, action.ref, action.values, budget)
  }
}

// ---------------------------------------------------------------------------
// Pointer

interface Point {
  readonly x: number
  readonly y: number
}

const notActionable = (message: string): BrowserError => new BrowserError('BROWSER_NOT_ACTIONABLE', message)

async function pointer(session: PageSession, ref: string, click: boolean, budget: CallBudget): Promise<string> {
  const { entry, objectId } = await resolveRef(session, ref, budget)
  const label = describeRef(entry)
  const point = await stablePoint(session, entry, label, budget)
  // Hover is allowed on a disabled element (its tooltip is a thing to check); a click is not.
  if (click && (await callFunction(session, objectId, IS_DISABLED, [], budget)) === true) throw notActionable(`${label} is disabled`)
  await expectHit(session, entry, objectId, point, label, budget)
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0 }, budget)
  if (!click) return `hovered ${label}`
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 }, budget)
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 }, budget)
  return `clicked ${label}`
}

const IS_DISABLED = `function () {
  const element = this.nodeType === 1 ? this : this.parentElement
  if (!element) return false
  return element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true'
}`

/** Scrolls the element into view and returns its centre once it holds still: measured, two animation frames, measured again, up to three times. */
async function stablePoint(session: PageSession, entry: RefEntry, label: string, budget: CallBudget): Promise<Point> {
  const hidden = (): BrowserError => notActionable(`${label} is not visible (no box on screen to act on)`)
  try {
    await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: entry.backendNodeId }, budget)
  } catch (error) {
    // "Node does not have a layout object": display:none, or detached.
    if (isProtocolError(error)) throw hidden()
    throw error
  }
  let point = await centre(session, entry.backendNodeId, budget)
  if (point === undefined) throw hidden()
  for (let attempt = 1; ; attempt++) {
    await animationFrames(session, budget)
    const again = await centre(session, entry.backendNodeId, budget)
    if (again === undefined) throw hidden()
    if (again.x === point.x && again.y === point.y) return again
    if (attempt === 3) throw notActionable(`${label} is still moving (an animation or a layout still settling); try again once it has stopped`)
    point = again
  }
}

/**
 * The centre of the first quad with an area, cut to the viewport, floored to
 * whole pixels — `DOM.getNodeForLocation` takes integers, and the pointer
 * must land where the hit test looked.
 */
async function centre(session: PageSession, backendNodeId: number, budget: CallBudget): Promise<Point | undefined> {
  let quads = await quadsOf(session, backendNodeId, budget)
  if (quads.length === 0) {
    try {
      const answer = await session.send<{ model?: unknown }>('DOM.getBoxModel', { backendNodeId }, budget)
      quads = toQuads([record(answer.model)?.content])
    } catch (error) {
      if (!isProtocolError(error)) throw error
    }
  }
  const { width, height } = session.viewport
  for (const quad of quads) {
    const box = bounds(quad)
    const left = Math.max(box.left, 0)
    const right = Math.min(box.right, width)
    const top = Math.max(box.top, 0)
    const bottom = Math.min(box.bottom, height)
    if (right - left <= 0 || bottom - top <= 0) continue
    return { x: Math.floor((left + right) / 2), y: Math.floor((top + bottom) / 2) }
  }
  return undefined
}

/** The element's content quads in viewport CSS pixels; none when it has no layout. */
export async function quadsOf(session: PageSession, backendNodeId: number, budget: CallBudget): Promise<number[][]> {
  try {
    const answer = await session.send<{ quads?: unknown }>('DOM.getContentQuads', { backendNodeId }, budget)
    return toQuads(list(answer.quads)).filter((quad) => {
      const box = bounds(quad)
      return box.right > box.left && box.bottom > box.top
    })
  } catch (error) {
    if (isProtocolError(error)) return []
    throw error
  }
}

function toQuads(raw: readonly unknown[]): number[][] {
  const quads: number[][] = []
  for (const quad of raw) {
    const points: number[] = []
    for (const point of list(quad)) {
      const value = numberOf(point)
      if (value !== undefined) points.push(value)
    }
    if (points.length === 8 && list(quad).length === 8) quads.push(points)
  }
  return quads
}

export function bounds(quad: readonly number[]): { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number } {
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!]
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!]
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) }
}

/**
 * Two animation frames in the main frame. The page's own timer caps the wait
 * at 100 ms, so a page whose frames do not run (backgrounded, or busy) slows
 * the check rather than stopping it; a page between documents has no context
 * and the wait is skipped.
 */
async function animationFrames(session: PageSession, budget: CallBudget): Promise<void> {
  try {
    await session.send(
      'Runtime.evaluate',
      { expression: 'new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(done)); setTimeout(done, 100) })', awaitPromise: true },
      budget,
    )
  } catch (error) {
    if (!isProtocolError(error)) throw error
  }
}

/**
 * The hit test: what the pointer would land on must be the element or inside
 * it (through shadow roots, and from a label to the control it labels, as a
 * click on a label reaches its control). A hit in a child frame is climbed to
 * the target's frame through each frame's owner element first.
 */
async function expectHit(session: PageSession, entry: RefEntry, objectId: string, point: Point, label: string, budget: CallBudget): Promise<void> {
  let hit: { backendNodeId?: unknown; frameId?: unknown }
  try {
    hit = await session.send('DOM.getNodeForLocation', { x: point.x, y: point.y, includeUserAgentShadowDOM: true, ignorePointerEventsNone: true }, budget)
  } catch (error) {
    if (isProtocolError(error)) throw notActionable(`${label} cannot be reached: nothing in the page is at its centre (${point.x}, ${point.y})`)
    throw error
  }
  const hitNode = numberOf(hit.backendNodeId)
  if (hitNode === undefined) throw notActionable(`${label} cannot be reached: nothing in the page is at its centre`)
  if (hitNode === entry.backendNodeId) return

  let node: number | undefined = hitNode
  let frame = text(hit.frameId) ?? entry.frameId
  while (node !== undefined && frame !== entry.frameId) {
    const parent = session.parentOf(frame)
    if (parent === undefined) {
      node = undefined
      break
    }
    try {
      node = numberOf((await session.send<{ backendNodeId?: unknown }>('DOM.getFrameOwner', { frameId: frame }, budget)).backendNodeId)
    } catch (error) {
      if (!isProtocolError(error)) throw error
      node = undefined
    }
    frame = parent
  }
  if (node === entry.backendNodeId) return
  if (node !== undefined) {
    const inside = await resolveNode(session, node, budget)
    if (inside !== undefined && (await callFunction(session, objectId, CONTAINS, [{ objectId: inside }], budget)) === true) return
  }
  const covering = await resolveNode(session, hitNode, budget)
  const what = covering === undefined ? 'another element' : await callFunction(session, covering, DESCRIBE, [], budget)
  throw notActionable(`${label} is covered by ${typeof what === 'string' ? what : 'another element'}, which would take the click instead; close or move it first`)
}

const CONTAINS = `function (hit) {
  for (let node = hit; node; node = node.parentNode || (node.nodeType === 11 ? node.host : null)) {
    if (node === this) return true
    if (node.localName === 'label' && node.control === this) return true
  }
  return false
}`

const DESCRIBE = `function () {
  const element = this.nodeType === 1 ? this : this.parentElement
  if (!element) return 'another node'
  let out = '<' + element.localName
  if (element.id) out += ' id="' + element.id + '"'
  const classes = Array.from(element.classList).slice(0, 3).join(' ')
  if (classes) out += ' class="' + classes + '"'
  out += '>'
  const words = (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40)
  return words ? out + ' "' + words + '"' : out
}`

// ---------------------------------------------------------------------------
// Typing

async function typeText(session: PageSession, ref: string, value: string, submit: boolean, budget: CallBudget): Promise<string> {
  const { entry, objectId } = await resolveRef(session, ref, budget)
  const label = describeRef(entry)
  const kind = await callFunction(session, objectId, FIELD_KIND, [], budget)
  if (kind === 'disabled') throw notActionable(`${label} is disabled`)
  if (kind === 'readonly') throw notActionable(`${label} is read-only`)
  if (kind !== 'field' && kind !== 'editable') throw notActionable(`${label} does not take text: type into an input, a textarea or an editable element`)
  await focus(session, entry, label, budget)
  await callFunction(session, objectId, SELECT_CONTENT, [], budget)
  // Measured: an empty insertText deletes the selection and fires `input`,
  // on every platform alike — a Delete key would need macOS's editing commands.
  await session.send('Input.insertText', { text: value }, budget)
  const count = Array.from(value).length
  const done = value === '' ? `cleared ${label}` : `typed ${count} character${count === 1 ? '' : 's'} into ${label}`
  if (!submit) return done
  await dispatchKey(session, { modifiers: [], key: NAMED_KEYS.Enter! }, budget)
  return `${done} and pressed Enter`
}

const FIELD_KIND = `function () {
  const tag = this.localName
  if (tag === 'input' || tag === 'textarea') {
    if (tag === 'input' && ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color', 'hidden'].includes(this.type)) return 'other'
    if (this.disabled) return 'disabled'
    if (this.readOnly) return 'readonly'
    return 'field'
  }
  return this.isContentEditable ? 'editable' : 'other'
}`

const SELECT_CONTENT = `function () {
  if (this.localName === 'input' || this.localName === 'textarea') {
    this.select()
    return
  }
  const range = this.ownerDocument.createRange()
  range.selectNodeContents(this)
  const selection = this.ownerDocument.defaultView.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
}`

async function focus(session: PageSession, entry: RefEntry, label: string, budget: CallBudget): Promise<void> {
  try {
    await session.send('DOM.focus', { backendNodeId: entry.backendNodeId }, budget)
  } catch (error) {
    if (isProtocolError(error)) throw notActionable(`${label} cannot take focus`)
    throw error
  }
}

// ---------------------------------------------------------------------------
// Keys

interface KeyDefinition {
  readonly key: string
  readonly code: string
  readonly keyCode: number
  /** Set for a key that produces text: sent as `keyDown` with it, else `rawKeyDown`. */
  readonly text?: string
}

const NAMED_KEYS: Readonly<Record<string, KeyDefinition>> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
}

const KEY_ALIASES: Readonly<Record<string, string>> = { Esc: 'Escape', Return: 'Enter', Del: 'Delete', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' }

/** The US-layout punctuation keys, by the character they type unshifted. */
const PUNCTUATION: Readonly<Record<string, readonly [string, number]>> = {
  '-': ['Minus', 189],
  '=': ['Equal', 187],
  ',': ['Comma', 188],
  '.': ['Period', 190],
  '/': ['Slash', 191],
  ';': ['Semicolon', 186],
  "'": ['Quote', 222],
  '[': ['BracketLeft', 219],
  ']': ['BracketRight', 221],
  '\\': ['Backslash', 220],
  '`': ['Backquote', 192],
}

interface Modifier {
  readonly name: string
  /** CDP's modifier bitmask: Alt 1, Control 2, Meta 4, Shift 8. */
  readonly bit: number
  readonly code: string
  readonly keyCode: number
}

const MODIFIERS: Readonly<Record<string, Modifier>> = {
  Alt: { name: 'Alt', bit: 1, code: 'AltLeft', keyCode: 18 },
  Control: { name: 'Control', bit: 2, code: 'ControlLeft', keyCode: 17 },
  Meta: { name: 'Meta', bit: 4, code: 'MetaLeft', keyCode: 91 },
  Shift: { name: 'Shift', bit: 8, code: 'ShiftLeft', keyCode: 16 },
}
const SHIFT = 8
const MODIFIER_ALIASES: Readonly<Record<string, string>> = { Ctrl: 'Control', Cmd: 'Meta', Command: 'Meta', Option: 'Alt' }

/**
 * On macOS the browser, not the page, turns keys into editing (AppKit's key
 * bindings), so a protocol key event edits only when it carries the command
 * by name — the table Playwright sends there. Elsewhere Blink's own bindings
 * act on the key and the commands are not sent. Not measured here: no macOS
 * host is part of this project's browser evidence yet.
 */
const MAC_COMMANDS: Readonly<Record<string, string>> = {
  Backspace: 'deleteBackward',
  Delete: 'deleteForward',
  Enter: 'insertNewline',
  Tab: 'insertTab',
  'Shift+Tab': 'insertBacktab',
  Escape: 'cancelOperation',
  ArrowUp: 'moveUp',
  ArrowDown: 'moveDown',
  ArrowLeft: 'moveLeft',
  ArrowRight: 'moveRight',
  Home: 'scrollToBeginningOfDocument',
  End: 'scrollToEndOfDocument',
  PageUp: 'scrollPageUp',
  PageDown: 'scrollPageDown',
  'Meta+a': 'selectAll',
}

interface Chord {
  readonly modifiers: readonly Modifier[]
  readonly key: KeyDefinition
}

/** `Control+A`, `Shift+Tab`, `a`, `+`, `Shift++`; `undefined` for a name not in the table. */
export function parseKey(spec: string): Chord | undefined {
  const parts = spec.split('+')
  // The `+` key itself splits to two empty parts: `+` is ['', ''], `Shift++` is ['Shift', '', '']; `Control+` names no key.
  let main: string | undefined
  if (parts.length >= 2 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') {
    parts.splice(parts.length - 2, 2)
    main = '+'
  } else {
    main = parts.pop()
  }
  if (main === undefined || main === '') return undefined
  const modifiers: Modifier[] = []
  for (const part of parts) {
    const modifier = MODIFIERS[MODIFIER_ALIASES[part] ?? part]
    if (modifier === undefined || modifiers.includes(modifier)) return undefined
    modifiers.push(modifier)
  }
  const key = keyOf(main)
  return key === undefined ? undefined : { modifiers, key }
}

function keyOf(name: string): KeyDefinition | undefined {
  const named = NAMED_KEYS[KEY_ALIASES[name] ?? name]
  if (named !== undefined) return named
  const characters = Array.from(name)
  if (characters.length !== 1 || name.charCodeAt(0) < 32) return undefined
  if (name === ' ') return NAMED_KEYS.Space
  if (/^[a-z]$/i.test(name)) return { key: name, code: `Key${name.toUpperCase()}`, keyCode: name.toUpperCase().charCodeAt(0), text: name }
  if (/^[0-9]$/.test(name)) return { key: name, code: `Digit${name}`, keyCode: name.charCodeAt(0), text: name }
  const punctuation = PUNCTUATION[name]
  if (punctuation !== undefined) return { key: name, code: punctuation[0], keyCode: punctuation[1], text: name }
  return { key: name, code: '', keyCode: 0, text: name }
}

async function press(session: PageSession, spec: string, ref: string | undefined, budget: CallBudget): Promise<string> {
  const chord = parseKey(spec)
  if (chord === undefined) {
    throw notActionable(
      `${JSON.stringify(spec)} is not a key this browser can press; use a name such as Enter, Tab, Escape, Backspace, Delete, ArrowDown, Home, PageDown or Space, a single character, or a chord such as Control+A or Shift+Tab`,
    )
  }
  let where = ''
  if (ref !== undefined) {
    const { entry } = await resolveRef(session, ref, budget)
    where = ` in ${describeRef(entry)}`
    await focus(session, entry, describeRef(entry), budget)
  }
  await dispatchKey(session, chord, budget)
  return `pressed ${spec}${where}`
}

/** Modifiers down in order, the key down and up, modifiers up in reverse: what a keyboard sends. */
async function dispatchKey(session: PageSession, chord: Chord, budget: CallBudget): Promise<void> {
  let mask = 0
  for (const modifier of chord.modifiers) {
    mask |= modifier.bit
    await session.send('Input.dispatchKeyEvent', keyEvent('rawKeyDown', { key: modifier.name, code: modifier.code, keyCode: modifier.keyCode }, mask), budget)
  }
  const shifted = (mask & SHIFT) !== 0
  const base = chord.key
  const key: KeyDefinition = shifted && /^[a-z]$/.test(base.key) ? { ...base, key: base.key.toUpperCase(), text: base.key.toUpperCase() } : base
  // Any modifier but Shift turns a character into a shortcut: no text (Control+A selects, it does not type an "a").
  const producesText = key.text !== undefined && (mask & ~SHIFT) === 0
  const down = keyEvent(producesText ? 'keyDown' : 'rawKeyDown', key, mask)
  if (producesText) Object.assign(down, { text: key.text, unmodifiedText: key.text })
  const command = process.platform === 'darwin' ? MAC_COMMANDS[[...chord.modifiers.map((modifier) => modifier.name), base.key].join('+')] : undefined
  if (command !== undefined) Object.assign(down, { commands: [command] })
  await session.send('Input.dispatchKeyEvent', down, budget)
  await session.send('Input.dispatchKeyEvent', keyEvent('keyUp', key, mask), budget)
  for (const modifier of chord.modifiers.toReversed()) {
    mask &= ~modifier.bit
    await session.send('Input.dispatchKeyEvent', keyEvent('keyUp', { key: modifier.name, code: modifier.code, keyCode: modifier.keyCode }, mask), budget)
  }
}

function keyEvent(type: string, key: KeyDefinition, modifiers: number): Record<string, unknown> {
  return { type, key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode, modifiers }
}

// ---------------------------------------------------------------------------
// Select

const MAX_LISTED_OPTIONS = 20

async function select(session: PageSession, ref: string, values: readonly string[], budget: CallBudget): Promise<string> {
  const { entry, objectId } = await resolveRef(session, ref, budget)
  const label = describeRef(entry)
  const outcome = record(await callFunction(session, objectId, SELECT_OPTIONS, [{ value: values }, { value: MAX_LISTED_OPTIONS }], budget))
  const error = text(outcome?.error)
  if (error === 'kind') throw notActionable(`${label} is not a <select>; click it, then click the option`)
  if (error === 'disabled') throw notActionable(`${label} is disabled`)
  if (error === 'single') throw notActionable(`${label} takes one value, not ${values.length}`)
  if (error === 'option-disabled') throw notActionable(`${label}'s option ${JSON.stringify(text(outcome?.want) ?? '')} is disabled`)
  if (error === 'missing') {
    const options = list(outcome?.options).filter((option): option is string => typeof option === 'string')
    const count = numberOf(outcome?.count) ?? options.length
    const more = count > options.length ? `, … (${count} in all)` : ''
    throw notActionable(`${label} has no option ${JSON.stringify(text(outcome?.want) ?? '')}; its options are: ${options.join(', ')}${more}`)
  }
  const chosen = list(outcome?.selected).filter((option): option is string => typeof option === 'string')
  return chosen.length === 0 ? `cleared the selection of ${label}` : `selected ${chosen.map((option) => JSON.stringify(option)).join(', ')} in ${label}`
}

/** Matches by value first, then by visible label, as Playwright does; sets `selected`, then fires what a person's choice fires. */
const SELECT_OPTIONS = `function (wanted, listed) {
  if (this.localName !== 'select') return { error: 'kind' }
  if (this.disabled) return { error: 'disabled' }
  const options = Array.from(this.options)
  const chosen = []
  for (const want of wanted) {
    const option = options.find((candidate) => candidate.value === want) || options.find((candidate) => candidate.label.trim() === want.trim())
    if (!option) {
      return {
        error: 'missing',
        want,
        options: options.slice(0, listed).map((candidate) => JSON.stringify(candidate.label) + (candidate.value !== candidate.label ? ' (value ' + JSON.stringify(candidate.value) + ')' : '')),
        count: options.length,
      }
    }
    if (option.disabled) return { error: 'option-disabled', want: option.label }
    chosen.push(option)
  }
  if (!this.multiple && chosen.length > 1) return { error: 'single' }
  for (const option of options) option.selected = chosen.includes(option)
  this.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  this.dispatchEvent(new Event('change', { bubbles: true }))
  return { selected: chosen.map((option) => option.label) }
}`
