/** The LLM capability seam: vocabulary, adapter contract, stream runtime. */
export * from './types.ts'
export * from './message.ts'
export { BlockAssembler } from './assembler.ts'
export { LLM, LLM_STREAM, llmPlugin, type Llm, type ModelCatalogEntry, type ProviderInfo } from './runtime.ts'
