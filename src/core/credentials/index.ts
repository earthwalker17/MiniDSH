/**
 * The credential seam: configuration, logs, and the repository carry secret
 * *references* (environment-variable names); a provider owns the values. A
 * reference is resolved per operation and never cached, so a rotation takes
 * effect without a reload — and an empty stored value is absent everywhere,
 * never configured-but-blank.
 */
import { serviceKey } from '../../kernel/index.ts'
import type { Brand } from '../ids.ts'

export type CredentialRef = Brand<string, 'CredentialRef'>

const REF_SYNTAX = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Validates and brands an env-var-style secret name; the name is the only thing that ever travels. */
export function credentialRef(name: string): CredentialRef {
  if (!REF_SYNTAX.test(name)) {
    throw new Error(`credential reference "${name}" is not an environment-variable name`)
  }
  return name as CredentialRef
}

export interface Credentials {
  /**
   * The value behind a reference, or `undefined` when unconfigured. Resolved
   * fresh on every call. The value must never be logged, thrown, or stored —
   * only the reference may appear in an error or a durable record.
   */
  resolve(ref: CredentialRef): string | undefined
}

export const CREDENTIALS = serviceKey<Credentials>('credentials')
