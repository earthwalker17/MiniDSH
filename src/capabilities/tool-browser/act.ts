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
 * something inside it — or, once the element has been scrolled to the middle
 * of the viewport and tried again, the refusal names what is on top.
 *
 * Typing is real input too (`Input.insertText` after selecting the old
 * content), so a framework that tracks a field's value through its setter
 * sees a change; an assigned `.value` it would not. The exceptions are the
 * fields with a picker instead of text (date, time, colour, range), which
 * take their value as Playwright's `fill` gives it: see `SET_VALUE`. Typing
 * and selecting need a visible element, as a click does, but no hit test —
 * Playwright's `fill` and `selectOption` do not hit-test either.
 *
 * Coordinates are CSS pixels in the main frame's viewport, except for the hit
 * test (`hitTest`). Measured on Chrome 155: `DOM.getContentQuads` of a node
 * inside a same-process iframe already answers in those coordinates (the
 * frame's offset applied), and `DOM.getNodeForLocation` at that point (moved
 * into document coordinates) answers the node inside the frame with that
 * frame's id — so one point serves both, and the hit test climbs from the hit
 * frame to the target's through `DOM.getFrameOwner`.
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
  let point = await stablePoint(session, entry, label, budget)
  // Hover is allowed on a disabled element (its tooltip is a thing to check); a click is not.
  if (click && (await callFunction(session, objectId, IS_DISABLED, [], budget)) === true) throw notActionable(`${label} is disabled`)
  let refusal = await hitTest(session, entry, objectId, point, label, budget)
  if (refusal !== undefined) {
    // `scrollIntoViewIfNeeded` leaves an element that is already in view where
    // it is — under a fixed header, say, which then takes the click. In the
    // middle of the viewport only a cover over the whole page still covers it
    // (Playwright likewise retries at other scroll positions before giving up).
    await callFunction(session, objectId, SCROLL_TO_CENTRE, [], budget)
    point = await stablePoint(session, entry, label, budget)
    refusal = await hitTest(session, entry, objectId, point, label, budget)
    if (refusal !== undefined) throw notActionable(refusal)
  }
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

const SCROLL_TO_CENTRE = `function () {
  const element = this.nodeType === 1 ? this : this.parentElement
  if (element) element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
}`

/**
 * The visibility rule every action on an element shares: scrolled into view,
 * it has a box with an area inside the viewport. Returns that box's centre.
 */
async function visiblePoint(session: PageSession, entry: RefEntry, label: string, budget: CallBudget): Promise<Point> {
  const hidden = notActionable(`${label} is not visible (no box on screen to act on)`)
  try {
    await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: entry.backendNodeId }, budget)
  } catch (error) {
    // "Node does not have a layout object": display:none, or detached.
    if (isProtocolError(error)) throw hidden
    throw error
  }
  const point = await centre(session, entry.backendNodeId, budget)
  if (point === undefined) throw hidden
  return point
}

/** Scrolls the element into view and returns its centre once it holds still: measured, two animation frames, measured again, up to three times. */
async function stablePoint(session: PageSession, entry: RefEntry, label: string, budget: CallBudget): Promise<Point> {
  const hidden = (): BrowserError => notActionable(`${label} is not visible (no box on screen to act on)`)
  let point = await visiblePoint(session, entry, label, budget)
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
 * the target's frame through each frame's owner element first. Answers the
 * refusal, or `undefined` when the pointer would land.
 *
 * `DOM.getNodeForLocation` takes DOCUMENT coordinates, unlike the quads and
 * the mouse events: measured, with the page scrolled 1200 px a button's
 * viewport centre answers "No node found" and the same point plus the scroll
 * answers the button. The offset is the layout viewport's, the frame's own
 * scroll; the visual viewport differs from it only under a pinch zoom, which
 * this browser's desktop-mode page cannot get (measured: a pinch gesture and a
 * page scale of 2 both left the two offsets equal).
 *
 * The hit test honours `pointer-events: none` (the protocol's default), as a
 * real click does: measured, a full-page click-through overlay (a toast
 * container) is what the hit test answers with the flag set, while the click
 * itself goes through it to the button.
 */
async function hitTest(session: PageSession, entry: RefEntry, objectId: string, point: Point, label: string, budget: CallBudget): Promise<string | undefined> {
  const metrics = await session.send<{ cssLayoutViewport?: unknown }>('Page.getLayoutMetrics', {}, budget)
  const layout = record(metrics.cssLayoutViewport)
  const x = Math.floor(point.x + (numberOf(layout?.pageX) ?? 0))
  const y = Math.floor(point.y + (numberOf(layout?.pageY) ?? 0))
  const nothing = `${label} cannot be reached: nothing in the page is at its centre (${point.x}, ${point.y} in the viewport)`
  let hit: { backendNodeId?: unknown; frameId?: unknown }
  try {
    hit = await session.send('DOM.getNodeForLocation', { x, y, includeUserAgentShadowDOM: true }, budget)
  } catch (error) {
    if (isProtocolError(error)) return nothing
    throw error
  }
  const hitNode = numberOf(hit.backendNodeId)
  if (hitNode === undefined) return nothing
  if (hitNode === entry.backendNodeId) return undefined

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
  if (node === entry.backendNodeId) return undefined
  if (node !== undefined) {
    const inside = await resolveNode(session, node, budget)
    if (inside !== undefined && (await callFunction(session, objectId, CONTAINS, [{ objectId: inside }], budget)) === true) return undefined
  }
  const covering = await resolveNode(session, hitNode, budget)
  const what = covering === undefined ? 'another element' : await callFunction(session, covering, DESCRIBE, [], budget)
  return `${label} is covered by ${typeof what === 'string' ? what : 'another element'}, which would take the click instead; close or move it first`
}

const CONTAINS = `function (hit) {
  for (let node = hit; node; node = node.parentNode || (node.nodeType === 11 ? node.host : null)) {
    if (node === this) return true
    if (node.localName === 'label' && node.control === this) return true
  }
  return false
}`

/** An element as a person would point at it: `<div id="x" class="a b"> "its first words"`; a text node by its parent. */
export const DESCRIBE = `function () {
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
  if (kind !== 'field' && kind !== 'editable' && kind !== 'value') throw notActionable(`${label} does not take text: type into an input, a textarea or an editable element`)
  await visiblePoint(session, entry, label, budget)
  await focus(session, entry, label, budget)
  let done: string
  if (kind === 'value') {
    const outcome = record(await callFunction(session, objectId, SET_VALUE, [{ value }], budget))
    if (outcome?.taken !== true) throw notActionable(`${label} did not take ${JSON.stringify(value)}: it expects ${expectedFormat(outcome)}`)
    done = value.trim() === '' ? `cleared ${label}` : `set ${label} to ${JSON.stringify(text(outcome.value) ?? value)}`
  } else {
    await callFunction(session, objectId, SELECT_CONTENT, [], budget)
    // Measured: an empty insertText deletes the selection and fires `input`,
    // on every platform alike — a Delete key would need macOS's editing commands.
    await session.send('Input.insertText', { text: value }, budget)
    const count = Array.from(value).length
    done = value === '' ? `cleared ${label}` : `typed ${count} character${count === 1 ? '' : 's'} into ${label}`
  }
  if (!submit) return done
  await dispatchKey(session, { modifiers: [], key: NAMED_KEYS.Enter! }, budget)
  return `${done} and pressed Enter`
}

/** `value`: a field with a picker rather than text, set whole (`SET_VALUE`). */
const FIELD_KIND = `function () {
  const tag = this.localName
  if (tag === 'input' || tag === 'textarea') {
    if (tag === 'input' && ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'hidden'].includes(this.type)) return 'other'
    if (this.disabled) return 'disabled'
    if (this.readOnly) return 'readonly'
    return tag === 'input' && ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(this.type) ? 'value' : 'field'
  }
  return this.isContentEditable ? 'editable' : 'other'
}`

/**
 * Playwright's `fill` for the picker fields: measured, `Input.insertText`
 * into a date or time input changes nothing (its text is a row of spin
 * fields, not an editor). So the value is set whole, through the PROTOTYPE's
 * setter — a framework that tracks the value through an instance setter (as
 * React does) must not record it as its own, or the input event that follows
 * reads as no change — then `input` and `change` fire as a person's choice
 * fires them. A value the field sanitises away did not take: the old value is
 * put back without events and the refusal names the format. Measured on
 * Chrome 155, each kind sanitises its own way, so each is checked its own way:
 * a date, time, month or week it cannot parse becomes empty (and a
 * datetime-local it can parse is rewritten to its normal form, `2024-01-15
 * 13:45` to `2024-01-15T13:45`); a range value is clamped into min..max
 * (`50` in 0..10 becomes `10`, `5.0` becomes `5`); a colour is any CSS colour
 * (`red` becomes `#ff0000`) and anything else `#000000`.
 */
const SET_VALUE = `function (wanted) {
  const value = wanted.trim()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  const before = this.value
  setter.call(this, value)
  const taken =
    this.type === 'range' ? value !== '' && Number(this.value) === Number(value)
    : this.type === 'color' ? value !== '' && CSS.supports('color', value)
    : (this.value === '') === (value === '')
  if (!taken) {
    setter.call(this, before)
    return { taken: false, type: this.type, min: this.min, max: this.max, step: this.step }
  }
  this.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  this.dispatchEvent(new Event('change', { bubbles: true }))
  return { taken: true, value: this.value }
}`

/** What a picker field takes, for the refusal of a value it did not. */
function expectedFormat(outcome: Record<string, unknown> | undefined): string {
  const type = text(outcome?.type) ?? ''
  if (type === 'range') {
    const [min, max, step] = [text(outcome?.min) || '0', text(outcome?.max) || '100', text(outcome?.step)]
    return `a number from ${min} to ${max}${step !== undefined && step !== '' && step !== 'any' && step !== '1' ? ` in steps of ${step}` : ''}`
  }
  return VALUE_FORMATS[type] ?? 'a value in its own format'
}

const VALUE_FORMATS: Readonly<Record<string, string>> = {
  date: 'a date as YYYY-MM-DD, such as 2024-01-15',
  time: 'a time as HH:MM or HH:MM:SS on a 24-hour clock, such as 13:45',
  'datetime-local': 'a date and time as YYYY-MM-DDTHH:MM, such as 2024-01-15T13:45',
  month: 'a month as YYYY-MM, such as 2024-01',
  week: 'a week as YYYY-Www, such as 2024-W03',
  color: 'a colour as #rrggbb (such as #ff0000) or by CSS name',
}

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
  // No Tab or Shift+Tab: moving focus is Blink's own default action on the
  // key, and naming `insertTab` as the command replaced it — on macos-latest
  // (2026-10-19) Tab left focus where it was.
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
  await visiblePoint(session, entry, label, budget)
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
  const labels = (raw: unknown): string => list(raw).flatMap((option) => (typeof option === 'string' ? [JSON.stringify(option)] : [])).join(', ')
  const chosen = labels(outcome?.chosen)
  const selection = labels(outcome?.selected)
  // HTML's selectedness rule gives a single select with nothing chosen its first option back.
  if (chosen === '') return selection === '' ? `cleared the selection of ${label}` : `cleared the selection of ${label}; it now shows ${selection}`
  return outcome?.multiple === true ? `selected ${chosen} in ${label}; its selection is now ${selection}` : `selected ${chosen} in ${label}`
}

/**
 * Matches by value first, then by visible label, as Playwright does; sets
 * `selected`, then fires what a person's choice fires. In a multiple select
 * the options are ADDED to what is selected, as a person's ctrl-click adds
 * them, and the account names the whole selection after; no options clears it.
 */
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
  if (this.multiple && chosen.length > 0) for (const option of chosen) option.selected = true
  else for (const option of options) option.selected = chosen.includes(option)
  this.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  this.dispatchEvent(new Event('change', { bubbles: true }))
  return { chosen: chosen.map((option) => option.label), selected: Array.from(this.selectedOptions, (option) => option.label), multiple: this.multiple }
}`
