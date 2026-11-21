/**
 * `str_replace_editor`: view / create / str_replace / insert over the `ctx.fs`
 * seam. Edits go through `fs/edit-intent` (read-before-edit) and writes carry a
 * refined intent; the body returns a text value that renders verbatim.
 */
import { z } from 'zod'
import type { Context, Plugin } from '../../kernel/index.ts'
import { FS, FS_EDIT_INTENT, FsError, type Fs, type FsActor, type FsObservation, type FsTarget } from '../../core/fs/index.ts'
import { defineTool, TOOLS } from '../../core/tools/index.ts'
import { clip } from '../../core/text.ts'
import type { Agent } from '../../core/agent/types.ts'

const DESCRIPTION = `Custom editing tool for viewing, creating and editing files.
* State is persistent across calls.
* "view" shows a file with line numbers, or lists a directory.
* "create" writes a new file (fails if the path exists).
* "str_replace" replaces the UNIQUE occurrence of old_str with new_str; include enough context to make old_str unique.
* "insert" inserts new_str after line insert_line (0 inserts at the top).
* Paths may be absolute or relative to the workspace.`

const InputSchema = z.object({
  command: z.enum(['view', 'create', 'str_replace', 'insert']),
  path: z.string(),
  file_text: z.string().optional(),
  old_str: z.string().optional(),
  new_str: z.string().optional(),
  insert_line: z.number().int().optional(),
  view_range: z.array(z.number().int()).optional(),
})
type Input = z.infer<typeof InputSchema>

const OutputSchema = z.object({ text: z.string() })

export interface EditorConfig {
  readonly maxOutputChars?: number | undefined
}

const configSchema = z.strictObject({ maxOutputChars: z.number().int().positive().optional() }).optional()

const TRUNCATED = '\n<response clipped><NOTE>To save context only part of this file has been shown. Use `grep -n` to find line ranges, then view a specific range.</NOTE>'

/**
 * What one call may read of a file, and why there is a bound at all: a view of
 * a ~130 MiB file read, split and numbered the whole file before showing
 * 16,000 characters, and aborted the host on V8's heap (S20.5, measured; ~100
 * MiB blocked its loop for ~30 s). A view reads a prefix and says what it left
 * out; an edit of a larger file is refused, and the shell can still do it.
 */
const VIEW_READ_BYTES = 8 * 1024 * 1024
const EDIT_MAX_BYTES = 8 * 1024 * 1024

function numberLines(text: string, startLine: number): string {
  const lines = text.split('\n')
  return lines.map((line, index) => `${String(startLine + index).padStart(6)}  ${line}`).join('\n')
}

/** Clipped by `clip`, never by `slice`: a bound that lands inside an emoji must not leave half of it in a tool result. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : clip(text, max) + TRUNCATED
}

/**
 * Whether a file's line endings are CRLF: it holds "\r\n" and no "\n"
 * without a "\r" before it. Every text file of a Windows checkout with
 * `core.autocrlf` is that. A model reads and writes "\n", so for such a file
 * the view shows lines without their carriage return and an edit converts at
 * the file (`toCrlf`); otherwise an insert landed a bare "\n" among CRLF lines
 * and a multi-line old_str copied from the view never matched. A file that
 * mixes both has no one ending to keep and is edited byte for byte, as an LF
 * file is.
 */
function isCrlf(text: string): boolean {
  return text.includes('\r\n') && !/(?<!\r)\n/.test(text)
}

/** Text the model wrote, in a CRLF file's endings. One that already spells "\r\n" is used as given. */
function toCrlf(text: string): string {
  return text.includes('\r\n') ? text : text.replaceAll('\n', '\r\n')
}

function cwdOf(agent: Agent | undefined): string {
  return agent?.session.header.cwd ?? process.cwd()
}

/** Asks the read-before-edit policy in the acting agent's scope; without a policy, edits are unconditional. */
function editIntent(ctx: Context, target: FsTarget, actor: FsActor): FsObservation {
  return (actor.agent?.ctx ?? ctx).waterfall(FS_EDIT_INTENT, target, actor, () => ({ kind: 'present', version: '' }) as const)
}

export const toolEditorPlugin: Plugin<EditorConfig | undefined> = {
  name: 'tool-editor',
  inject: [TOOLS, FS],
  config: configSchema,
  apply(ctx, config) {
    const maxOutputChars = config?.maxOutputChars ?? 16_000
    ctx.get(TOOLS).register(ctx, buildEditor(ctx, maxOutputChars))
  },
}

function buildEditor(ctx: Context, maxOutputChars: number) {
  const fs = ctx.get(FS)

  return defineTool({
    name: 'str_replace_editor',
    description: DESCRIPTION,
    input: InputSchema,
    output: OutputSchema,
    // Presentation only (core/tools/types.ts `display`): one tool, four
    // commands, so the `command` argument picks the card a surface draws.
    display: {
      card: 'edit',
      title: 'Edit file',
      fields: { path: 'path' },
      by: {
        arg: 'command',
        cases: {
          view: { card: 'read', title: 'Read file', fields: { path: 'path' } },
          create: { card: 'edit', title: 'Create file', fields: { path: 'path', content: 'file_text' } },
          str_replace: { card: 'edit', title: 'Edit file', fields: { path: 'path', oldText: 'old_str', newText: 'new_str' } },
          insert: { card: 'edit', title: 'Insert lines', fields: { path: 'path', newText: 'new_str', line: 'insert_line' } },
        },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
    execute: async (args: Input, exec) => {
      // The call travels with the actor so the provider can key its effect
      // record to it (§4): the editor asks for the write, the provider is what
      // records that one landed.
      const actor: FsActor = exec.agent ? { agent: exec.agent, callId: exec.callId } : {}
      const target = fs.resolve(args.path, cwdOf(exec.agent))
      switch (args.command) {
        case 'view':
          return { text: await view(fs, target, args, maxOutputChars, actor) }
        case 'create':
          return { text: await create(ctx, fs, target, args, actor) }
        case 'str_replace':
          return { text: await strReplace(ctx, fs, target, args, actor) }
        case 'insert':
          return { text: await insert(ctx, fs, target, args, actor) }
      }
    },
  })
}

async function view(fs: Fs, target: FsTarget, args: Input, max: number, actor: FsActor): Promise<string> {
  const info = await fs.stat(target)
  if (info?.type === 'directory') {
    const entries = await fs.listDir(target)
    const shown = entries
      .filter((entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== '__pycache__')
      .map((entry) => (entry.type === 'directory' ? `${entry.name}/` : entry.name))
      .toSorted()
    // Bounded like a file view: a cache or dataset directory holds hundreds of
    // thousands of names, and a tool result is replayed in every later request.
    let listing = `Directory ${target.displayPath}:`
    let listed = 0
    for (const name of shown) {
      if (listing.length + 1 + name.length > max) break
      listing += `\n${name}`
      listed++
    }
    if (listed === shown.length) return listing
    return `${listing}\n[${(shown.length - listed).toLocaleString('en-US')} more of ${shown.length.toLocaleString('en-US')} entries not shown; view a narrower path, or list this one with the shell]`
  }
  const read = await fs.readText(target, actor, { maxBytes: VIEW_READ_BYTES, partial: true })
  const complete = read.complete
  const text = isCrlf(read.text) ? read.text.replaceAll('\r\n', '\n') : read.text
  const lines = text.split('\n')
  // A partial read can end inside a line; that line is not shown as if whole.
  if (!complete) lines.pop()
  let start = 1
  let body = complete ? text : lines.join('\n')
  if (args.view_range && args.view_range.length === 2) {
    const [from, to] = args.view_range as [number, number]
    start = Math.max(1, from)
    const end = to === -1 ? lines.length : Math.min(lines.length, to)
    body = lines.slice(start - 1, end).join('\n')
  }
  const extent = complete
    ? `${lines.length} lines total`
    : `the first ${VIEW_READ_BYTES.toLocaleString('en-US')} bytes of ${(info?.size ?? 0).toLocaleString('en-US')}: ${lines.length} lines; read past them with the shell`
  const header = `Here's ${target.displayPath} (${extent})${args.view_range ? ` [lines ${start}-${args.view_range[1]}]` : ''}:`
  // Numbered no further than the clip can show: the work is the output's, not the file's.
  return truncate(`${header}\n${numberLines(clip(body, max), start)}`, max)
}

async function create(_ctx: Context, fs: Fs, target: FsTarget, args: Input, actor: FsActor): Promise<string> {
  if (args.file_text === undefined) throw new FsError('FS_IO', '"create" requires file_text')
  // create passes its intent explicitly and never asks `fs/edit-intent`, which only str_replace/insert consult.
  await fs.writeText(target, args.file_text, { kind: 'createIfAbsent' }, actor)
  return `Created ${target.displayPath}.`
}

async function strReplace(ctx: Context, fs: Fs, target: FsTarget, args: Input, actor: FsActor): Promise<string> {
  if (args.old_str === undefined || args.old_str.length === 0) throw new FsError('FS_IO', '"str_replace" requires a non-empty old_str')
  // The observed version is the CAS token: a file changed since the model read it
  // must be rejected, so we must NOT re-derive the version from a fresh read.
  const observed = editIntent(ctx, target, actor)
  const read = await readForEdit(fs, target, actor)
  const text = read.text
  const version = observed.kind === 'present' && observed.version.length > 0 ? observed.version : read.version
  const crlf = isCrlf(text)
  const oldStr = crlf ? toCrlf(args.old_str) : args.old_str
  const newStr = crlf ? toCrlf(args.new_str ?? '') : (args.new_str ?? '')
  const occurrences = text.split(oldStr).length - 1
  if (occurrences === 0) {
    throw new FsError('FS_EDIT_NOT_FOUND', `old_str did not appear in ${target.displayPath}. No replacement made.`)
  }
  if (occurrences > 1) {
    throw new FsError('FS_AMBIGUOUS_EDIT', `old_str appears ${occurrences} times in ${target.displayPath}; add more context to make it unique.`)
  }
  // Spliced, never `String.prototype.replace`: a string replacement reads
  // `$$`, `$&` and `$'` as patterns, and a shell script's `$$` landed as `$`
  // while the result said "Edited" (S20.5). Uniqueness is proven above.
  const at = text.indexOf(oldStr)
  const next = text.slice(0, at) + newStr + text.slice(at + oldStr.length)
  await fs.writeText(target, next, { kind: 'replaceIfVersion', version }, actor)
  return `Edited ${target.displayPath}.`
}

async function insert(ctx: Context, fs: Fs, target: FsTarget, args: Input, actor: FsActor): Promise<string> {
  if (args.insert_line === undefined || args.new_str === undefined) throw new FsError('FS_IO', '"insert" requires insert_line and new_str')
  const observed = editIntent(ctx, target, actor)
  const read = await readForEdit(fs, target, actor)
  const text = read.text
  const version = observed.kind === 'present' && observed.version.length > 0 ? observed.version : read.version
  const crlf = isCrlf(text)
  const eol = crlf ? '\r\n' : '\n'
  const lines = text.split(eol)
  if (args.insert_line < 0 || args.insert_line > lines.length) {
    throw new FsError('FS_IO', `insert_line ${args.insert_line} is out of range [0, ${lines.length}]`)
  }
  lines.splice(args.insert_line, 0, crlf ? toCrlf(args.new_str) : args.new_str)
  await fs.writeText(target, lines.join(eol), { kind: 'replaceIfVersion', version }, actor)
  return `Inserted text into ${target.displayPath}.`
}

/**
 * An edit's own read, which must NOT observe: `fs/observed` is a licence to
 * overwrite, and a refused edit whose read observed the new content let the
 * same call, repeated, write over text the model was never shown (S20.5). The
 * licence comes only from what the model viewed, or from its own last write.
 *
 * And it must decode EXACTLY: an edit writes the whole text back as UTF-8, so
 * a byte the decoder could only render as U+FFFD would be rewritten as one. A
 * GBK, Shift-JIS or Windows-1252 source file had every non-ASCII byte replaced
 * that way by an edit that touched only ASCII, and the result said "Edited".
 * So the decode is `fatal`, and a file that is not UTF-8 is refused whole.
 */
async function readForEdit(fs: Fs, target: FsTarget, actor: FsActor): Promise<{ text: string; version: string }> {
  let read: { bytes: Uint8Array; version: string }
  try {
    read = await fs.readBytes(target, actor, { maxBytes: EDIT_MAX_BYTES })
  } catch (error) {
    if (error instanceof FsError && error.code === 'FS_TOO_LARGE') {
      throw new FsError('FS_TOO_LARGE', `${target.displayPath} is larger than ${EDIT_MAX_BYTES.toLocaleString('en-US')} bytes, more than this tool edits; change it with the shell`)
    }
    throw error
  }
  try {
    // A BOM stays the text's first character, so the edit writes it back.
    return { text: new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }).decode(read.bytes), version: read.version }
  } catch {
    throw new FsError(
      'FS_IO',
      `${target.displayPath} is not valid UTF-8 (it is in another encoding, or is binary), and this tool reads and writes UTF-8 only: an edit would rewrite its other bytes, so nothing was changed; change it with the shell`,
    )
  }
}
