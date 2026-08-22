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

export function newMessageId(): MessageId {
  return `msg-${crypto.randomUUID()}` as MessageId
}

export function newCallId(): CallId {
  return `call-${crypto.randomUUID()}` as CallId
}
