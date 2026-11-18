/**
 * The browser's display formatters. Every time-dependent case passes `now`
 * explicitly, and every wall-clock expectation is built with the same local
 * `Date` constructor the formatter reads, so the suite holds in any time zone.
 */
import { describe, expect, it } from 'vitest'
import { bytes, clock, compactAgo, duration, plural, relativePath, shortId } from './format.js'

const S = 1000
const M = 60 * S
const H = 60 * M
const D = 24 * H

describe('compactAgo', () => {
  const now = Date.UTC(2026, 10, 19, 12, 0, 0)
  const ago = (ms: number) => compactAgo(now - ms, now)

  it('reads anything under 45 seconds, and the future, as now', () => {
    expect(ago(0)).toBe('now')
    expect(ago(44_999)).toBe('now')
    expect(ago(-5 * M)).toBe('now')
    expect(compactAgo(Number.NaN, now)).toBe('now')
  })

  it('floors every unit at its boundaries', () => {
    expect(ago(45 * S)).toBe('1m')
    expect(ago(59 * S)).toBe('1m')
    expect(ago(2 * M)).toBe('2m')
    expect(ago(H - 1)).toBe('59m')
    expect(ago(H)).toBe('1h')
    expect(ago(D - 1)).toBe('23h')
    expect(ago(D)).toBe('1d')
    expect(ago(7 * D - 1)).toBe('6d')
    expect(ago(7 * D)).toBe('1w')
    expect(ago(29 * D)).toBe('4w')
    expect(ago(30 * D)).toBe('1mo')
    expect(ago(61 * D)).toBe('2mo')
    expect(ago(364 * D)).toBe('11mo')
    expect(ago(365 * D)).toBe('1y')
    expect(ago(3 * 365 * D + 5 * D)).toBe('3y')
  })
})

describe('clock', () => {
  const now = new Date(2026, 10, 19, 15, 30).getTime()

  it('shows only the time on the same local day, zero-padded, 24-hour', () => {
    expect(clock(new Date(2026, 10, 19, 9, 5).getTime(), now)).toBe('09:05')
    expect(clock(new Date(2026, 10, 19, 0, 0).getTime(), now)).toBe('00:00')
    expect(clock(new Date(2026, 10, 19, 23, 59).getTime(), now)).toBe('23:59')
  })

  it('adds month and day within the year, the full date across years', () => {
    expect(clock(new Date(2026, 10, 18, 23, 59).getTime(), now)).toBe('11/18 23:59')
    expect(clock(new Date(2026, 0, 2, 7, 0).getTime(), now)).toBe('1/2 07:00')
    expect(clock(new Date(2025, 2, 4, 9, 5).getTime(), now)).toBe('2025-3-4 09:05')
    // A day later than now is a different day, not "today".
    expect(clock(new Date(2026, 10, 20, 1, 0).getTime(), now)).toBe('11/20 01:00')
  })

  it('reads its day boundary from the local calendar, not from UTC', () => {
    const local = new Date(2026, 5, 1, 0, 1)
    const late = new Date(2026, 5, 1, 23, 59).getTime()
    expect(clock(local.getTime(), late)).toBe(`${String(local.getHours()).padStart(2, '0')}:01`)
  })

  it('renders an invalid stamp as nothing', () => {
    expect(clock(Number.NaN, now)).toBe('')
  })
})

describe('duration', () => {
  it('uses one decimal under a second', () => {
    expect(duration(400)).toBe('0.4s')
    expect(duration(999)).toBe('0.9s')
    expect(duration(50)).toBe('0.0s')
  })
  it('uses whole seconds under a minute, then minutes and seconds, then hours and minutes', () => {
    expect(duration(1000)).toBe('1s')
    expect(duration(12_900)).toBe('12s')
    expect(duration(59_999)).toBe('59s')
    expect(duration(60_000)).toBe('1m 0s')
    expect(duration(65_000)).toBe('1m 5s')
    expect(duration(H - 1)).toBe('59m 59s')
    expect(duration(H)).toBe('1h 0m')
    expect(duration(H + 2 * M + 59 * S)).toBe('1h 2m')
    expect(duration(30 * H)).toBe('30h 0m')
  })
  it('reads negative, zero and non-finite spans as 0s', () => {
    expect(duration(-5)).toBe('0s')
    expect(duration(0)).toBe('0s')
    expect(duration(Number.NaN)).toBe('0s')
    expect(duration(Number.POSITIVE_INFINITY)).toBe('0s')
  })
})

describe('bytes', () => {
  it('formats in 1024-based units', () => {
    expect(bytes(0)).toBe('0 B')
    expect(bytes(15)).toBe('15 B')
    expect(bytes(1023)).toBe('1023 B')
    expect(bytes(1024)).toBe('1 KB')
    expect(bytes(Math.round(2.1 * 1024))).toBe('2.1 KB')
    expect(bytes(Math.round(1.4 * 1024 * 1024))).toBe('1.4 MB')
    expect(bytes(3 * 1024 ** 3)).toBe('3 GB')
  })
  it('keeps one decimal under 10 and none above', () => {
    expect(bytes(9.94 * 1024)).toBe('9.9 KB')
    expect(bytes(9.99 * 1024)).toBe('10 KB')
    expect(bytes(10 * 1024)).toBe('10 KB')
    expect(bytes(123.7 * 1024)).toBe('124 KB')
    expect(bytes(5000 * 1024 ** 3)).toBe('5000 GB')
  })
  it('moves to the next unit instead of printing 1024', () => {
    expect(bytes(1024 * 1024 - 1)).toBe('1 MB')
    expect(bytes(1023.6)).toBe('1 KB')
    expect(bytes(1023.4)).toBe('1023 B')
  })
  it('reads negative and non-finite sizes as 0 B', () => {
    expect(bytes(-1)).toBe('0 B')
    expect(bytes(Number.NaN)).toBe('0 B')
  })
})

describe('relativePath', () => {
  it('strips the cwd in either slash style', () => {
    expect(relativePath('/home/a/proj/src/x.ts', '/home/a/proj')).toBe('src/x.ts')
    expect(relativePath('/home/a/proj/src/x.ts', '/home/a/proj/')).toBe('src/x.ts')
    expect(relativePath('C:\\Users\\a\\proj\\src\\x.ts', 'C:\\Users\\a\\proj')).toBe('src\\x.ts')
    expect(relativePath('C:/Users/a/proj/src/x.ts', 'C:\\Users\\a\\proj')).toBe('src/x.ts')
    expect(relativePath('C:\\Users\\a\\proj\\x.ts', 'C:/Users/a/proj/')).toBe('x.ts')
  })
  it('compares Windows drive letters case-insensitively', () => {
    expect(relativePath('c:\\Users\\a\\proj\\x.ts', 'C:\\Users\\a\\proj')).toBe('x.ts')
    expect(relativePath('D:/w/x.ts', 'd:/w')).toBe('x.ts')
  })
  it('returns the path unchanged outside the cwd, and never climbs', () => {
    expect(relativePath('/home/a/other/x.ts', '/home/a/proj')).toBe('/home/a/other/x.ts')
    expect(relativePath('/home/a/project2/x.ts', '/home/a/proj')).toBe('/home/a/project2/x.ts')
    expect(relativePath('/home/a/proj/../secret', '/home/a/proj')).toBe('/home/a/proj/../secret')
    expect(relativePath('D:\\proj\\x.ts', 'C:\\proj')).toBe('D:\\proj\\x.ts')
    expect(relativePath('src/x.ts', '/home/a/proj')).toBe('src/x.ts')
  })
  it('reads the cwd itself as ., and a root cwd as a prefix', () => {
    expect(relativePath('/home/a/proj', '/home/a/proj/')).toBe('.')
    expect(relativePath('C:\\proj\\', 'c:/proj')).toBe('.')
    expect(relativePath('/etc/hosts', '/')).toBe('etc/hosts')
    expect(relativePath('C:\\x.ts', 'C:\\')).toBe('x.ts')
  })
  it('leaves the path alone when there is no cwd', () => {
    expect(relativePath('/a/b', '')).toBe('/a/b')
  })
})

describe('shortId, plural', () => {
  it('shortens a session id past its prefix, anything else from the start', () => {
    expect(shortId('session-0123456789abcdef')).toBe('01234567')
    expect(shortId('session-abc')).toBe('abc')
    expect(shortId('job-0123456789')).toBe('job-0123')
    expect(shortId('short')).toBe('short')
  })
  it('picks the form by count', () => {
    expect(plural(1, 'file', 'files')).toBe('1 file')
    expect(plural(3, 'file', 'files')).toBe('3 files')
    expect(plural(0, 'file', 'files')).toBe('0 files')
  })
})
