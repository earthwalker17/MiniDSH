/** The tool registry and its guarded execution pipeline. */
import type { JsonValue } from '../json.ts'
import type { ToolDefinition } from './types.ts'

export * from './types.ts'
export {
  TOOLS,
  TOOLS_PRE_EXECUTE,
  TOOLS_EXECUTE,
  TOOLS_POST_EXECUTE,
  TOOLS_RESULT,
  TOOLS_CHANGE,
  toParameters,
  toolCall,
  toolsPlugin,
  type Tools,
  type ToolCall,
  type ToolRestriction,
  type ToolsConfig,
} from './registry.ts'

/** Identity helper that infers a tool's arg and value types from its schemas. */
export function defineTool<Args, Value extends JsonValue>(definition: ToolDefinition<Args, Value>): ToolDefinition<Args, Value> {
  return definition
}
