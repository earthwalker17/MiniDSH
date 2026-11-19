import { describe, expect, it } from 'vitest'
import { displayTail } from './text.ts'

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const CSI8 = String.fromCharCode(0x9b)

describe('the stopped view text', () => {
  it('drops CSI, OSC, string and two-byte escapes, 8-bit CSI included', () => {
    const text = `${ESC}[31mred${ESC}[0m ${ESC}]0;title${BEL}a ${ESC}]8;;https://x${ESC}\\link${ESC}]8;;${ESC}\\ ${ESC}P1$r${ESC}\\b ${ESC}7c${ESC}8 ${CSI8}2Jd`
    expect(displayTail(text, 1000)).toBe('red a link b c d')
  })

  it('removes C0 and C1 controls but keeps newlines and tabs; CR becomes a newline', () => {
    expect(displayTail(`a\u0000b\u0007c\td\r\ne\rf\u007fg\u0085h\u009fi`, 1000)).toBe('abc\td\ne\nfghi')
  })

  it('removes bidi overrides and isolates', () => {
    expect(displayTail('safe ‮exe.txt‬ and ⁦x⁩', 1000)).toBe('safe exe.txt and x')
  })

  it('redacts the launch token and the session cookie wherever they appear', () => {
    const text = 'GET /?token=AbC_d-9 then cookie: minidsh_session=eyJ.sig-_; Path=/ and {"token":"zz"}'
    expect(displayTail(text, 1000)).toBe('GET /?token=[redacted] then cookie: minidsh_session=[redacted]; Path=/ and {"token":"[redacted]"}')
  })

  it('redacts before the cut, so a tail never keeps the end of a secret', () => {
    const text = `${'x'.repeat(50)} token=SECRETSECRETSECRET`
    const tail = displayTail(text, 12)
    expect(tail).toBe('n=[redacted]')
    expect(tail).not.toContain('SECRET')
  })

  it('redacts a secret an escape or control was hiding inside', () => {
    expect(displayTail(`tok${ESC}[0men=SECRET`, 100)).toBe('token=[redacted]')
    expect(displayTail('minidsh_\u0000session=SECRET', 100)).toBe('minidsh_session=[redacted]')
  })

  it('keeps the last maxChars code points, never splitting a pair', () => {
    expect(displayTail('abcdef', 3)).toBe('def')
    expect(displayTail('abc', 10)).toBe('abc')
    expect(displayTail('a😀b😀', 3)).toBe('😀b😀')
    expect(displayTail('abc', 0)).toBe('')
  })

  it('costs linear time on a hostile unterminated sequence', () => {
    const hostile = `${ESC}]`.repeat(20_000) + 'tail'
    const started = Date.now()
    expect(displayTail(hostile, 4)).toBe('tail')
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
