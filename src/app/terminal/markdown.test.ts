/**
 * The terminal's markdown layout. The parser and highlighter have their own
 * suites (`web/markdown.test.ts`, `web/highlight.test.ts`); this one holds
 * what the layout promises on top: each construct's rows and styles, the
 * width invariant on every fixture at every width, and that no control or
 * invisible character survives into a span however the model wrote it.
 */
import { describe, expect, it } from 'vitest'
import { isInvisible } from '../../core/text.ts'
import { renderMarkdown } from './markdown.ts'
import { ASCII_GLYPHS, UNICODE_GLYPHS, lineText, lineWidth, type Line, type Span, type Theme } from './style.ts'

const theme: Theme = { depth: 24, glyphs: UNICODE_GLYPHS }
const render = (md: string, width = 80, streaming = false): Line[] => renderMarkdown(md, width, theme, { streaming })
const rows = (md: string, width = 80, streaming = false): string[] => render(md, width, streaming).map(lineText)

/** The first span whose text is exactly `text`. */
function spanOf(lines: readonly Line[], text: string): Span {
  for (const line of lines) for (const piece of line) if (piece.text === text) return piece
  throw new Error(`no span is "${text}": ${JSON.stringify(lines.map(lineText))}`)
}

/** The first C0/C1 control or invisible character in `text`, as U+XXXX. A loop: the linter refuses controls in a regex. */
function forbidden(text: string): string | undefined {
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || isInvisible(ch)) return `U+${code.toString(16).padStart(4, '0')}`
  }
  return undefined
}

/** The layout invariants every rendering must hold. */
function expectWellFormed(lines: readonly Line[], width: number): void {
  for (const line of lines) {
    expect(lineWidth(line), JSON.stringify(lineText(line))).toBeLessThanOrEqual(width)
    for (const piece of line) {
      expect(piece.text).not.toBe('')
      expect(forbidden(piece.text), JSON.stringify(piece.text)).toBeUndefined()
    }
  }
}

const HOSTILE = [
  'Plain \x1b[31mred\x1b[0m text, a bell\x07, \u202eoverride\u202c, \u2066isolate\u2069, C1 \x9b31m and a NUL \x00 here.',
  '# Head \x1b]0;title\x07 ing',
  '- item \x1b[2J clear\n- tag \u{e0041} char',
  '> quote \u200f mark \u061c arabic',
  '| a\x1b[1m | b\u202e |\n|---|---|\n| \x07 | \x9b |',
  '```ts\u202e\nconst s = "\x1b[31m"\n// \u202e evil\n\tx\x07\r\nprogress 10%\rprogress 100%\n```',
  '[click \u202e](https://example.com/\u202epath)',
].join('\n\n')

/** Every construct, for the invariants. */
const FIXTURES: Readonly<Record<string, string>> = {
  prose: 'Use **bold**, *italic*, ~~old~~, `code` and [docs](https://example.com/docs/a/very/long/path/that/keeps/going).\nA soft break,  \nthen a hard one. See https://x.dev/a and www.example.com.',
  headings: '# A first-level heading that is rather long indeed\n\n## Second `level`\n\n###### Sixth',
  lists:
    '- one\n- two with a long text that will need to wrap at narrow widths\n  - nested\n    - deeper still with words\n- [x] done\n- [ ] todo\n\n9. nine\n10. ten\n11. eleven, which also wraps when the width is narrow',
  quotes: '> quoted text that runs on for a while to wrap\n>\n> > nested quote\n> > > three\n\n> - item one\n> - item two',
  code: '```ts\n// a comment that is long enough to need a hard wrap at twenty cells\nconst value = someFunction(argumentOne, "a string literal", 42)\n\tindented()\n```',
  codeInList: '1. Run this:\n\n   ```sh\n   pnpm vitest run src/app/terminal/markdown.test.ts --reporter verbose\n   ```\n2. Then check.',
  table: '| Name | Qty | Mid |\n|:-----|----:|:---:|\n| apple | 3 | x |\n| 香蕉 | 12 | yyy |\n| 🎉 | 1 | z |',
  wideTable:
    '| Command | Description |\n|---|---|\n| pnpm check | Runs every gate on the repository, slowly |\n| pnpm lint | Lints `src`, `scripts` and `skills` |',
  cjk: '中文字符测试中文字符测试中文字符测试，然后是更多的中文。 Done ✅ 🎉 ok 👨\u200d👩\u200d👧 family',
  rule: 'a\n\n---\n\nb\n\n***',
  longWord: `see ${'https://example.com/'.padEnd(220, 'x')} and ${'y'.repeat(150)}`,
  deep: [...Array.from({ length: 13 }, (_, k) => `${'  '.repeat(k)}- level ${k} with some words in it`), '', `${'> '.repeat(13)}deep quote with words`].join('\n'),
  hostile: HOSTILE,
}

describe('renderMarkdown: paragraphs', () => {
  it('renders nothing for empty or whitespace-only text', () => {
    expect(render('')).toEqual([])
    expect(render('   \n\t\n  ')).toEqual([])
  })

  it('styles inline spans: strong bold, emphasis italic, delete faint, code accent without backticks', () => {
    const lines = render('Use **bold**, *it*, ~~old~~ and `code`.')
    expect(lines.map(lineText)).toEqual(['Use bold, it, old and code.'])
    expect(spanOf(lines, 'bold').style).toEqual({ bold: true })
    expect(spanOf(lines, 'it').style).toEqual({ italic: true })
    expect(spanOf(lines, 'old').style).toEqual({ faint: true })
    expect(spanOf(lines, 'code').style).toEqual({ ink: 'accent' })
    expect(spanOf(lines, 'Use ').style).toBeUndefined()
  })

  it('nests inline styles', () => {
    const lines = render('***both*** and **`bold code`**')
    expect(spanOf(lines, 'both').style).toEqual({ bold: true, italic: true })
    expect(spanOf(lines, 'bold code').style).toEqual({ bold: true, ink: 'accent' })
  })

  it('underlines a link and follows it with its target, faint, when the text is not the target', () => {
    const lines = render('Read [the docs](https://example.com/docs).')
    expect(lines.map(lineText)).toEqual(['Read the docs (https://example.com/docs).'])
    expect(spanOf(lines, 'the docs').style).toEqual({ underline: true })
    expect(spanOf(lines, ' (https://example.com/docs)').style).toEqual({ faint: true })
  })

  it('shows no target when the text already is it, and always shows one that differs', () => {
    expect(rows('See https://x.dev/a now')).toEqual(['See https://x.dev/a now'])
    expect(rows('Visit www.example.com today')).toEqual(['Visit www.example.com today'])
    expect(rows('Mail <me@example.com>')).toEqual(['Mail me@example.com'])
    expect(rows('[https://good.example](https://evil.example)')).toEqual(['https://good.example (https://evil.example)'])
  })

  it('starts a new row at a hard break', () => {
    expect(rows('line one\\\nline two')).toEqual(['line one', 'line two'])
    expect(rows('line one  \nline two')).toEqual(['line one', 'line two'])
    expect(rows('soft\nbreak')).toEqual(['soft break'])
  })

  it('word-wraps, with one blank row between blocks and none before or after', () => {
    expect(rows('the quick brown fox jumps over the lazy dog', 20)).toEqual(['the quick brown fox', 'jumps over the lazy', 'dog'])
    expect(rows('\n\nfirst paragraph\n\n\n\nsecond paragraph\n\n')).toEqual(['first paragraph', '', 'second paragraph'])
  })

  it('measures CJK and emoji as two cells', () => {
    const cjk = '中文字符测试中文字符测试中文字符测试'
    const lines = render(cjk, 20)
    expect(lines.map(lineText)).toEqual(['中文字符测试中文字符', '测试中文字符测试'])
    expect(lines.map(lineWidth)).toEqual([20, 16])
    const emoji = render('Done ✅ 🎉 ok')
    expect(lineWidth(emoji[0]!)).toBe(13)
  })
})

describe('renderMarkdown: headings and rules', () => {
  it('shows a heading bold in the accent without its marks, and rules an H1 as wide as its text', () => {
    const lines = render('# Title here\n\nBody.')
    expect(lines.map(lineText)).toEqual(['Title here', '─'.repeat(10), '', 'Body.'])
    expect(spanOf(lines, 'Title here').style).toEqual({ bold: true, ink: 'accent' })
    expect(spanOf(lines, '─'.repeat(10)).style).toEqual({ faint: true })
  })

  it('caps the H1 rule at 40 cells and rules no other level', () => {
    const long = render(`# ${'word '.repeat(12).trim()}`)
    expect(lineText(long[1]!)).toBe('─'.repeat(40))
    expect(rows('Setext\n======')).toEqual(['Setext', '─'.repeat(6)])
    const sub = render('## Sub `x`\n\n###### Six')
    expect(sub.map(lineText)).toEqual(['Sub x', '', 'Six'])
    expect(spanOf(sub, 'x').style).toEqual({ bold: true, ink: 'accent' })
  })

  it('draws a thematic break as a faint rule of at most 60 cells', () => {
    expect(rows('a\n\n---\n\nb', 80)).toEqual(['a', '', '─'.repeat(60), '', 'b'])
    expect(rows('***', 30)).toEqual(['─'.repeat(30)])
    expect(spanOf(render('___', 30), '─'.repeat(30)).style).toEqual({ faint: true })
  })
})

describe('renderMarkdown: lists', () => {
  it("writes '-' for every bullet and keeps an ordered list's numbers from its start", () => {
    expect(rows('* a\n* b')).toEqual(['- a', '- b'])
    expect(rows('+ c')).toEqual(['- c'])
    expect(rows('3. three\n4. four')).toEqual(['3. three', '4. four'])
    expect(spanOf(render('- a'), '-').style).toEqual({ ink: 'accent' })
    expect(spanOf(render('7. a'), '7.').style).toEqual({ ink: 'accent' })
  })

  it('right-aligns numbers of different widths so every text starts in one column', () => {
    expect(rows('9. nine\n10. ten')).toEqual([' 9. nine', '10. ten'])
  })

  it("indents a nested list by its parent's bullet width plus one, with no blank rows in a tight list", () => {
    expect(rows('- one\n- two\n  - nested\n    - deeper\n- three')).toEqual(['- one', '- two', '  - nested', '    - deeper', '- three'])
    expect(rows('1. first\n   - sub\n2. second')).toEqual(['1. first', '   - sub', '2. second'])
  })

  it('hangs continuation rows under the text', () => {
    expect(rows('* a long item that should wrap with a hanging indent under its text', 20)).toEqual([
      '- a long item that',
      '  should wrap with a',
      '  hanging indent',
      '  under its text',
    ])
    expect(rows('10. ten\n11. an item that wraps under its text', 20)).toEqual(['10. ten', '11. an item that', '    wraps under its', '    text'])
  })

  it('shows task items after the bullet, the check in the ok ink', () => {
    const lines = render('- [x] done\n- [ ] todo')
    expect(lines.map(lineText)).toEqual(['- [x] done', '- [ ] todo'])
    expect(spanOf(lines, 'x').style).toEqual({ ink: 'ok' })
    expect(rows('- [x] a task long enough to wrap', 20)).toEqual(['- [x] a task long', '      enough to wrap'])
  })

  it('gives a loose list (an item holding more than its text) blank rows between items', () => {
    expect(rows('- a\n\n  more about a\n- b')).toEqual(['- a', '', '  more about a', '', '- b'])
  })

  it('holds a code block inside an item, indented under the text', () => {
    expect(rows('1. Run:\n\n   ```sh\n   npm test\n   ```\n2. Done')).toEqual(['1. Run:', '', '     sh', '     npm test', '', '2. Done'])
  })
})

describe('renderMarkdown: block quotes', () => {
  it('bars each row in the accent and makes the quoted text faint', () => {
    const lines = render('> quoted text')
    expect(lines.map(lineText)).toEqual(['│ quoted text'])
    expect(spanOf(lines, '│').style).toEqual({ ink: 'accent' })
    expect(spanOf(lines, 'quoted text').style).toEqual({ faint: true })
  })

  it('stacks bars for nested quotes, at most four', () => {
    expect(rows('> a\n>\n> > b')).toEqual(['│ a', '│', '│ │ b'])
    expect(rows('> > > > > > deep')).toEqual(['│ │ │ │ deep'])
  })

  it('wraps inside the bar', () => {
    expect(rows('> the quick brown fox jumps over', 20)).toEqual(['│ the quick brown', '│ fox jumps over'])
  })

  it('holds a list, its bullets faint like the rest of the quote', () => {
    const lines = render('> - item one\n> - item two')
    expect(lines.map(lineText)).toEqual(['│ - item one', '│ - item two'])
    expect(spanOf(lines, '-').style).toEqual({ faint: true, ink: 'accent' })
  })
})

describe('renderMarkdown: code blocks', () => {
  const sample = "```ts\n// note\nconst x = 'a'\n\tindented()\n```"

  it('indents two cells with no rail, no box and no fence, the language faint above', () => {
    const lines = render(sample)
    expect(lines.map(lineText)).toEqual(['  ts', '  // note', "  const x = 'a'", '      indented()'])
    expect(spanOf(lines, 'ts').style).toEqual({ faint: true })
    for (const line of lines) expect(lineText(line)).not.toContain('`')
  })

  it('colours the highlighter tokens', () => {
    const lines = render(sample)
    expect(spanOf(lines, '// note').style).toEqual({ faint: true, italic: true })
    expect(spanOf(lines, 'const').style).toEqual({ ink: 'accent' })
    expect(spanOf(lines, "'a'").style).toEqual({ ink: 'ok' })
    expect(spanOf(lines, 'indented').style).toEqual({ bold: true })
    const nums = render('```py\nx = 42 + None\n```')
    expect(spanOf(nums, '42').style).toEqual({ ink: 'warn' })
    expect(spanOf(nums, 'None').style).toEqual({ ink: 'warn' })
    const diff = render('```diff\n+added\n-removed\n```')
    expect(spanOf(diff, '+added').style).toEqual({ ink: 'add' })
    expect(spanOf(diff, '-removed').style).toEqual({ ink: 'del' })
  })

  it('shows an unlabelled block and an unknown language plainly', () => {
    expect(rows('```\nplain text\n```')).toEqual(['  plain text'])
    const lines = render('```klingon\nqapla\n```')
    expect(lines.map(lineText)).toEqual(['  klingon', '  qapla'])
    expect(spanOf(lines, 'qapla').style).toBeUndefined()
  })

  it('hard-wraps a long line by cells, continuation rows indented four', () => {
    const code = 'const value = someFunction(argumentOne, argumentTwo)'
    const out = rows(`\`\`\`\n${code}\n\`\`\``, 20)
    expect(out).toEqual(['  const value = some', '    Function(argumen', '    tOne, argumentTw', '    o)'])
    expect(out.map((row, i) => row.slice(i === 0 ? 2 : 4)).join('')).toBe(code)
  })

  it('keeps token styles across a hard wrap', () => {
    const lines = render(`\`\`\`ts\nconst s = "${'z'.repeat(30)}"\n\`\`\``, 20)
    const tail = lines.at(-1)!
    expect(lineText(tail).trim().endsWith('"')).toBe(true)
    expect(tail.at(-1)!.style).toEqual({ ink: 'ok' })
  })

  it('keeps blank lines inside a block and keeps CJK in cells when wrapping', () => {
    expect(rows('```\na\n\nb\n```')).toEqual(['  a', '', '  b'])
    const out = render('```\n中文字符测试中文字符测试\n```', 20)
    expect(out.map(lineText)).toEqual(['  中文字符测试中文字', '    符测试'])
    expectWellFormed(out, 20)
  })

  it('shows a streaming fence as the code so far, a half-typed closing fence hidden', () => {
    expect(rows('Intro\n\n```py\nprint("hi")\nx = 1\n``', 40, true)).toEqual(['Intro', '', '  py', '  print("hi")', '  x = 1'])
    expect(rows('```ts', 40, true)).toEqual(['  ts'])
    expect(rows('Intro\n\n```', 40, true)).toEqual(['Intro'])
  })
})

describe('renderMarkdown: tables', () => {
  const table = '| Name | Qty | Mid |\n|:-----|----:|:---:|\n| apple | 3 | x |\n| 香蕉 | 12 | yyy |\n| 🎉 | 1 | z |'

  it('aligns columns that fit: left, right and centre, two cells apart, CJK and emoji measured', () => {
    const lines = render(table)
    expect(lines.map(lineText)).toEqual(['Name   Qty  Mid', '─'.repeat(15), 'apple    3   x', '香蕉    12  yyy', '🎉       1   z'])
    expect(lines.map(lineWidth)).toEqual([15, 15, 14, 15, 14])
    expect(spanOf(lines, 'Name').style).toEqual({ bold: true })
    expect(spanOf(lines, '─'.repeat(15)).style).toEqual({ faint: true })
    expect(spanOf(lines, 'apple').style).toBeUndefined()
  })

  it('styles inline content in cells', () => {
    const lines = render('| a | b |\n|---|---|\n| `x` | **y** |')
    expect(spanOf(lines, 'x').style).toEqual({ ink: 'accent' })
    expect(spanOf(lines, 'y').style).toEqual({ bold: true })
  })

  it('falls back to one record per row when the columns do not fit', () => {
    const wide = '| Command | Description |\n|---|---|\n| pnpm check | Runs every gate on the repository |\n| pnpm lint | Lints |'
    const lines = render(wide, 20)
    expect(lines.map(lineText)).toEqual([
      'Command: pnpm check',
      'Description: Runs',
      '  every gate on the',
      '  repository',
      '',
      'Command: pnpm lint',
      'Description: Lints',
    ])
    expect(spanOf(lines, 'Command').style).toEqual({ bold: true })
    expectWellFormed(lines, 20)
    // The same table fits at 80 and is a grid there.
    expect(rows(wide, 80)[1]).toBe('─'.repeat(45))
  })

  it('falls back with CJK and keeps every row inside the width', () => {
    const cjk = '| 名称 | 说明 |\n|---|---|\n| 甲 | 这是一个很长的中文说明需要换行显示 |'
    const lines = render(cjk, 20)
    expect(lineText(lines[0]!)).toBe('名称: 甲')
    expectWellFormed(lines, 20)
  })
})

describe('renderMarkdown: robustness', () => {
  it('renders a width under 10 as if 10', () => {
    const text = 'the quick brown fox jumps'
    expect(render(text, 4)).toEqual(render(text, 10))
    expect(render(text, Number.NaN)).toEqual(render(text, 10))
    expect(render(text, -3)).toEqual(render(text, 10))
    expect(rows(text, Number.POSITIVE_INFINITY)).toEqual([text])
  })

  it('lets no control, escape, bell or bidi character through, in any construct', () => {
    for (const width of [20, 40, 80]) {
      for (const streaming of [false, true]) {
        const lines = render(HOSTILE, width, streaming)
        expectWellFormed(lines, width)
        for (const line of lines) expect(forbidden(lineText(line))).toBeUndefined()
      }
    }
    const out = rows(HOSTILE, 80)
    // A bare `\r` ends a line for the parser (as in CommonMark), so it never reaches a row.
    expect(out).toContain('  progress 10%')
    expect(out).toContain('  progress 100%')
    // A CRLF line inside code: its tab expanded, its BEL blanked.
    expect(out).toContain('      x ')
    // The escape's ESC is blanked, its parameters stay visible text: what the model wrote, defused.
    expect(out[0]).toContain(' [31mred [0m')
  })

  it.each(Object.keys(FIXTURES))('holds the width invariant on the %s fixture at 20, 40 and 80', (name) => {
    for (const width of [20, 40, 80]) {
      const lines = render(FIXTURES[name]!, width)
      expect(lines.length).toBeGreaterThan(0)
      expectWellFormed(lines, width)
      expect(lines[0]!.length).toBeGreaterThan(0)
      expect(lines.at(-1)!.length).toBeGreaterThan(0)
    }
  })

  it('never throws on any streaming prefix and keeps the invariant there', () => {
    const all = Object.values(FIXTURES).join('\n\n')
    for (let end = 0; end <= all.length; end += 7) {
      const lines = render(all.slice(0, end), 40, true)
      expectWellFormed(lines, 40)
    }
  })

  it('never throws on random markdown-shaped noise', () => {
    const alphabet = ['*', '_', '~', '`', '#', '>', '-', '+', '1.', '|', '[', ']', '(', ')', ' ', '  ', '\n', '\n\n', '\t', '\\', 'a', 'word', '中', '🎉', '\x1b', '\u202e', 'https://x.y', '```', ':-:']
    let seed = 12345
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed
    }
    for (let sample = 0; sample < 300; sample++) {
      let text = ''
      const length = next() % 80
      for (let i = 0; i < length; i++) text += alphabet[next() % alphabet.length]
      for (const width of [20, 37]) expectWellFormed(renderMarkdown(text, width, theme, { streaming: sample % 2 === 0 }), width)
    }
  })

  it('uses only ASCII with the ASCII glyph table', () => {
    const ascii: Theme = { depth: 4, glyphs: ASCII_GLYPHS }
    const text = '# Title\n\n> quote\n\n- [x] item\n\n---\n\n| a | b |\n|---|---|\n| c | d |\n\n```ts\nconst a = 1\n```'
    const lines = renderMarkdown(text, 40, ascii)
    for (const line of lines) for (const ch of lineText(line)) expect(ch.codePointAt(0)!).toBeLessThanOrEqual(0x7e)
    const out = lines.map(lineText)
    expect(out).toContain('-----')
    expect(out).toContain('| quote')
    expect(out).toContain('-'.repeat(40))
    expect(out).toContain('-'.repeat(4))
  })

  it('renders a 2,000-line reply quickly', () => {
    const parts: string[] = []
    let lines = 0
    for (let i = 0; lines < 2000; i++) {
      const kind = i % 4
      if (kind === 0) {
        parts.push(`## Section ${i}\n\nSome **prose** with \`code\`, a [link](https://example.com/${i}) and enough words to wrap a few times at eighty cells wide, 中文 too.`)
        lines += 3
      } else if (kind === 1) {
        parts.push(Array.from({ length: 8 }, (_, k) => `- item ${k} of ${i} with a little text`).join('\n'))
        lines += 8
      } else if (kind === 2) {
        parts.push(`\`\`\`ts\n${Array.from({ length: 20 }, (_, k) => `const value${k} = compute(${k}, "string ${k}") // comment ${k}`).join('\n')}\n\`\`\``)
        lines += 22
      } else {
        parts.push(`| a | b | c |\n|---|:-:|--:|\n${Array.from({ length: 6 }, (_, k) => `| ${k} | cell ${k} | ${k * 10} |`).join('\n')}`)
        lines += 8
      }
    }
    const reply = parts.join('\n\n')
    renderMarkdown(reply.slice(0, 2000), 80, theme)
    const started = performance.now()
    const out = renderMarkdown(reply, 80, theme)
    const elapsed = performance.now() - started
    expect(out.length).toBeGreaterThan(2000)
    expect(elapsed).toBeLessThan(400)
  })
})
