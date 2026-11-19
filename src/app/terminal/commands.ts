/**
 * The full-screen terminal's slash commands: one table the palette ranks, the
 * help overlay lists and the dispatcher reads. A command's wire call is the
 * controller's; this is only what each one is called and what it takes.
 *
 * No command invokes a skill. A person names a listed skill in plain words and
 * the model reads it from the list it is shown; a skill hidden from the model
 * (`disable-model-invocation`) stays hidden, because the skill list is not on
 * the wire and a palette entry for it would need it there (S22.1 decision,
 * BLUEPRINT §3).
 */
import type { PaletteEntry } from './palette.ts'

/** Where a command's argument choices come from. */
export type OptionSource = 'models' | 'sessions' | 'sandbox' | 'ask' | 'accept' | 'presets'

export interface CommandSpec extends PaletteEntry {
  readonly options?: OptionSource
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: 'help', description: 'keys and commands' },
  { name: 'model', args: '[provider/]model [effort]', description: 'switch the model; alone, show it', options: 'models' },
  { name: 'compact', description: 'shrink the context now' },
  { name: 'resume', args: '<id>', description: 'open another session here', options: 'sessions' },
  { name: 'sessions', description: 'pick a recent session to open here' },
  { name: 'new', description: 'start a fresh session here' },
  { name: 'fork', description: 'branch this session and continue the branch' },
  { name: 'details', description: 'open every fold and full output (Ctrl+O)' },
  { name: 'copy', description: 'copy the last reply to the clipboard' },
  { name: 'jobs', args: '[cancel <id>]', description: 'background jobs; cancel one' },
  { name: 'grants', description: 'standing approvals in this session' },
  { name: 'revoke', args: '<grant-id>', description: 'take a standing approval back' },
  { name: 'sandbox', args: '<mode>', description: 'read-only | workspace-write | danger-full-access', options: 'sandbox' },
  { name: 'ask', args: '<ask|never>', description: 'whether a widening shell command asks first', options: 'ask' },
  { name: 'accept', args: '<full|none>', description: 'run shell commands this host cannot sandbox', options: 'accept' },
  { name: 'preset', args: '<name>', description: 'switch to an authority preset', options: 'presets' },
  { name: 'cancel', description: 'stop the running turn (Esc)' },
  { name: 'exit', description: 'quit (Ctrl+D)', exact: true },
]

export const commandNamed = (name: string): CommandSpec | undefined => COMMANDS.find((command) => command.name === name)

/** The keys a person can press, as `/help` lists them. */
export const KEYS: readonly (readonly [string, string])[] = [
  ['Enter', 'send (while a turn runs: steer it)'],
  ['Ctrl+J', 'new line (also Ctrl+Enter on Windows, Shift/Alt+Enter where the terminal reports them, or \\ then Enter)'],
  ['Esc', 'close a menu, or stop the running turn'],
  ['Ctrl+C', 'clear the draft, or stop the turn, or (twice) quit'],
  ['Ctrl+D', 'quit (when idle with an empty draft)'],
  ['↑ ↓', 'scroll (empty draft), move through the draft, then history'],
  ['Ctrl+P / Ctrl+N', 'previous / next message from history'],
  ['PgUp / PgDn', 'scroll a page'],
  ['Shift+↑ ↓', 'scroll three rows'],
  ['Ctrl+Home / End', 'top of the conversation / back to following'],
  ['Ctrl+O', 'open every fold and full output'],
  ['Ctrl+L', 'redraw the screen'],
  ['Tab', 'complete a command'],
  ['y / a / n', 'answer an approval (after it arms)'],
]
