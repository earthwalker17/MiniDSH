/**
 * Local credential provider: the process environment first, then a JSON store
 * (`<home>/credentials.json`, shaped `{ "NAME": "value" }`). The store is
 * re-read on every resolution — that per-operation read IS the hot-rotation
 * mechanism. A MISSING store is absent; a store that exists but cannot be
 * read or parsed also resolves as absent (the consumer owns its own
 * missing-credential error) but is reported once, because "key not set" is a
 * misleading answer to "your credentials file has a trailing comma". An empty
 * layer value falls through to the next layer.
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { Logger, Plugin } from '../../kernel/index.ts'
import { CREDENTIALS, type CredentialRef, type Credentials } from '../../core/credentials/index.ts'

export interface CredentialsLocalConfig {
  /** JSON store path; omitted = environment-only resolution (hermetic tests). */
  readonly path?: string | undefined
}

const configSchema = z.strictObject({ path: z.string().min(1).optional() }).optional()

/** Blank is absent: a value that is empty after trimming never resolves. */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
}

class LocalCredentials implements Credentials {
  private readonly path: string | undefined
  private readonly logger: Logger
  private warned = false
  /** What this deployment calls a secret, declared by the rows that mint them. */
  private readonly declared = new Set<CredentialRef>()
  constructor(path: string | undefined, logger: Logger) {
    this.path = path
    this.logger = logger
  }

  declare(ref: CredentialRef): void {
    this.declared.add(ref)
  }

  declaredRefs(): readonly CredentialRef[] {
    return [...this.declared]
  }

  resolve(ref: CredentialRef): string | undefined {
    const fromEnv = present(process.env[ref])
    if (fromEnv !== undefined) return fromEnv
    if (this.path === undefined) return undefined
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.report(`is unreadable: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    let store: unknown
    try {
      store = JSON.parse(raw)
    } catch (error) {
      // WHERE, never what: V8's message quotes about ten characters around the
      // fault, and in a store of secrets those are the head of a value (a
      // single-quoted one printed `'sk-live-S` to the host's stderr).
      this.report(`is not valid JSON${faultPosition(raw, error)}`)
      return undefined
    }
    if (store === null || typeof store !== 'object' || Array.isArray(store)) {
      this.report('is not a JSON object')
      return undefined
    }
    const value = (store as Record<string, unknown>)[ref]
    return typeof value === 'string' ? present(value) : undefined
  }

  describe(ref: CredentialRef): string {
    const env = `the ${ref} environment variable`
    return this.path === undefined ? env : `${env}, or "${ref}" in ${this.path}`
  }

  private report(what: string): void {
    if (this.warned) return
    this.warned = true
    this.logger.warn(`credentials store ${this.path} ${what}; credentials resolve from the environment only until it is fixed`)
  }
}

/** ` at line L, column C` when the parser named a character offset, else nothing: only the digits of its message are read. */
function faultPosition(raw: string, error: unknown): string {
  const offset = error instanceof Error ? /at position (\d+)/u.exec(error.message)?.[1] : undefined
  if (offset === undefined) return ''
  const before = raw.slice(0, Number(offset))
  const line = before.split('\n').length
  const column = before.length - before.lastIndexOf('\n')
  return ` at line ${line}, column ${column}`
}

export const credentialsLocalPlugin: Plugin<CredentialsLocalConfig | undefined> = {
  name: 'credentials-local',
  config: configSchema,
  apply(ctx, config) {
    ctx.provide(CREDENTIALS, new LocalCredentials(config?.path, ctx.logger))
  },
}
