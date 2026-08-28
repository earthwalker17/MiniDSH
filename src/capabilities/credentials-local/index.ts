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
import type { Logger, Plugin } from '../../kernel/index.ts'
import { CREDENTIALS, type CredentialRef, type Credentials } from '../../core/credentials/index.ts'

export interface CredentialsLocalConfig {
  /** JSON store path; omitted = environment-only resolution (hermetic tests). */
  readonly path?: string
}

/** Blank is absent: a value that is empty after trimming never resolves. */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
}

class LocalCredentials implements Credentials {
  private readonly path: string | undefined
  private readonly logger: Logger
  private warned = false
  constructor(path: string | undefined, logger: Logger) {
    this.path = path
    this.logger = logger
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
    try {
      const store = JSON.parse(raw) as Record<string, unknown>
      const value = store[ref]
      return typeof value === 'string' ? present(value) : undefined
    } catch (error) {
      this.report(`is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private report(what: string): void {
    if (this.warned) return
    this.warned = true
    this.logger.warn(`credentials store ${this.path} ${what}; credentials resolve from the environment only until it is fixed`)
  }
}

export const credentialsLocalPlugin: Plugin<CredentialsLocalConfig | undefined> = {
  name: 'credentials-local',
  apply(ctx, config) {
    ctx.provide(CREDENTIALS, new LocalCredentials(config?.path, ctx.logger))
  },
}
