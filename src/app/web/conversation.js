// @ts-check
/**
 * The conversation model: the durable events of one session window folded
 * into the blocks a person reads, without the DOM.
 *
 * A browser that drew one row per event showed the log, not the work. This
 * groups it the way a reader thinks about it: a person's message, the process
 * that followed it (calls, thoughts, route notes), the reply, how the turn
 * ended. The grouping is PRESENTATION over the log in seq order, never a fold
 * of the surface (ARCHITECTURE §8): nothing here decides what the model saw,
 * and every join is by an id the log records (`callId`, an approval's `id`, a
 * job's `jobId`, a compaction's `startSeq`), never by adjacency (§4).
 *
 * Four rules keep it honest:
 *
 * - **Visibility comes from `rows.js`.** An event is shown iff `describeRow`
 *   gives it a row — the gate `rows.test.ts` holds against the terminal's
 *   projection. This file decides only WHERE a visible event goes, and the gate
 *   folds each sample here to prove it lands in exactly one place.
 * - **Authority stays in sight.** A switch of mode, policy, acceptance, preset
 *   or base route, every grant and revoke, and every decision is a top-level
 *   `system` block: never inside a group a finished turn collapses. So is a
 *   turn that failed (its `tail`).
 * - **Pending is the view's to say.** The model records what the log says; a
 *   call with no result is "running" only where `cards.js` reads a live view
 *   that says so (a page cannot tell a call in flight from one whose writer
 *   died, `frames.ts`).
 * - **The live path only grows.** `step` returns ops that append a block, add
 *   an item to the open group or update one in place. An older page goes
 *   through `prepend`, which folds that slice on its own and joins it at the
 *   boundary: the cold path, where an item or a compaction bracket MOVES to
 *   the place its creating event names. Nothing is rebuilt (ARCHITECTURE §8,
 *   the S10 change shapes); `fold(all)` and `fold(tail) + prepend(head)` land
 *   on the same blocks, and `conversation.test.ts` holds them to it.
 *
 * Plain JS shipped to the browser with no build step: no runtime imports but
 * `rows.js`; the type imports are JSDoc and erase.
 */
import { describeRow, messageText } from './rows.js'

/** @typedef {import('../../core/session/types.ts').EventEnvelope} EventEnvelope */
/** @typedef {import('../../core/llm/types.ts').ContentBlock} ContentBlock */
/** @typedef {import('../../core/llm/types.ts').Message} Message */
/** @typedef {import('./rows.js').Row} Row */

/**
 * A call the model made, with everything the log joins to it by `callId`.
 * @typedef {{
 *   kind: 'tool', key: string, callId: string, groupKey: string,
 *   name?: string, args?: string, seqs: number[], time: number,
 *   called: boolean, dispatched: boolean,
 *   result?: { seq: number, time: number, text: string, images: ContentBlock[], isError: boolean, error?: { name: string, code: string } },
 *   effects: Record<string, any>[],
 *   asked: string[],
 *   subagent?: { start?: Record<string, any>, end?: Record<string, any> },
 *   job?: { jobId: string, start?: Record<string, any>, end?: Record<string, any> },
 * }} ToolItem
 */
/** @typedef {{ kind: 'thought', key: string, groupKey: string, text: string, seqs: number[] }} ThoughtItem */
/** @typedef {{ kind: 'note', key: string, groupKey: string, row: Row, type: string, data: Record<string, any>, seqs: number[] }} NoteItem */
/** @typedef {ToolItem | ThoughtItem | NoteItem} Item */

/** @typedef {{ kind: 'opening', key: string, rows: { row: Row, type: string }[], resumed: boolean, seqs: number[], time: number }} OpeningBlock */
/** @typedef {{ kind: 'process', key: string, items: Item[], closed: boolean, seqs: number[], time: number }} ProcessBlock */
/** @typedef {{ kind: 'compaction', key: string, startSeq: number, start?: Record<string, any>, applied?: Record<string, any>, end?: Record<string, any>, seqs: number[], time: number }} CompactionBlock */
/**
 * @typedef {OpeningBlock
 *   | ProcessBlock
 *   | CompactionBlock
 *   | { kind: 'bubble', key: string, text: string, images: ContentBlock[], messageId: string, seqs: number[], time: number }
 *   | { kind: 'context', key: string, row: Row, plugin: string, form?: string, text: string, replace: boolean, seqs: number[], time: number }
 *   | { kind: 'reply', key: string, text: string, model?: string, interrupted: boolean, seqs: number[], time: number }
 *   | { kind: 'system', key: string, row: Row, type: string, data: Record<string, any>, seqs: number[], time: number }
 *   | { kind: 'tail', key: string, turn: number, reason: Record<string, any>, seqs: number[], time: number }
 *   | { kind: 'note', key: string, row: Row, type: string, data: Record<string, any>, seqs: number[], time: number }
 *   | { kind: 'fork', key: string, seqs: number[], time: number }} Block
 */

/**
 * What the DOM must do. `append`/`prepend` add whole blocks; `update` names a
 * block (and the item in it that changed, or was `added`); `remove` takes a
 * block away (only a prepend does, when an older page reclaims what the newer
 * window had to show early); `live` carries the streaming preview, which no
 * op ever stores as a block.
 * @typedef {{ op: 'append', block: Block }
 *   | { op: 'prepend', blocks: Block[] }
 *   | { op: 'update', key: string, item?: string, added?: boolean }
 *   | { op: 'remove', key: string }
 *   | { op: 'live', live: Live }
 *   | { op: 'live-clear' }} Op
 */

/**
 * The streamed preview of one attempt of one step. Trace tier: it is never
 * stored, and the durable `assistant/message` (or the turn's end) replaces it.
 * @typedef {{ turn: number, step: number, attempt: number, text: string, reasoning: string }} Live
 */

/**
 * @typedef {{
 *   blocks: Block[],
 *   blocksByKey: Map<string, Block>,
 *   items: Map<string, ToolItem>,
 *   asked: Map<string, { callId?: string, seq: number, data: Record<string, any> }>,
 *   decided: Map<string, Record<string, any>>,
 *   jobs: Map<string, string | undefined>,
 *   compactions: Map<number, CompactionBlock>,
 *   turnStarts: Map<number, number>,
 *   openGroup: ProcessBlock | undefined,
 *   inTurn: boolean,
 *   openingContext: boolean,
 *   turnsSeen: number,
 *   live: Live | undefined,
 *   seedLength: number,
 *   forkMarked: boolean,
 *   firstSeq: number,
 *   lastSeq: number,
 *   nextKey: number,
 * }} Model
 */

/**
 * What a prepend lends the older slice's fold: the NEWER window, whose items
 * and compaction brackets an older creating event reclaims (`moved`), and the
 * newer blocks that this changed.
 * @typedef {{ newer: Model, touched: Set<string>, removed: Set<string>, updated: Set<string> }} Adopt
 */

/**
 * @param {{ seedLength?: number }} [options] `seedLength`: the fork boundary from the session header — events below it are inherited.
 * @returns {Model}
 */
export function createConversation(options = {}) {
  return {
    blocks: [],
    blocksByKey: new Map(),
    items: new Map(),
    asked: new Map(),
    decided: new Map(),
    jobs: new Map(),
    compactions: new Map(),
    turnStarts: new Map(),
    openGroup: undefined,
    inTurn: false,
    openingContext: true,
    turnsSeen: 0,
    live: undefined,
    seedLength: options.seedLength ?? 0,
    forkMarked: false,
    firstSeq: Number.POSITIVE_INFINITY,
    lastSeq: -1,
    nextKey: 0,
  }
}

/**
 * Every event of a window, in seq order, into a fresh model. The live path's
 * `step` over the same events (plus their trace) must land on the same blocks
 * once the stream is quiet — `conversation.test.ts` holds the two together.
 * @param {readonly EventEnvelope[]} events
 * @param {{ seedLength?: number }} [options]
 */
export function fold(events, options) {
  const model = createConversation(options)
  for (const event of events) step(model, event)
  return model
}

/** Kinds that occur only inside a turn (`core/loop/driver.ts`). */
const IN_TURN = new Set(['step/start', 'step/end', 'request/header', 'assistant/chunk', 'assistant/message', 'tool/call', 'tool/dispatch', 'tool/result'])

/** @param {unknown} value @returns {Record<string, any>} */
const record = (value) => (typeof value === 'object' && value !== null ? /** @type {Record<string, any>} */ (value) : {})

/**
 * One event, live or replayed, appended to the model. Returns what changed.
 * @param {Model} model
 * @param {EventEnvelope} event
 * @returns {Op[]}
 */
export function step(model, event) {
  /** @type {Op[]} */
  const ops = []
  if (event.type !== 'assistant/chunk') {
    model.firstSeq = Math.min(model.firstSeq, event.seq)
    model.lastSeq = Math.max(model.lastSeq, event.seq)
    markFork(model, event, ops)
  }
  apply(model, event, ops, undefined)
  return ops
}

/**
 * The fork boundary: a seeded session inherited every event below
 * `seedLength` from its source, so a reader needs to see where its own began.
 * Only between something inherited and something new: a window that starts
 * past the boundary has nothing above the marker yet, and a prepend adds it.
 * @param {Model} model @param {EventEnvelope} event @param {Op[]} ops
 */
function markFork(model, event, ops) {
  if (model.forkMarked || model.seedLength <= 0 || event.seq < model.seedLength || model.firstSeq >= model.seedLength) return
  model.forkMarked = true
  closeGroup(model)
  pushBlock(model, { kind: 'fork', key: `fork:${model.seedLength}`, seqs: [], time: event.time }, ops)
}

/**
 * The one switch on event kinds. Each `case` here must have a sample in
 * `rows.test.ts` (the gate reads them out of this file): structure kinds with
 * no row (`turn/start`, `tool/dispatch`, the trace) shape blocks; every kind
 * with a row lands somewhere, and any kind not named here falls to `default`,
 * which still shows its row — an unknown visible event is never dropped.
 * @param {Model} model @param {EventEnvelope} event @param {Op[]} ops @param {Adopt | undefined} adopt
 */
function apply(model, event, ops, adopt) {
  const data = record(event.data)
  // A page is message-aligned (`core/session/page.ts`), so a window often
  // starts inside a turn whose `turn/start` is on an older page: these kinds
  // only ever occur inside one, which is all the placement rules need to know.
  if (!model.inTurn && (IN_TURN.has(event.type) || (event.type === 'user/message' && event.surfaceOp?.op !== 'replace'))) {
    model.inTurn = true
    model.openingContext = false
    model.turnsSeen += 1
  }
  switch (event.type) {
    case 'session/lifecycle': {
      // A new lifecycle (a resume, a fork's own first one): its stamps are an
      // opening again, until a turn starts.
      model.openingContext = true
      return
    }
    case 'turn/start': {
      closeGroup(model)
      model.inTurn = true
      model.openingContext = false
      model.turnsSeen += 1
      model.turnStarts.set(Number(data.turn), event.time)
      if (model.live) clearLive(model, ops)
      return
    }
    case 'assistant/chunk': {
      onChunk(model, data, ops)
      return
    }
    case 'user/message': {
      const message = /** @type {Message} */ (data.message)
      const row = describeRow(event)
      if (!row) return
      closeGroup(model)
      const content = message.content ?? []
      if (message.source.kind === 'user') {
        const images = content.filter((block) => block.type === 'image')
        pushBlock(model, { kind: 'bubble', key: `msg:${message.id}`, text: messageText({ content: content.filter((block) => block.type === 'text') }), images, messageId: String(message.id), seqs: [event.seq], time: event.time }, ops)
        return
      }
      const source = /** @type {{ kind: string, plugin?: string, form?: string }} */ (message.source)
      pushBlock(
        model,
        {
          kind: 'context',
          key: `seq:${event.seq}`,
          row,
          plugin: source.plugin ?? source.kind,
          ...(source.form === undefined ? {} : { form: source.form }),
          text: messageText(message),
          replace: event.surfaceOp?.op === 'replace',
          seqs: [event.seq],
          time: event.time,
        },
        ops,
      )
      return
    }
    case 'assistant/message': {
      onAssistantMessage(model, event, data, ops, adopt)
      return
    }
    case 'tool/call': {
      const item = toolItem(model, String(data.callId), event, ops, adopt)
      item.called = true
      item.name = String(data.name)
      item.args = String(data.arguments ?? '')
      touch(model, item, event, ops, adopt)
      return
    }
    case 'tool/dispatch': {
      // No row: a dispatch changes the card's status and nothing else, so it
      // is not one of the item's visible seqs.
      const item = joinedItem(model, data.callId, adopt) ?? toolItem(model, String(data.callId), event, ops, adopt)
      item.dispatched = true
      changed(model, item, ops, adopt)
      return
    }
    case 'tool/result': {
      const item = joinedItem(model, data.callId, adopt) ?? toolItem(model, String(data.callId), event, ops, adopt)
      const message = /** @type {Message} */ (data.message)
      const content = message.content ?? []
      item.result = {
        seq: event.seq,
        time: event.time,
        text: resultText(content),
        images: imagesIn(content),
        isError: data.error !== undefined || content.some((block) => block.type === 'tool-result' && block.isError === true),
        ...(data.error === undefined ? {} : { error: /** @type {{ name: string, code: string }} */ (data.error) }),
      }
      touch(model, item, event, ops, adopt)
      return
    }
    case 'effect/recorded': {
      joinOrNote(model, event, data, joinedItem(model, data.callId, adopt), ops, adopt)
      return
    }
    case 'approval/asked': {
      model.asked.set(String(data.id), { ...(data.callId === undefined ? {} : { callId: String(data.callId) }), seq: event.seq, data })
      joinOrNote(model, event, data, joinedItem(model, data.callId, adopt), ops, adopt)
      return
    }
    case 'approval/decided': {
      // A decision is the person's (or a pin's, or a grant's) and stays in
      // sight, outside any group; the card it answers learns of it by id.
      pushSystem(model, event, ops)
      model.decided.set(String(data.id), data)
      const asked = model.asked.get(String(data.id)) ?? adopt?.newer.asked.get(String(data.id))
      const item = joinedItem(model, asked?.callId, adopt)
      if (item) changed(model, item, ops, adopt)
      return
    }
    case 'approval/grant': {
      pushSystem(model, event, ops)
      return
    }
    case 'approval/policy':
    case 'sandbox/mode':
    case 'sandbox/acceptance':
    case 'agent/options': {
      const reason = String(data.reason)
      if (reason === 'initial' || reason === 'resume' || reason === 'delegation') placeOpening(model, event, ops)
      else pushSystem(model, event, ops)
      return
    }
    case 'authority/preset': {
      // An intent written before the switches it names: part of the opening
      // when it precedes a lifecycle's first turn, a decision in sight after.
      if (model.openingContext && !model.inTurn) placeOpening(model, event, ops)
      else pushSystem(model, event, ops)
      return
    }
    case 'agent/narrowing': {
      if (model.openingContext && !model.inTurn) placeOpening(model, event, ops)
      else placeNote(model, event, ops)
      return
    }
    case 'request/context': {
      // The route a step ran on is written only when it changes: a divider
      // in the conversation, never inside a group (the first one sits before
      // the person's message, which a group would make read as work done).
      closeGroup(model)
      pushNote(model, event, ops)
      return
    }
    case 'compaction/start':
    case 'compaction/applied':
    case 'compaction/end': {
      const startSeq = event.type === 'compaction/start' ? event.seq : Number(data.startSeq)
      const block = compactionBlock(model, startSeq, event, ops, adopt)
      if (event.type === 'compaction/start') block.start = data
      else if (event.type === 'compaction/end') block.end = data
      else block.applied = data
      if (describeRow(event)) block.seqs.push(event.seq)
      if (adopt && adopt.newer.compactions.get(startSeq) === block) adopt.updated.add(block.key)
      else ops.push({ op: 'update', key: block.key })
      return
    }
    case 'subagent/start':
    case 'subagent/end': {
      joinOrNote(model, event, data, joinedItem(model, data.callId, adopt), ops, adopt)
      return
    }
    case 'job/start': {
      const jobId = String(data.jobId)
      model.jobs.set(jobId, data.callId === undefined ? undefined : String(data.callId))
      joinOrNote(model, event, data, joinedItem(model, data.callId, adopt), ops, adopt)
      return
    }
    case 'job/end': {
      const jobId = String(data.jobId)
      joinOrNote(model, event, data, joinedItem(model, model.jobs.has(jobId) ? model.jobs.get(jobId) : adopt?.newer.jobs.get(jobId), adopt), ops, adopt)
      return
    }
    case 'turn/end': {
      closeGroup(model)
      model.inTurn = false
      if (model.live) clearLive(model, ops)
      pushBlock(model, { kind: 'tail', key: `seq:${event.seq}`, turn: Number(data.turn), reason: record(data.reason), seqs: describeRow(event) ? [event.seq] : [], time: event.time }, ops)
      return
    }
    default: {
      if (describeRow(event)) placeNote(model, event, ops)
    }
  }
}

/** @param {Model} model @param {Record<string, any>} data @param {Op[]} ops */
function onChunk(model, data, ops) {
  const chunk = record(data.chunk)
  if (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta') return
  if (typeof chunk.text !== 'string') return
  const turn = Number(data.turn)
  const stepNo = Number(data.step)
  const attempt = Number(data.attempt)
  let live = model.live
  // A retried attempt replaces the abandoned one's text instead of appending
  // to it: what the person reads is one attempt, the one still streaming.
  if (!live || live.turn !== turn || live.step !== stepNo || live.attempt !== attempt) {
    live = { turn, step: stepNo, attempt, text: '', reasoning: '' }
    model.live = live
  }
  if (chunk.type === 'text-delta') live.text += chunk.text
  else live.reasoning += chunk.text
  ops.push({ op: 'live', live })
}

/** @param {Model} model @param {Op[]} ops */
function clearLive(model, ops) {
  model.live = undefined
  ops.push({ op: 'live-clear' })
}

/**
 * One assistant message is up to three things, in content order: thoughts
 * (process), its text (the reply, which closes the process before it), and
 * the calls it made (process again, after the reply).
 * @param {Model} model @param {EventEnvelope} event @param {Record<string, any>} data @param {Op[]} ops @param {Adopt | undefined} adopt
 */
function onAssistantMessage(model, event, data, ops, adopt) {
  if (model.live && model.live.turn === Number(data.turn) && model.live.step === Number(data.step)) clearLive(model, ops)
  const message = /** @type {Message} */ (data.message)
  const content = message.content ?? []
  let thoughts = 0
  for (const block of content) {
    if (block.type !== 'reasoning' || block.text.trim().length === 0) continue
    const group = ensureGroup(model, event, ops)
    addItem(model, group, { kind: 'thought', key: `thought:${event.seq}:${thoughts++}`, groupKey: group.key, text: block.text, seqs: [] }, ops)
  }
  const row = describeRow(event)
  if (row) {
    closeGroup(model)
    const source = /** @type {{ kind: string, model?: string }} */ (message.source)
    pushBlock(
      model,
      {
        kind: 'reply',
        key: `msg:${message.id}`,
        text: messageText({ content: content.filter((block) => block.type === 'text') }),
        ...(source.kind === 'assistant' && source.model ? { model: source.model } : {}),
        interrupted: data.interrupted === true,
        seqs: [event.seq],
        time: event.time,
      },
      ops,
    )
  }
  for (const block of content) {
    if (block.type !== 'tool-call') continue
    const item = toolItem(model, String(block.id), event, ops, adopt)
    item.name ??= block.name
    item.args ??= block.arguments
  }
}

/**
 * The item for a call, created where the call first appears. In a prepend, an
 * item the newer window had to create early (its result arrived on the later
 * page) MOVES here, to where the older page says the call was made.
 * @param {Model} model @param {string} callId @param {EventEnvelope} event @param {Op[]} ops @param {Adopt | undefined} adopt
 * @returns {ToolItem}
 */
function toolItem(model, callId, event, ops, adopt) {
  const own = model.items.get(callId)
  if (own) return own
  const group = ensureGroup(model, event, ops)
  const early = adopt?.newer.items.get(callId)
  if (adopt && early) {
    const from = adopt.newer.blocksByKey.get(early.groupKey)
    if (from && from.kind === 'process') {
      from.items.splice(from.items.indexOf(early), 1)
      adopt.touched.add(from.key)
    }
    adopt.newer.items.delete(callId)
    early.groupKey = group.key
    model.items.set(callId, early)
    group.items.push(early)
    return early
  }
  /** @type {ToolItem} */
  const item = { kind: 'tool', key: `call:${callId}`, callId, groupKey: group.key, seqs: [], time: event.time, called: false, dispatched: false, effects: [], asked: [] }
  model.items.set(callId, item)
  addItem(model, group, item, ops)
  return item
}

/**
 * The item an event names, if either window holds it: a join never creates
 * (a result does, through `toolItem`, when its call is on an older page).
 * @param {Model} model @param {unknown} callId @param {Adopt | undefined} adopt
 * @returns {ToolItem | undefined}
 */
function joinedItem(model, callId, adopt) {
  if (callId === undefined || callId === null) return undefined
  const id = String(callId)
  return model.items.get(id) ?? adopt?.newer.items.get(id)
}

/** Kinds that join a call's card by an id; until it is in the window, one shows as a note. */
const JOINS = new Set(['effect/recorded', 'approval/asked', 'subagent/start', 'subagent/end', 'job/start', 'job/end'])

/**
 * A joining fact onto its card. Not a `switch`: the parity gate reads every
 * `case` as an event kind, and these are `apply`'s.
 * @param {ToolItem} item @param {string} type @param {Record<string, any>} data
 */
function attach(item, type, data) {
  if (type === 'effect/recorded') item.effects.push(data)
  else if (type === 'approval/asked') item.asked.push(String(data.id))
  else if (type === 'subagent/start') item.subagent = { ...item.subagent, start: data }
  else if (type === 'subagent/end') item.subagent = { ...item.subagent, end: data }
  else if (type === 'job/start') item.job = { ...item.job, jobId: String(data.jobId), start: data }
  else if (type === 'job/end') item.job = { ...item.job, jobId: String(data.jobId), end: data }
}

/** @param {Model} model @param {EventEnvelope} event @param {Record<string, any>} data @param {ToolItem | undefined} item @param {Op[]} ops @param {Adopt | undefined} adopt */
function joinOrNote(model, event, data, item, ops, adopt) {
  if (!item) {
    placeNote(model, event, ops)
    return
  }
  attach(item, event.type, data)
  touch(model, item, event, ops, adopt)
}

/** @param {Model} model @param {ToolItem} item @param {EventEnvelope} event @param {Op[]} ops @param {Adopt | undefined} adopt */
function touch(model, item, event, ops, adopt) {
  if (describeRow(event)) item.seqs.push(event.seq)
  changed(model, item, ops, adopt)
}

/** @param {Model} model @param {ToolItem} item @param {Op[]} ops @param {Adopt | undefined} adopt */
function changed(model, item, ops, adopt) {
  if (adopt && adopt.newer.items.get(item.callId) === item) {
    // Still in the NEWER window (its call is on a page not loaded yet): the
    // prepend reports it once, after the merge.
    adopt.updated.add(item.key)
    return
  }
  const group = model.blocksByKey.get(item.groupKey)
  if (group) ops.push({ op: 'update', key: group.key, item: item.key })
}

/** @param {Model} model @param {EventEnvelope} event @param {Op[]} ops @returns {ProcessBlock} */
function ensureGroup(model, event, ops) {
  if (model.openGroup && !model.openGroup.closed) return model.openGroup
  /** @type {ProcessBlock} */
  const group = { kind: 'process', key: `group:${event.seq}:${model.nextKey++}`, items: [], closed: false, seqs: [], time: event.time }
  model.openGroup = group
  pushBlock(model, group, ops)
  return group
}

/** @param {Model} model */
function closeGroup(model) {
  if (model.openGroup) model.openGroup.closed = true
  model.openGroup = undefined
}

/** @param {Model} _model @param {ProcessBlock} group @param {Item} item @param {Op[]} ops */
function addItem(_model, group, item, ops) {
  group.items.push(item)
  ops.push({ op: 'update', key: group.key, item: item.key, added: true })
}

/** @param {Model} model @param {Block} block @param {Op[]} ops */
function pushBlock(model, block, ops) {
  model.blocks.push(block)
  model.blocksByKey.set(block.key, block)
  ops.push({ op: 'append', block })
}

/** A visible note: inside the open process while a turn runs, else on its own. @param {Model} model @param {EventEnvelope} event @param {Op[]} ops */
function placeNote(model, event, ops) {
  const row = describeRow(event)
  if (!row) return
  if (model.inTurn) {
    const group = ensureGroup(model, event, ops)
    addItem(model, group, { kind: 'note', key: `seq:${event.seq}`, groupKey: group.key, row, type: event.type, data: record(event.data), seqs: [event.seq] }, ops)
    return
  }
  closeGroup(model)
  pushNote(model, event, ops)
}

/** A visible note as a block of its own. @param {Model} model @param {EventEnvelope} event @param {Op[]} ops */
function pushNote(model, event, ops) {
  const row = describeRow(event)
  if (!row) return
  pushBlock(model, { kind: 'note', key: `seq:${event.seq}`, row, type: event.type, data: record(event.data), seqs: [event.seq], time: event.time }, ops)
}

/** @param {Model} model @param {EventEnvelope} event @param {Op[]} ops */
function pushSystem(model, event, ops) {
  const row = describeRow(event)
  if (!row) return
  closeGroup(model)
  pushBlock(model, { kind: 'system', key: `seq:${event.seq}`, row, type: event.type, data: record(event.data), seqs: [event.seq], time: event.time }, ops)
}

/**
 * A lifecycle's opening stamps read as one collapsed line, not five: the
 * authority, the narrowing, the route, as the session opened (or resumed).
 * @param {Model} model @param {EventEnvelope} event @param {Op[]} ops
 */
function placeOpening(model, event, ops) {
  const row = describeRow(event)
  // The opening base route has no row (the header shows it): nothing to add.
  if (!row) return
  const last = model.blocks.at(-1)
  if (last && last.kind === 'opening') {
    last.rows.push({ row, type: event.type })
    last.seqs.push(event.seq)
    ops.push({ op: 'update', key: last.key })
    return
  }
  closeGroup(model)
  pushBlock(model, { kind: 'opening', key: `seq:${event.seq}`, rows: [{ row, type: event.type }], resumed: model.turnsSeen > 0, seqs: [event.seq], time: event.time }, ops)
}

/**
 * The one block of a compaction bracket, keyed by its start's seq: the
 * applied record and the end name that seq, so they find it on any page. In
 * a prepend, a bracket the newer window had to show early (from its end)
 * MOVES to where its start is.
 * @param {Model} model @param {number} startSeq @param {EventEnvelope} event @param {Op[]} ops @param {Adopt | undefined} adopt
 * @returns {CompactionBlock}
 */
function compactionBlock(model, startSeq, event, ops, adopt) {
  const own = model.compactions.get(startSeq)
  if (own) return own
  const early = adopt?.newer.compactions.get(startSeq)
  if (adopt && early) {
    if (event.type !== 'compaction/start') return early
    const at = adopt.newer.blocks.indexOf(early)
    if (at !== -1) adopt.newer.blocks.splice(at, 1)
    adopt.newer.blocksByKey.delete(early.key)
    adopt.newer.compactions.delete(startSeq)
    adopt.removed.add(early.key)
    closeGroup(model)
    model.compactions.set(startSeq, early)
    model.blocks.push(early)
    model.blocksByKey.set(early.key, early)
    return early
  }
  closeGroup(model)
  /** @type {CompactionBlock} */
  const block = { kind: 'compaction', key: `compaction:${startSeq}`, startSeq, seqs: [], time: event.time }
  model.compactions.set(startSeq, block)
  pushBlock(model, block, ops)
  return block
}

/**
 * Older events — every one below the window's first seq, ascending — added
 * at the head. The older slice is folded on its own, lending it the newer
 * window to reclaim from; then the two meet at the boundary: a process group
 * the page cut in two is one group again, and so is an opening.
 * @param {Model} model
 * @param {readonly EventEnvelope[]} older
 * @returns {Op[]}
 */
export function prepend(model, older) {
  if (older.length === 0) return []
  const head = createConversation({ seedLength: model.seedLength })
  /** @type {Adopt} */
  const adopt = { newer: model, touched: new Set(), removed: new Set(), updated: new Set() }
  for (const event of older) {
    if (event.type === 'assistant/chunk') continue
    head.firstSeq = Math.min(head.firstSeq, event.seq)
    head.lastSeq = Math.max(head.lastSeq, event.seq)
    // The older slice's own ops are discarded: its blocks go in whole, below.
    markFork(head, event, [])
    apply(head, event, [], adopt)
  }
  // The fork marker sits between the last inherited event and the first own one.
  if (model.seedLength > 0 && !model.forkMarked && head.lastSeq < model.seedLength && model.firstSeq >= model.seedLength) {
    model.forkMarked = true
    closeGroup(head)
    head.blocks.push({ kind: 'fork', key: `fork:${model.seedLength}`, seqs: [], time: model.blocks[0]?.time ?? 0 })
  }
  /** @type {Op[]} */
  const after = []
  // A fact the newer window could only show as a note — its card's call, or
  // the job start naming its call, was on this older page — joins its card
  // now, as one fold of the whole window would have joined it.
  for (const [jobId, callId] of head.jobs) if (!model.jobs.has(jobId)) model.jobs.set(jobId, callId)
  /** @param {string} type @param {Record<string, any>} data */
  const cardOf = (type, data) => {
    const callId = type === 'job/end' ? model.jobs.get(String(data.jobId)) : data.callId === undefined ? undefined : String(data.callId)
    return callId === undefined ? undefined : (head.items.get(callId) ?? model.items.get(callId))
  }
  // Copies: both loops take what they join out of the arrays they walk.
  for (const block of model.blocks.slice()) {
    if (block.kind === 'note' && JOINS.has(block.type)) {
      const item = cardOf(block.type, block.data)
      if (!item) continue
      attach(item, block.type, block.data)
      item.seqs.push(...block.seqs)
      model.blocks.splice(model.blocks.indexOf(block), 1)
      model.blocksByKey.delete(block.key)
      adopt.removed.add(block.key)
      adopt.updated.add(item.key)
    } else if (block.kind === 'process') {
      for (const note of block.items.slice()) {
        if (note.kind !== 'note' || !JOINS.has(note.type)) continue
        const item = cardOf(note.type, note.data)
        if (!item) continue
        attach(item, note.type, note.data)
        item.seqs.push(...note.seqs)
        block.items.splice(block.items.indexOf(note), 1)
        adopt.touched.add(block.key)
        adopt.updated.add(item.key)
      }
    }
  }
  // A newer group that gave every item back to the page they came from is gone.
  for (const key of adopt.touched) {
    const block = model.blocksByKey.get(key)
    if (!block || block.kind !== 'process') continue
    if (block.items.length > 0) {
      after.push({ op: 'update', key })
      continue
    }
    model.blocks.splice(model.blocks.indexOf(block), 1)
    model.blocksByKey.delete(key)
    adopt.removed.add(key)
  }
  for (const key of adopt.removed) after.push({ op: 'remove', key })
  // The two halves meet. A group the newer window opened without a closing
  // block before it continues the older half's still-open group; an opening
  // continues an opening.
  const first = model.blocks[0]
  const last = head.blocks.at(-1)
  if (first?.kind === 'process' && last?.kind === 'process' && !last.closed) {
    head.blocks.pop()
    for (const item of last.items) item.groupKey = first.key
    first.items.unshift(...last.items)
    first.time = last.time
    after.push({ op: 'update', key: first.key })
  } else if (first?.kind === 'opening' && last?.kind === 'opening') {
    head.blocks.pop()
    first.rows.unshift(...last.rows)
    first.seqs.unshift(...last.seqs)
    first.resumed = last.resumed
    after.push({ op: 'update', key: first.key })
  }
  for (const [callId, item] of head.items) model.items.set(callId, item)
  for (const [id, asked] of head.asked) if (!model.asked.has(id)) model.asked.set(id, asked)
  for (const [id, decided] of head.decided) if (!model.decided.has(id)) model.decided.set(id, decided)
  for (const [startSeq, block] of head.compactions) model.compactions.set(startSeq, block)
  // A tail whose turn began on the page just loaded can now say how long it took.
  for (const [turn, time] of head.turnStarts) {
    if (model.turnStarts.has(turn)) continue
    model.turnStarts.set(turn, time)
    for (const block of model.blocks) if (block.kind === 'tail' && block.turn === turn) after.push({ op: 'update', key: block.key })
  }
  model.turnsSeen += head.turnsSeen
  for (const block of head.blocks) model.blocksByKey.set(block.key, block)
  model.blocks.unshift(...head.blocks)
  model.firstSeq = Math.min(model.firstSeq, head.firstSeq)
  // Items still in the newer window that an older event completed.
  for (const key of adopt.updated) {
    if (key.startsWith('compaction:')) {
      if (model.blocksByKey.has(key)) after.push({ op: 'update', key })
      continue
    }
    const item = model.items.get(key.slice('call:'.length))
    if (item && !head.blocks.some((block) => block.key === item.groupKey) && model.blocksByKey.has(item.groupKey)) after.push({ op: 'update', key: item.groupKey, item: item.key })
  }
  return head.blocks.length > 0 ? [{ op: 'prepend', blocks: head.blocks }, ...after] : after
}

/**
 * A tool result's text, as a person reads it: its text blocks, nested
 * tool-result content included; images are listed apart.
 * @param {readonly ContentBlock[]} content
 * @returns {string}
 */
export function resultText(content) {
  const parts = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'tool-result') parts.push(resultText(block.content))
  }
  return parts.join('')
}

/**
 * Every image block in a result, at any depth.
 * @param {readonly ContentBlock[]} content
 * @returns {ContentBlock[]}
 */
export function imagesIn(content) {
  /** @type {ContentBlock[]} */
  const out = []
  for (const block of content) {
    if (block.type === 'image') out.push(block)
    else if (block.type === 'tool-result') out.push(...imagesIn(block.content))
  }
  return out
}

/**
 * Every visible seq the model places, and where — the parity gate's view of
 * this file: each event `rows.js` makes visible must appear exactly once, and
 * authority and failure never inside a group.
 * @param {Model} model
 * @returns {Map<number, { block: Block['kind'], item?: Item['kind'], inGroup: boolean }>}
 */
export function placements(model) {
  /** @type {Map<number, { block: Block['kind'], item?: Item['kind'], inGroup: boolean }>} */
  const out = new Map()
  /** @param {number} seq @param {{ block: Block['kind'], item?: Item['kind'], inGroup: boolean }} where */
  const put = (seq, where) => {
    const before = out.get(seq)
    if (before) throw new Error(`seq ${seq} is placed twice: in a ${before.item ?? before.block} and in a ${where.item ?? where.block}`)
    out.set(seq, where)
  }
  for (const block of model.blocks) {
    for (const seq of block.seqs) put(seq, { block: block.kind, inGroup: false })
    if (block.kind !== 'process') continue
    for (const item of block.items) for (const seq of item.seqs) put(seq, { block: block.kind, item: item.kind, inGroup: true })
  }
  return out
}

/**
 * The model's shape without its keys' counters — what two folds of the same
 * events must agree on. Group keys carry a fold-local counter (two groups may
 * open at one seq), so a group is identified by its items instead; seqs are a
 * set (a prepend adds an item's older seqs after its newer ones).
 * @param {Model} model
 */
export function shapeOf(model) {
  return model.blocks.map((block) => {
    /** @param {number[]} seqs */
    const sorted = (seqs) => seqs.toSorted((x, y) => x - y)
    if (block.kind !== 'process') return { kind: block.kind, key: block.key, seqs: sorted(block.seqs) }
    return { kind: block.kind, items: block.items.map((item) => ({ kind: item.kind, key: item.key, seqs: sorted(item.seqs) })) }
  })
}
