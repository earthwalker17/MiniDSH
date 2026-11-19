/**
 * The composer's text model: grapheme-safe editing, cell-width wrapping (CJK
 * at odd widths, the pending-wrap cursor), vertical moves over wrapped and hard
 * rows with a sticky column, word operations, and history browsing.
 */
import { describe, expect, it } from 'vitest'
import { Editor } from './editor.ts'
import { cleanText, graphemes, textWidth } from './width.ts'

function editor(text: string, cursor?: number): Editor {
  const e = new Editor()
  e.set(text, cursor)
  return e
}

const texts = (e: Editor, width: number): string[] => e.rows(width).rows.map((r) => r.text)
const where = (e: Editor, width: number): [number, number] => {
  const { cursorRow, cursorCol } = e.rows(width)
  return [cursorRow, cursorCol]
}

describe('editing by grapheme', () => {
  it('moves and deletes a combining sequence, a skin-toned emoji and CJK as one', () => {
    const e = editor('é👍🏽中x')
    e.left()
    expect(e.cursor).toBe(7)
    e.left()
    expect(e.cursor).toBe(6)
    e.left()
    expect(e.cursor).toBe(2)
    e.left()
    expect(e.cursor).toBe(0)
    e.left()
    expect(e.cursor).toBe(0)
    e.right()
    expect(e.cursor).toBe(2)
    e.deleteForward()
    expect(e.text).toBe('é中x')
    e.backspace()
    expect(e.text).toBe('中x')
    expect(e.cursor).toBe(0)
    e.backspace()
    expect(e.text).toBe('中x')
  })

  it('snaps a cursor that would fall inside a grapheme forward to its end', () => {
    expect(editor('👍🏽', 1).cursor).toBe(4)
    expect(editor('ab', 99).cursor).toBe(2)
    expect(editor('ab', -3).cursor).toBe(0)
    expect(editor('ab').cursor).toBe(2)
  })

  it('normalizes a pasted CRLF and CR to LF, in insert and in set', () => {
    const e = new Editor()
    e.insert('one\r\ntwo\rthree')
    expect(e.text).toBe('one\ntwo\nthree')
    expect(e.cursor).toBe(e.text.length)
    e.set('a\r\nb')
    expect(e.text).toBe('a\nb')
    e.bufferStart()
    e.newline()
    expect(e.text).toBe('\na\nb')
    expect(e.cursor).toBe(1)
  })

  it('steps over a line break as one position, and lines bound Home and End', () => {
    const e = editor('ab\ncd', 3)
    e.left()
    expect(e.cursor).toBe(2)
    e.right()
    e.lineEnd()
    expect(e.cursor).toBe(5)
    e.lineStart()
    expect(e.cursor).toBe(3)
    e.bufferEnd()
    expect(e.cursor).toBe(5)
    e.bufferStart()
    expect(e.cursor).toBe(0)
    e.lineEnd()
    expect(e.cursor).toBe(2)
  })

  it('kills to the line end, then the line break; clear returns what it cleared', () => {
    const e = editor('ab\ncd', 1)
    e.killToLineEnd()
    expect(e.text).toBe('a\ncd')
    e.killToLineEnd()
    expect(e.text).toBe('acd')
    e.bufferEnd()
    e.killToLineEnd()
    expect(e.text).toBe('acd')
    expect(e.clear()).toBe('acd')
    expect(e.isEmpty).toBe(true)
    expect(e.cursor).toBe(0)
  })
})

describe('words', () => {
  it('moves by runs of word characters, other symbols and whitespace', () => {
    const e = editor('hello world  foo_bar.baz')
    e.wordLeft()
    expect(e.cursor).toBe(21)
    e.wordLeft()
    expect(e.cursor).toBe(20)
    e.wordLeft()
    expect(e.cursor).toBe(13)
    e.wordLeft()
    expect(e.cursor).toBe(6)
    e.bufferStart()
    e.wordRight()
    expect(e.cursor).toBe(5)
    e.wordRight()
    expect(e.cursor).toBe(11)
    e.wordRight()
    expect(e.cursor).toBe(20)
  })

  it('is Unicode-aware and crosses line breaks as whitespace', () => {
    const e = editor('中文 测试\nnext')
    e.lineStart()
    e.wordLeft()
    expect(e.cursor).toBe(3)
    e.wordLeft()
    expect(e.cursor).toBe(0)
  })

  it('deletes whitespace then one word backwards', () => {
    const e = editor('hello world  ')
    e.deleteWordBack()
    expect(e.text).toBe('hello ')
    const path = editor('path/to/file')
    path.deleteWordBack()
    expect(path.text).toBe('path/to/')
    path.deleteWordBack()
    expect(path.text).toBe('path/to')
    path.bufferStart()
    path.deleteWordBack()
    expect(path.text).toBe('path/to')
  })
})

describe('rows', () => {
  it('an empty buffer is one empty row', () => {
    expect(new Editor().rows(10)).toEqual({ rows: [{ text: '', start: 0, end: 0 }], cursorRow: 0, cursorCol: 0 })
  })

  it('wraps CJK at odd widths without splitting a wide character, and width 1 still terminates', () => {
    const e = editor('中文字符测试', 0)
    expect(texts(e, 5)).toEqual(['中文', '字符', '测试'])
    expect(texts(e, 3)).toEqual(['中', '文', '字', '符', '测', '试'])
    expect(texts(e, 1)).toEqual(['中', '文', '字', '符', '测', '试'])
    expect(texts(editor('a中b', 0), 2)).toEqual(['a', '中', 'b'])
    expect(texts(editor('', 0), 1)).toEqual([''])
  })

  it('rows cover the text exactly, and only a lone over-wide grapheme exceeds the width', () => {
    const samples = ['abc中文def👍🏽ghi\njk\n\nl\tm', '中a中a中a中', 'x'.repeat(23), 'ééé\n中']
    for (const text of samples) {
      for (let width = 1; width <= 9; width++) {
        const { rows } = editor(text, 0).rows(width)
        let rebuilt = ''
        let previous: { end: number } | undefined
        for (const row of rows) {
          if (previous !== undefined) rebuilt += text.slice(previous.end, row.start)
          rebuilt += row.text
          expect(row.text).toBe(text.slice(row.start, row.end))
          const cells = textWidth(cleanText(row.text))
          expect(cells <= width || graphemes(row.text).length === 1, `${JSON.stringify(text)} at ${width}: ${JSON.stringify(row.text)}`).toBe(true)
          previous = row
        }
        expect(rebuilt).toBe(text)
      }
    }
  })

  it('reports the cursor column in cells, wide characters counting two', () => {
    expect(where(editor('中文', 1), 10)).toEqual([0, 2])
    expect(where(editor('中文'), 10)).toEqual([0, 4])
    expect(where(editor('a中b', 1), 3)).toEqual([0, 1])
    expect(where(editor('a中b', 2), 3)).toEqual([1, 0])
    // A tab is drawn as one cleaned cell, and counted as one.
    expect(where(editor('a\tb'), 10)).toEqual([0, 3])
  })

  it('puts a cursor at the end of a full row at the start of the next row', () => {
    // Soft-wrapped: the next row continues the line.
    expect(where(editor('abcdef', 4), 4)).toEqual([1, 0])
    // A wide character that did not fit: the row is short, but wrapped all the same.
    expect(where(editor('中文字', 2), 5)).toEqual([1, 0])
    // The last row of a line, full: one more empty row while the cursor is there.
    const full = editor('abcd')
    expect(full.rows(4)).toEqual({ rows: [{ text: 'abcd', start: 0, end: 4 }, { text: '', start: 4, end: 4 }], cursorRow: 1, cursorCol: 0 })
    full.left()
    expect(full.rows(4)).toEqual({ rows: [{ text: 'abcd', start: 0, end: 4 }], cursorRow: 0, cursorCol: 3 })
    expect(texts(editor('12345\nab', 5), 5)).toEqual(['12345', '', 'ab'])
    expect(where(editor('12345\nab', 5), 5)).toEqual([1, 0])
    // Not full: the cursor stays at the row's end.
    expect(where(editor('abc\nde', 3), 4)).toEqual([0, 3])
  })
})

describe('up and down', () => {
  // Width 4: 'abcd' (wrapped) | 'efgh' | 'xy' | '1234' (wrapped) | '5'
  const TEXT = 'abcdefgh\nxy\n12345'

  it('moves across wrapped and hard rows keeping the column, and reports the edges', () => {
    const e = editor(TEXT, 6)
    expect(where(e, 4)).toEqual([1, 2])
    expect(e.up(4)).toBe(true)
    expect(e.cursor).toBe(2)
    expect(e.up(4)).toBe(false)
    expect(e.cursor).toBe(2)
    expect(e.down(4)).toBe(true)
    expect(e.cursor).toBe(6)
    expect(e.down(4)).toBe(true)
    expect(e.cursor).toBe(11) // the end of 'xy', column 2
    expect(e.down(4)).toBe(true)
    expect(e.cursor).toBe(14)
    expect(e.down(4)).toBe(true)
    expect(e.cursor).toBe(17) // '5' is shorter: its end
    expect(e.down(4)).toBe(false)
  })

  it('keeps a sticky column through a short row until something else moves the cursor', () => {
    const e = editor(TEXT, 3)
    expect(where(e, 4)).toEqual([0, 3])
    e.down(4)
    expect(e.cursor).toBe(7)
    e.down(4)
    expect(e.cursor).toBe(11)
    e.down(4)
    expect(e.cursor).toBe(15) // back to column 3
    e.up(4)
    e.left()
    expect(where(e, 4)).toEqual([2, 1])
    e.down(4)
    expect(e.cursor).toBe(13) // the sticky column was dropped by the left move
  })

  it('never lands on the end of a full row, which would draw on the row below', () => {
    const e = editor('abc\nwxyz', 3)
    e.down(4)
    expect(e.cursor).toBe(7)
    expect(where(e, 4)).toEqual([1, 3])
    const pending = editor('abcd\nxy', 4)
    expect(where(pending, 4)).toEqual([1, 0])
    expect(pending.up(4)).toBe(true)
    expect(pending.cursor).toBe(0)
  })

  it('lands before a wide character the goal column falls inside', () => {
    const e = editor('abc\n中文', 3)
    e.down(10)
    expect(e.cursor).toBe(5) // column 3 is the right half of 文: before it, column 2
    expect(where(e, 10)).toEqual([1, 2])
  })
})

describe('history', () => {
  it('browses back from a saved draft and restores it past the newest', () => {
    const e = new Editor()
    e.seedHistory(['one', 'two'])
    e.insert('draft')
    e.left()
    expect(e.historyPrev()).toBe(true)
    expect(e.text).toBe('two')
    expect(e.cursor).toBe(3)
    expect(e.browsingHistory).toBe(true)
    expect(e.historyPrev()).toBe(true)
    expect(e.text).toBe('one')
    expect(e.historyPrev()).toBe(false)
    expect(e.text).toBe('one')
    expect(e.historyNext()).toBe(true)
    expect(e.text).toBe('two')
    expect(e.historyNext()).toBe(true)
    expect(e.text).toBe('draft')
    expect(e.cursor).toBe(4)
    expect(e.browsingHistory).toBe(false)
    expect(e.historyNext()).toBe(false)
  })

  it('an edit stops browsing and keeps the edited entry; a cursor move does not', () => {
    const e = new Editor()
    e.seedHistory(['one', 'two'])
    e.historyPrev()
    e.left()
    expect(e.browsingHistory).toBe(true)
    e.historyPrev()
    expect(e.text).toBe('one')
    e.insert('!')
    expect(e.browsingHistory).toBe(false)
    expect(e.text).toBe('one!')
    expect(e.historyNext()).toBe(false)
    expect(e.text).toBe('one!')
  })

  it('submit returns the text, records it, clears, and skips blanks and an exact repeat', () => {
    const e = new Editor()
    expect(e.historyPrev()).toBe(false)
    e.insert('first')
    expect(e.submit()).toBe('first')
    expect(e.isEmpty).toBe(true)
    e.insert('first')
    e.submit()
    e.insert('  ')
    expect(e.submit()).toBe('  ')
    e.pushHistory('')
    expect(e.historyPrev()).toBe(true)
    expect(e.text).toBe('first')
    expect(e.historyPrev()).toBe(false)
    e.historyNext()
    expect(e.text).toBe('')
  })

  it('seeding replaces the history and drops blanks and adjacent repeats', () => {
    const e = new Editor()
    e.pushHistory('old')
    e.seedHistory(['a', 'a', '', 'b'])
    e.historyPrev()
    expect(e.text).toBe('b')
    e.historyPrev()
    expect(e.text).toBe('a')
    expect(e.historyPrev()).toBe(false)
  })
})
