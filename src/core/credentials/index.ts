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
  /**
   * Where a value for `ref` would be looked for, in words a person can act on
   * — "the X environment variable, or X in ~/.minidsh/credentials.json". For
   * the message a consumer writes when `resolve` came back empty: the
   * provider is the only thing that knows its own layers, and a first run that
   * says "key not set" without saying where to set it is a first run that
   * ends in the docs. Never a value, never a partial one.
   */
  describe(ref: CredentialRef): string
}

export const CREDENTIALS = serviceKey<Credentials>('credentials')
