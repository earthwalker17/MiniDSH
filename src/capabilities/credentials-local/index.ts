/**
 * Local credential provider: the process environment first, then a JSON store
 * (`<home>/credentials.json`, shaped `{ "NAME": "value" }`). The store is
 * re-read on every resolution — that per-operation read IS the hot-rotation
 * mechanism — and an unreadable or malformed store resolves as absent rather
 * than throwing: the consumer owns its own missing-credential error. An empty
 * layer value falls through to the next layer.
 */
import { readFileSync } from 'node:fs'
import type { Plugin } from '../../kernel/index.ts'
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
  constructor(path: string | undefined) {
    this.path = path
  }

  resolve(ref: CredentialRef): string | undefined {
    const fromEnv = present(process.env[ref])
    if (fromEnv !== undefined) return fromEnv
    if (this.path === undefined) return undefined
    try {
      const store = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>
      const value = store[ref]
      return typeof value === 'string' ? present(value) : undefined
    } catch {
      return undefined
    }
  }
}

export const credentialsLocalPlugin: Plugin<CredentialsLocalConfig | undefined> = {
  name: 'credentials-local',
  apply(ctx, config) {
    ctx.provide(CREDENTIALS, new LocalCredentials(config?.path))
  },
}
