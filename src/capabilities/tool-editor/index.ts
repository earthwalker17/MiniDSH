/**
 * `str_replace_editor`: view / create / str_replace / insert over the `ctx.fs`
 * seam. Edits go through `fs/edit-intent` (read-before-edit) and writes carry a
 * refined intent; the body returns a text value that renders verbatim.
 */
import { z } from 'zod'
import type { Context, Plugin } from '../../kernel/index.ts'
import { FS, FS_EDIT_INTENT, FsError, type Fs, type FsActor, type FsObservation, type FsTarget } from '../../core/fs/index.ts'
import { defineTool, TOOLS, type ToolCallView } from '../../core/tools/index.ts'
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
  readonly maxOutputChars?: number
}

const TRUNCATED = '\n<response clipped><NOTE>To save context only part of this file has been shown. Use `grep -n` to find line ranges, then view a specific range.</NOTE>'

function numberLines(text: string, startLine: number): string {
  const lines = text.split('\n')
  return lines.map((line, index) => `${String(startLine + index).padStart(6)}  ${line}`).join('\n')
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + TRUNCATED
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
    render: (_args, value) => [{ type: 'text', text: value.text }],
    presentCall: (args): ToolCallView => {
      if (args.command === 'view') return { card: 'generic', title: `view ${args.path}`, kind: 'read', locations: [{ path: args.path }] }
      if (args.command === 'create') return { card: 'diff', title: `create ${args.path}`, path: args.path }
      if (args.command === 'str_replace') return { card: 'diff', title: `edit ${args.path}`, path: args.path }
      return { card: 'generic', title: `insert into ${args.path}`, kind: 'edit', locations: [{ path: args.path }] }
    },
    execute: async (args: Input, exec) => {
      const actor: FsActor = exec.agent ? { agent: exec.agent } : {}
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
    return `Directory ${target.displayPath}:\n${shown.join('\n')}`
  }
  const { text } = await fs.readText(target, actor)
  const lines = text.split('\n')
  let start = 1
  let body = text
  if (args.view_range && args.view_range.length === 2) {
    const [from, to] = args.view_range as [number, number]
    start = Math.max(1, from)
    const end = to === -1 ? lines.length : Math.min(lines.length, to)
    body = lines.slice(start - 1, end).join('\n')
  }
  const header = `Here's ${target.displayPath} (${lines.length} lines total)${args.view_range ? ` [lines ${start}-${args.view_range[1]}]` : ''}:`
  return truncate(`${header}\n${numberLines(body, start)}`, max)
}

async function create(_ctx: Context, fs: Fs, target: FsTarget, args: Input, actor: FsActor): Promise<string> {
  if (args.file_text === undefined) throw new FsError('FS_IO', '"create" requires file_text')
  // create passes its intent explicitly and never asks `fs/edit-intent`, which only str_replace/insert consult.
  await fs.writeText(target, args.file_text, { kind: 'createIfAbsent' }, actor)
  return `Created ${target.displayPath}.`
}

async function strReplace(ctx: Context, fs: Fs, target: FsTarget, args: Input, actor: FsActor): Promise<string> {
  if (args.old_str === undefined) throw new FsError('FS_IO', '"str_replace" requires old_str')
  // The observed version is the CAS token: a file changed since the model read it
  // must be rejected, so we must NOT re-derive the version from a fresh read.
  const observed = editIntent(ctx, target, actor)
  const read = await fs.readText(target, actor)
  const text = read.text
  const version = observed.kind === 'present' && observed.version.length > 0 ? observed.version : read.version
  const occurrences = text.split(args.old_str).length - 1
  if (occurrences === 0) {
    throw new FsError('FS_EDIT_NOT_FOUND', `old_str did not appear in ${target.displayPath}. No replacement made.`)
  }
  if (occurrences > 1) {
    throw new FsError('FS_AMBIGUOUS_EDIT', `old_str appears ${occurrences} times in ${target.displayPath}; add more context to make it unique.`)
  }
  const next = text.replace(args.old_str, args.new_str ?? '')
  await fs.writeText(target, next, { kind: 'replaceIfVersion', version }, actor)
  return `Edited ${target.displayPath}.`
}

async function insert(ctx: Context, fs: Fs, target: FsTarget, args: Input, actor: FsActor): Promise<string> {
  if (args.insert_line === undefined || args.new_str === undefined) throw new FsError('FS_IO', '"insert" requires insert_line and new_str')
  const observed = editIntent(ctx, target, actor)
  const read = await fs.readText(target, actor)
  const text = read.text
  const version = observed.kind === 'present' && observed.version.length > 0 ? observed.version : read.version
  const lines = text.split('\n')
  if (args.insert_line < 0 || args.insert_line > lines.length) {
    throw new FsError('FS_IO', `insert_line ${args.insert_line} is out of range [0, ${lines.length}]`)
  }
  lines.splice(args.insert_line, 0, args.new_str)
  await fs.writeText(target, lines.join('\n'), { kind: 'replaceIfVersion', version }, actor)
  return `Inserted text into ${target.displayPath}.`
}
