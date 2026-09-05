/** Opaque branded identifiers used across cross-boundary references. */

declare const brand: unique symbol
export type Brand<T, B extends string> = T & { readonly [brand]: B }

export type SessionId = Brand<string, 'SessionId'>
export type MessageId = Brand<string, 'MessageId'>
export type CallId = Brand<string, 'CallId'>

export const asSessionId = (value: string): SessionId => value as SessionId
export const asMessageId = (value: string): MessageId => value as MessageId
export const asCallId = (value: string): CallId => value as CallId

/** A fresh session id. Agent id equals session id, so one mint serves both. */
export function newSessionId(prefix = 'session'): SessionId {
  return `${prefix}-${crypto.randomUUID()}` as SessionId
}

/**
 * Exactly what `newSessionId` produces, anchored at both ends.
 *
 * It is here rather than inlined by its reader because it is a fact about the
 * MINT, not about any one consumer: a store that deletes files must be able to
 * recognise the names it generated and nothing else, and a prefix test is not
 * that recognition. Nothing is required to use it — a store that cannot match
 * an id simply leaves the file alone, which is the safe direction.
 */
export const SESSION_ID_PATTERN = /^[a-z]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function newMessageId(): MessageId {
  return `msg-${crypto.randomUUID()}` as MessageId
}

export function newCallId(): CallId {
  return `call-${crypto.randomUUID()}` as CallId
}
