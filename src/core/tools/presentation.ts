/**
 * UI-neutral render intent for a tool call. A tool declares how a surface
 * should show it; `presentCall` is a pure function of args, invoked by the
 * surface from durable events, never by the tool body.
 */
export type ToolCallKind = 'read' | 'edit' | 'create' | 'delete' | 'search' | 'execute' | 'fetch' | 'other'

export interface FileLocation {
  readonly path: string
  readonly line?: number
}

export type ToolCallView =
  | { readonly card: 'generic'; readonly title: string; readonly kind?: ToolCallKind; readonly locations?: readonly FileLocation[] }
  | { readonly card: 'terminal'; readonly title: string; readonly cwd?: string }
  | { readonly card: 'diff'; readonly title: string; readonly path: string }
