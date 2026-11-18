// @ts-check
/**
 * Small display formatters for the browser client: pure functions, no DOM, no
 * imports, nothing read from the clock. Every function that depends on time
 * takes `now` explicitly, so a row rendered from a replayed log reads the same
 * on every machine and the tests need no fake timers.
 *
 * Plain ES module shipped without a build step (see `scripts/build.ts`); the
 * tests run it under Node, so nothing here may touch a browser global.
 */

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const YEAR_DAYS = 365
/** A display month: a twelfth of a year, so twelve of them never print as `12mo`. */
const MONTH_DAYS = YEAR_DAYS / 12

/**
 * How long ago `ms` was, as the shortest label a list can carry: `now`, `5m`,
 * `3h`, `2d`, `1w`, `4mo`, `2y`. Every unit floors, so a label never claims
 * more time than has passed. A time in the future (a clock skew between host
 * and browser) reads as `now`, never as a negative age.
 * @param {number} ms epoch milliseconds of the thing being dated
 * @param {number} now epoch milliseconds of the present
 * @returns {string}
 */
export function compactAgo(ms, now) {
  const elapsed = now - ms
  if (!Number.isFinite(elapsed) || elapsed < 45 * SECOND) return 'now'
  if (elapsed < HOUR) return `${Math.max(1, Math.floor(elapsed / MINUTE))}m`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`
  const days = Math.floor(elapsed / DAY)
  if (days < 7) return `${days}d`
  if (days < 30) return `${Math.floor(days / 7)}w`
  if (days < YEAR_DAYS) return `${Math.min(11, Math.max(1, Math.floor(days / MONTH_DAYS)))}mo`
  return `${Math.floor(days / YEAR_DAYS)}y`
}

/** @param {number} n */
const pad2 = (n) => String(n).padStart(2, '0')

/**
 * A wall-clock stamp in the browser's local time zone, as short as the
 * context allows: `HH:mm` today, `M/D HH:mm` this year, `YYYY-M-D HH:mm`
 * otherwise. 24-hour, zero-padded time; the date parts are not padded.
 * @param {number} ms epoch milliseconds
 * @param {number} now epoch milliseconds of the present
 * @returns {string}
 */
export function clock(ms, now) {
  const at = new Date(ms)
  if (Number.isNaN(at.getTime())) return ''
  const today = new Date(now)
  const time = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`
  const sameYear = at.getFullYear() === today.getFullYear()
  if (sameYear && at.getMonth() === today.getMonth() && at.getDate() === today.getDate()) return time
  if (sameYear) return `${at.getMonth() + 1}/${at.getDate()} ${time}`
  return `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()} ${time}`
}

/**
 * An elapsed span: `0.4s` under a second, `12s` under a minute, `1m 5s` under
 * an hour, `1h 2m` beyond. Floors like `compactAgo`; a negative or non-finite
 * span (a missing end stamp) reads as `0s`.
 * @param {number} ms
 * @returns {string}
 */
export function duration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < SECOND) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`
  if (ms < MINUTE) return `${Math.floor(ms / SECOND)}s`
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ${Math.floor((ms % MINUTE) / SECOND)}s`
  return `${Math.floor(ms / HOUR)}h ${Math.floor((ms % HOUR) / MINUTE)}m`
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB']

/**
 * A size in 1024-based units: one decimal under 10 (dropped when it is `.0`),
 * none above; GB is the largest label. Rounds to nearest — sizes arrive as
 * whole bytes, so flooring would print 1.4 MB as `1.3 MB` — and a value that
 * rounds up to 1024 moves to the next unit instead of printing `1024 KB`.
 * @param {number} n bytes
 * @returns {string}
 */
export function bytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  let value = n
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit++
  }
  let shown = unit === 0 || value >= 9.95 ? Math.round(value) : Math.round(value * 10) / 10
  if (shown >= 1024 && unit < BYTE_UNITS.length - 1) {
    shown = 1
    unit++
  }
  return `${shown} ${BYTE_UNITS[unit]}`
}

/**
 * The comparison form of a path: forward slashes, a lowercase drive letter.
 * Length-preserving, so an index into it is an index into the original.
 * @param {string} path
 */
const comparable = (path) => {
  const slashed = path.replaceAll('\\', '/')
  return /^[A-Za-z]:/.test(slashed) ? slashed.charAt(0).toLowerCase() + slashed.slice(1) : slashed
}

/**
 * `path` relative to `cwd` when it lies inside it, else `path` unchanged.
 * Either slash style on either side, and a Windows drive letter in either
 * case. It never climbs: a path outside `cwd`, or one whose remainder holds a
 * `..` segment, comes back as given, because a display path that reads as
 * inside the workspace must be inside it.
 * @param {string} path
 * @param {string} cwd
 * @returns {string}
 */
export function relativePath(path, cwd) {
  if (typeof path !== 'string' || typeof cwd !== 'string' || cwd === '') return path
  const target = comparable(path)
  const bare = (/** @type {string} */ p) => {
    let end = p.length
    while (end > 0 && p.charAt(end - 1) === '/') end--
    return p.slice(0, end)
  }
  const base = bare(comparable(cwd))
  if (bare(target) === base) return '.'
  const prefix = `${base}/`
  if (!target.startsWith(prefix)) return path
  const rest = path.slice(prefix.length)
  if (rest === '' || rest.split(/[\\/]/).includes('..')) return path
  return rest
}

/**
 * A session or job id short enough for a list: for `session-<x>` the first
 * eight characters of `<x>`, otherwise the first eight characters.
 * @param {string} id
 * @returns {string}
 */
export function shortId(id) {
  const body = id.startsWith('session-') ? id.slice('session-'.length) : id
  return body.slice(0, 8)
}

/**
 * `1 file`, `3 files`, `0 files`.
 * @param {number} n
 * @param {string} one
 * @param {string} many
 * @returns {string}
 */
export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`
}
