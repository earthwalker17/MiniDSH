/**
 * JSON-value discipline for the durable plane.
 *
 * Everything that enters the session log must be losslessly JSON-serializable,
 * checked at the append site (not at flush time) so `session.events` always
 * equals what a backend can persist. `snapshotJson` deep-copies and validates
 * in one pass; `deepFreeze` makes the result immutable.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export class JsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JsonError'
  }
}

/** Deep-copies `value`, rejecting anything JSON cannot round-trip. Detects cycles. */
export function snapshotJson<T>(value: T): T {
  return copy(value, new WeakSet(), '$') as T
}

function copy(value: unknown, seen: WeakSet<object>, path: string): JsonValue {
  if (value === null) return null
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return value as JsonValue
  if (kind === 'number') {
    if (!Number.isFinite(value as number)) throw new JsonError(`non-finite number at ${path}`)
    if (Object.is(value, -0)) return 0
    return value as number
  }
  if (kind === 'bigint') throw new JsonError(`bigint is not JSON at ${path}`)
  if (kind === 'undefined') throw new JsonError(`undefined is not JSON at ${path}`)
  if (kind === 'function' || kind === 'symbol') throw new JsonError(`${kind} is not JSON at ${path}`)
  const object = value as object
  if (seen.has(object)) throw new JsonError(`circular reference at ${path}`)
  seen.add(object)
  try {
    if (Array.isArray(value)) {
      const out: JsonValue[] = []
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) throw new JsonError(`sparse array hole at ${path}[${i}]`)
        out.push(copy(value[i], seen, `${path}[${i}]`))
      }
      return out
    }
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      throw new JsonError(`non-plain object (${proto?.constructor?.name ?? 'unknown'}) at ${path}`)
    }
    const out: { [key: string]: JsonValue } = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child === undefined) continue // JSON.stringify drops undefined properties; mirror that.
      out[key] = copy(child, seen, `${path}.${key}`)
    }
    return out
  } finally {
    seen.delete(object)
  }
}

/** Recursively freezes an object graph. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}
