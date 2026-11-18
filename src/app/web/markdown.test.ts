/**
 * The browser's markdown parser. The client renders model-written text with
 * this tree and only `createElement`/`textContent`, so the suite holds three
 * things beyond the structure of each construct: raw HTML is never a node,
 * every link is http(s) or mailto however the target is disguised, and the
 * work is bounded on hostile input. Streaming prefixes must never throw and
 * must converge on the full parse.
 */
import { describe, expect, it } from 'vitest'
import { parseMarkdown, type Block, type Inline, type Root } from './markdown.js'

const blocks = (text: string, streaming = false): Block[] => parseMarkdown(text, { streaming }).children
const only = (text: string): Block => {
  const all = blocks(text)
  expect(all).toHaveLength(1)
  return all[0] as Block
}
const inline = (text: string): Inline[] => {
  const block = only(text)
  if (block.type !== 'paragraph') throw new Error(`expected a paragraph, got ${block.type}`)
  return block.children
}
const t = (text: string): Inline => ({ type: 'text', text })

type AnyNode = Root | Block | Inline

/** Every node in the tree, depth-first, with its depth; iterative so deep trees cannot overflow the test. */
function walk(root: Root): { node: AnyNode; depth: number }[] {
  const out: { node: AnyNode; depth: number }[] = []
  const stack: { node: AnyNode; depth: number }[] = [{ node: root, depth: 0 }]
  while (stack.length > 0) {
    const entry = stack.pop()
    if (entry === undefined) break
    out.push(entry)
    const { node, depth } = entry
    const kids: AnyNode[] = []
    if (node.type === 'root' || node.type === 'blockquote') kids.push(...node.children)
    else if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'strong' || node.type === 'emphasis' || node.type === 'delete' || node.type === 'link') kids.push(...node.children)
    else if (node.type === 'list') for (const item of node.items) kids.push(...item.children)
    else if (node.type === 'table') for (const row of [node.head, ...node.rows]) for (const cell of row) kids.push(...cell)
    for (const kid of kids) stack.push({ node: kid, depth: depth + 1 })
  }
  return out
}

const links = (root: Root) => walk(root).flatMap(({ node }) => (node.type === 'link' ? [node] : []))
const KNOWN = new Set(['root', 'paragraph', 'heading', 'code', 'list', 'blockquote', 'table', 'rule', 'text', 'strong', 'emphasis', 'delete', 'link', 'break'])
const SAFE = /^(?:https?:\/\/|mailto:)/

describe('blocks', () => {
  it('ATX headings, with an optional closing run, and setext headings', () => {
    expect(only('# One')).toEqual({ type: 'heading', depth: 1, children: [t('One')] })
    expect(only('###### Six ###')).toEqual({ type: 'heading', depth: 6, children: [t('Six')] })
    expect(only('## C# #')).toEqual({ type: 'heading', depth: 2, children: [t('C#')] })
    expect(only('#')).toEqual({ type: 'heading', depth: 1, children: [] })
    expect(only('####### seven')).toEqual({ type: 'paragraph', children: [t('####### seven')] })
    expect(only('#5 not a heading')).toEqual({ type: 'paragraph', children: [t('#5 not a heading')] })
    expect(only('Title\n=====')).toEqual({ type: 'heading', depth: 1, children: [t('Title')] })
    expect(only('Sub\n---')).toEqual({ type: 'heading', depth: 2, children: [t('Sub')] })
  })

  it('paragraphs join soft breaks with a space; two spaces or a backslash make a hard break', () => {
    expect(blocks('one\ntwo\n\nthree')).toEqual([
      { type: 'paragraph', children: [t('one two')] },
      { type: 'paragraph', children: [t('three')] },
    ])
    expect(inline('a  \nb\\\nc')).toEqual([t('a'), { type: 'break' }, t('b'), { type: 'break' }, t('c')])
    expect(inline('   indented\n  continuation  ')).toEqual([t('indented continuation')])
    expect(inline('a\r\nb\rc')).toEqual([t('a b c')])
  })

  it('fenced code: backticks and tildes, the info word as a lowercased lang, a longer closer', () => {
    expect(only('```TypeScript extra words\nconst a = 1\n\n  b\n```')).toEqual({ type: 'code', lang: 'typescript', text: 'const a = 1\n\n  b' })
    expect(only('~~~\n```\nnot a closer\n~~~')).toEqual({ type: 'code', text: '```\nnot a closer' })
    expect(only('````md\n```\ninner\n```\n````')).toEqual({ type: 'code', lang: 'md', text: '```\ninner\n```' })
    expect(only('  ```\n  indented\n    more\n  ```')).toEqual({ type: 'code', text: 'indented\n  more' })
    // A backtick fence's info string may not contain a backtick: that is inline code.
    expect(only('``` a`b')).toEqual({ type: 'paragraph', children: [t('``` a`b')] })
    // The content is literal: no markdown, no entities.
    expect(only('```\n**x** &amp; <b>\n```')).toEqual({ type: 'code', text: '**x** &amp; <b>' })
  })

  it('bullet and ordered lists, nested by indentation, with a start and task items', () => {
    expect(only('- a\n- b\n  - c\n    1. d')).toEqual({
      type: 'list',
      ordered: false,
      items: [
        { children: [{ type: 'paragraph', children: [t('a')] }] },
        {
          children: [
            { type: 'paragraph', children: [t('b')] },
            {
              type: 'list',
              ordered: false,
              items: [
                {
                  children: [
                    { type: 'paragraph', children: [t('c')] },
                    { type: 'list', ordered: true, start: 1, items: [{ children: [{ type: 'paragraph', children: [t('d')] }] }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
    expect(only('3. three\n4. four')).toMatchObject({ type: 'list', ordered: true, start: 3, items: [{}, {}] })
    expect(only('- [ ] todo\n- [x] done\n- [X] Done\n- [y] not a task')).toEqual({
      type: 'list',
      ordered: false,
      items: [
        { checked: false, children: [{ type: 'paragraph', children: [t('todo')] }] },
        { checked: true, children: [{ type: 'paragraph', children: [t('done')] }] },
        { checked: true, children: [{ type: 'paragraph', children: [t('Done')] }] },
        { children: [{ type: 'paragraph', children: [t('[y] not a task')] }] },
      ],
    })
  })

  it('list items hold indented code fences, continuation paragraphs and lazy lines', () => {
    expect(only('1. Run:\n   ```sh\n   pnpm test\n   ```\n\n   Then check.\n2. Done')).toEqual({
      type: 'list',
      ordered: true,
      start: 1,
      items: [
        {
          children: [
            { type: 'paragraph', children: [t('Run:')] },
            { type: 'code', lang: 'sh', text: 'pnpm test' },
            { type: 'paragraph', children: [t('Then check.')] },
          ],
        },
        { children: [{ type: 'paragraph', children: [t('Done')] }] },
      ],
    })
    expect(only('- a\nlazy')).toEqual({ type: 'list', ordered: false, items: [{ children: [{ type: 'paragraph', children: [t('a lazy')] }] }] })
    // The nesting models write after `1.`: two spaces, not three.
    const nested = only('1. a\n  - b')
    expect(nested.type === 'list' && nested.items[0]?.children[1]?.type).toBe('list')
  })

  it('a different marker starts a new list; a rule and a paragraph end one', () => {
    expect(blocks('- a\n+ b').map((b) => b.type)).toEqual(['list', 'list'])
    expect(blocks('1. a\n1) b').map((b) => b.type)).toEqual(['list', 'list'])
    expect(blocks('- a\n\n---\n\nafter').map((b) => b.type)).toEqual(['list', 'rule', 'paragraph'])
    expect(blocks('- a\n\nafter').map((b) => b.type)).toEqual(['list', 'paragraph'])
    // Only an ordered list starting at 1 may interrupt a paragraph.
    expect(blocks('The year\n2024. was long').map((b) => b.type)).toEqual(['paragraph'])
    expect(blocks('Steps:\n1. go').map((b) => b.type)).toEqual(['paragraph', 'list'])
  })

  it('block quotes, nested and lazily continued', () => {
    expect(only('> a\nlazy\n>\n> > b')).toEqual({
      type: 'blockquote',
      children: [
        { type: 'paragraph', children: [t('a lazy')] },
        { type: 'blockquote', children: [{ type: 'paragraph', children: [t('b')] }] },
      ],
    })
    expect(blocks('> a\n\n> b').map((b) => b.type)).toEqual(['blockquote', 'blockquote'])
    expect(only('> - x\n> - y')).toMatchObject({ type: 'blockquote', children: [{ type: 'list', items: [{}, {}] }] })
  })

  it('GFM tables: alignment, escaped pipes, short and long rows', () => {
    expect(only('| a | b | c | d |\n|---|:--|:-:|--:|\n| 1 | `x\\|y` | **z** |\n| 1 | 2 | 3 | 4 | 5 |')).toEqual({
      type: 'table',
      align: [null, 'left', 'center', 'right'],
      head: [[t('a')], [t('b')], [t('c')], [t('d')]],
      rows: [
        [[t('1')], [{ type: 'code', text: 'x|y' }], [{ type: 'strong', children: [t('z')] }], []],
        [[t('1')], [t('2')], [t('3')], [t('4')]],
      ],
    })
    expect(only('a | b\n- | -')).toMatchObject({ type: 'table', head: [[t('a')], [t('b')]], rows: [] })
    // A header and delimiter with different cell counts are not a table.
    expect(only('| a | b |\n| - |')).toEqual({ type: 'paragraph', children: [t('| a | b | | - |')] })
    // A table interrupts a paragraph and ends at a blank line.
    expect(blocks('intro\n| a |\n| - |\n| 1 |\n\nafter').map((b) => b.type)).toEqual(['paragraph', 'table', 'paragraph'])
  })

  it('thematic breaks', () => {
    for (const rule of ['---', '***', '___', ' - - -', '*  *  *  *']) expect(only(rule)).toEqual({ type: 'rule' })
    expect(only('--')).toEqual({ type: 'paragraph', children: [t('--')] })
    expect(only('-*-')).toEqual({ type: 'paragraph', children: [t('-*-')] })
  })
})

describe('inlines', () => {
  it('emphasis and strong with * and _', () => {
    expect(inline('*a* _b_ **c** __d__')).toEqual([
      { type: 'emphasis', children: [t('a')] },
      t(' '),
      { type: 'emphasis', children: [t('b')] },
      t(' '),
      { type: 'strong', children: [t('c')] },
      t(' '),
      { type: 'strong', children: [t('d')] },
    ])
    expect(inline('***both***')).toEqual([{ type: 'emphasis', children: [{ type: 'strong', children: [t('both')] }] }])
    expect(inline('**a *b* c**')).toEqual([{ type: 'strong', children: [t('a '), { type: 'emphasis', children: [t('b')] }, t(' c')] }])
    expect(inline('a*b*c')).toEqual([t('a'), { type: 'emphasis', children: [t('b')] }, t('c')])
  })

  it('matches CommonMark spec examples for delimiter runs, the rule of three included', () => {
    const TAG = { strong: 'strong', emphasis: 'em', delete: 'del' } as const
    const html = (nodes: readonly Inline[]): string =>
      nodes
        .map((n) => {
          if (n.type === 'text') return n.text
          if (n.type === 'code') return `<code>${n.text}</code>`
          if (n.type === 'break') return '<br>'
          if (n.type === 'link') return `<a href="${n.href}">${html(n.children)}</a>`
          return `<${TAG[n.type]}>${html(n.children)}</${TAG[n.type]}>`
        })
        .join('')
    const cases: [string, string][] = [
      ['*foo**bar**baz*', '<em>foo<strong>bar</strong>baz</em>'],
      ['**foo*bar*baz**', '<strong>foo<em>bar</em>baz</strong>'],
      ['foo***bar***baz', 'foo<em><strong>bar</strong></em>baz'],
      ['*foo**bar*', '<em>foo**bar</em>'],
      ['**foo*', '*<em>foo</em>'],
      ['*foo**', '<em>foo</em>*'],
      ['_foo_bar_baz_', '<em>foo_bar_baz</em>'],
      ['foo-_(bar)_', 'foo-<em>(bar)</em>'],
      ['*(**foo**)*', '<em>(<strong>foo</strong>)</em>'],
      ['*foo *bar**', '<em>foo <em>bar</em></em>'],
      ['foo******bar*********baz', 'foo<strong><strong><strong>bar</strong></strong></strong>***baz'],
      ['*foo [bar](https://x.y)*', '<em>foo <a href="https://x.y">bar</a></em>'],
      ['*a `*`*', '<em>a <code>*</code></em>'],
      ['[foo*](https://x.y)*', '<a href="https://x.y">foo*</a>*'],
      ['**a<http://foo.bar/?q=**>', '**a<a href="http://foo.bar/?q=**">http://foo.bar/?q=**</a>'],
      ['~~a **b** c~~', '<del>a <strong>b</strong> c</del>'],
    ]
    for (const [input, want] of cases) expect(html(inline(input)), input).toBe(want)
  })

  it('intraword underscores are literal, and so are unmatched delimiters', () => {
    expect(inline('snake_case_name and __init__.py')).toEqual([t('snake_case_name and '), { type: 'strong', children: [t('init')] }, t('.py')])
    expect(inline('a_b_ c')).toEqual([t('a_b_ c')])
    expect(inline('2 * 3 * 4')).toEqual([t('2 * 3 * 4')])
    expect(inline('**unclosed')).toEqual([t('**unclosed')])
    expect(inline('*a **b*')).toEqual([t('*a *'), { type: 'emphasis', children: [t('b')] }])
  })

  it('strikethrough is exactly ~~', () => {
    expect(inline('~~gone~~')).toEqual([{ type: 'delete', children: [t('gone')] }])
    expect(inline('~one~ ~~~three~~~ ~5 min')).toEqual([t('~one~ ~~~three~~~ ~5 min')])
  })

  it('inline code with backtick runs', () => {
    expect(inline('`a`')).toEqual([{ type: 'code', text: 'a' }])
    expect(inline('``a ` b``')).toEqual([{ type: 'code', text: 'a ` b' }])
    expect(inline('` `` `')).toEqual([{ type: 'code', text: '``' }])
    expect(inline('`*not em*` and `<b>`')).toEqual([{ type: 'code', text: '*not em*' }, t(' and '), { type: 'code', text: '<b>' }])
    expect(inline('`a\nb`')).toEqual([{ type: 'code', text: 'a b' }])
    expect(inline('``unmatched` x')).toEqual([t('``unmatched` x')])
  })

  it('links with an optional title, and their text', () => {
    expect(inline('[a *b*](https://x.com/p?q=1 "title")')).toEqual([
      { type: 'link', href: 'https://x.com/p?q=1', children: [t('a '), { type: 'emphasis', children: [t('b')] }] },
    ])
    expect(inline('[a](<https://x.com/a b>)')).toEqual([{ type: 'link', href: 'https://x.com/a b', children: [t('a')] }])
    expect(inline('[a](https://x.com/(b))')).toEqual([{ type: 'link', href: 'https://x.com/(b)', children: [t('a')] }])
    expect(inline('[mail](mailto:a@b.co)')).toEqual([{ type: 'link', href: 'mailto:a@b.co', children: [t('mail')] }])
    expect(inline('[a](HTTPS://X.COM)')).toEqual([{ type: 'link', href: 'https://X.COM', children: [t('a')] }])
    expect(inline('[](https://x.com)')).toEqual([{ type: 'link', href: 'https://x.com', children: [t('https://x.com')] }])
    // Links do not nest: the inner one wins and the outer brackets are text,
    // target included (a URL right after `](` is never a bare autolink).
    expect(inline('[a [b](https://b.com) c](https://a.com)')).toEqual([
      t('[a '),
      { type: 'link', href: 'https://b.com', children: [t('b')] },
      t(' c](https://a.com)'),
    ])
    expect(inline('[not a link] and [ref][1]')).toEqual([t('[not a link] and [ref][1]')])
  })

  it('autolinks: angle-bracketed, email, and bare GFM ones without trailing punctuation', () => {
    expect(inline('<https://x.com/a>')).toEqual([{ type: 'link', href: 'https://x.com/a', children: [t('https://x.com/a')] }])
    expect(inline('<me@x.com>')).toEqual([{ type: 'link', href: 'mailto:me@x.com', children: [t('me@x.com')] }])
    expect(inline('see https://x.com/a.')).toEqual([t('see '), { type: 'link', href: 'https://x.com/a', children: [t('https://x.com/a')] }, t('.')])
    expect(inline('(www.x.com/a_(b))')).toEqual([t('('), { type: 'link', href: 'http://www.x.com/a_(b)', children: [t('www.x.com/a_(b)')] }, t(')')])
    expect(inline('go to http://localhost:3000/x, then')).toEqual([
      t('go to '),
      { type: 'link', href: 'http://localhost:3000/x', children: [t('http://localhost:3000/x')] },
      t(', then'),
    ])
    expect(inline('**https://x.com**')).toEqual([{ type: 'strong', children: [{ type: 'link', href: 'https://x.com', children: [t('https://x.com')] }] }])
    expect(inline('xhttps://x.com www. https://')).toEqual([t('xhttps://x.com www. https://')])
    // A bare URL inside link text is not a second link.
    expect(inline('[see https://a.com](https://b.com)')).toEqual([{ type: 'link', href: 'https://b.com', children: [t('see https://a.com')] }])
  })

  it('backslash escapes and entities decode to text', () => {
    expect(inline('\\*not em\\* \\[x\\](y) \\a')).toEqual([t('*not em* [x](y) \\a')])
    expect(inline('&amp; &lt;b&gt; &quot; &#39; &nbsp;| &#x41;&#66; &copy; &#0; &bogus')).toEqual([t('& <b> " \'  | AB &copy; � &bogus')])
  })
})

describe('security', () => {
  it('raw HTML is never a node: it comes out as literal text', () => {
    for (const html of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<a href="https://x.com">x</a>', '<iframe src="javascript:alert(1)">', '<!-- c --><style>*{}</style>']) {
      expect(blocks(html)).toEqual([{ type: 'paragraph', children: [t(html)] }])
    }
    expect(blocks('<div>\n<script>\nalert(1)\n</script>\n</div>')).toEqual([{ type: 'paragraph', children: [t('<div> <script> alert(1) </script> </div>')] }])
  })

  it('a link to anything but an absolute http(s) or mailto URL renders its text only', () => {
    const targets = [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      '  javascript:alert(1)',
      'jav&#x61;script:alert(1)',
      '&#106;avascript:alert(1)',
      'javascript&colon;alert(1)',
      'java%73cript:alert(1)',
      '%6Aavascript:alert(1)',
      '<java\tscript:alert(1)>',
      '<java\nscript:alert(1)>',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '/relative/path',
      'relative',
      '//evil.example',
      '\\\\evil.example',
      'https:evil.example',
      'http:/evil.example',
      '<https:\\evil.example>',
      '',
    ]
    for (const target of targets) {
      const root = parseMarkdown(`[click](${target})`)
      expect(links(root), target).toEqual([])
      expect(JSON.stringify(root), target).not.toContain('"link"')
    }
    expect(inline('[click](javascript:alert(1))')).toEqual([t('click')])
  })

  it('an autolink to an unsafe scheme is text', () => {
    expect(inline('<javascript:alert(1)>')).toEqual([t('javascript:alert(1)')])
    expect(inline('<data:text/html,x>')).toEqual([t('data:text/html,x')])
    expect(inline('<vbscript:x>')).toEqual([t('vbscript:x')])
  })

  it('a control character never reaches an href', () => {
    expect(inline('www.x.com/a\u0000b')).toEqual([{ type: 'link', href: 'http://www.x.com/a', children: [t('www.x.com/a')] }, t('\u0000b')])
    expect(links(parseMarkdown('[a](https://x.com/&#9;y)'))).toEqual([])
    expect(links(parseMarkdown('[a](<https://x.com/\u0001y>)'))).toEqual([])
    // At the edges a control character is trimmed like whitespace, never kept.
    expect(links(parseMarkdown('[a](<https://x.com/\u0001>)')).map((link) => link.href)).toEqual(['https://x.com/'])
  })

  it('entity-decoded safe targets are links, with the decoded href', () => {
    expect(inline('[a](&#104;ttps://x.com/?a=1&amp;b=2)')).toEqual([{ type: 'link', href: 'https://x.com/?a=1&b=2', children: [t('a')] }])
  })

  it('an image renders as its alt text and loads nothing', () => {
    expect(inline('![a *diagram*](https://x.com/i.png)')).toEqual([t('a diagram')])
    expect(inline('![x](javascript:alert(1))')).toEqual([t('x')])
    expect(inline('[![badge](https://x.com/b.svg)](https://x.com)')).toEqual([{ type: 'link', href: 'https://x.com', children: [t('badge')] }])
    expect(inline('![unclosed')).toEqual([t('![unclosed')])
  })

  it('every link in arbitrary markdown-ish input is safe and every node is a known kind', () => {
    let seed = 0x1234567
    const random = () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) / 0x1_0000_0000
    }
    const pieces = ['[', ']', '(', ')', '![', '<', '>', '*', '_', '~~', '`', '\\', '&', '#x6A;', '&#106;', '&#0;', 'javascript:', 'https://', 'http:', 'mailto:', 'data:', 'www.', 'x.com', 'a@b.co', ' ', '\n', '\n\n', '- ', '1. ', '> ', '| ', '---', '```', '\t', '"', "'", 'a', 'é', '%3A', '&colon;', '\u0000', '\u0007', '\u007f', ' ', ' ', '&#9;']
    for (let round = 0; round < 2000; round++) {
      let text = ''
      const length = Math.floor(random() * 40)
      for (let i = 0; i < length; i++) text += pieces[Math.floor(random() * pieces.length)]
      for (const streaming of [false, true]) {
        const root = parseMarkdown(text, { streaming })
        for (const { node } of walk(root)) {
          if (!KNOWN.has(node.type)) throw new Error(`unknown node ${node.type} from ${JSON.stringify(text)}`)
          if (node.type === 'link' && !SAFE.test(node.href)) throw new Error(`unsafe href ${node.href} from ${JSON.stringify(text)}`)
          if (node.type === 'link' && [...node.href].some((c) => c.charCodeAt(0) < 0x20 || c === '\u007f')) throw new Error(`control character in ${JSON.stringify(node.href)}`)
        }
      }
    }
  })
})

const DOCUMENT = `# Release notes

Some *intro* text with **bold**, \`code\`, ~~old~~ and [a link](https://example.com "t").
A second line
after a hard break, and https://example.org/x.

## Steps

1. Install:
   \`\`\`sh
   pnpm install
   \`\`\`
2. Run the [tests](https://example.com/t):
   - unit
   - [x] live

> **Note**
> quoted, with a lazy
continuation.

| Name | Size |
|:-----|-----:|
| a.ts | 1 KB |
| b.ts | 2 KB |

---

~~~diff
- old
+ new
~~~
`

describe('streaming', () => {
  it('never throws on any prefix, and the complete text parses like a final one', () => {
    for (let end = 0; end <= DOCUMENT.length; end++) {
      expect(() => parseMarkdown(DOCUMENT.slice(0, end), { streaming: true })).not.toThrow()
    }
    expect(parseMarkdown(DOCUMENT, { streaming: true })).toEqual(parseMarkdown(DOCUMENT))
  })

  it('marks a fence still open at the end of a streaming parse, and only then', () => {
    expect(blocks('```py\nprint(1)\n', true)).toEqual([{ type: 'code', lang: 'py', text: 'print(1)', open: true }])
    expect(blocks('```py\nprint(1)\n')).toEqual([{ type: 'code', lang: 'py', text: 'print(1)' }])
    expect(blocks('```py\nprint(1)\n```', true)).toEqual([{ type: 'code', lang: 'py', text: 'print(1)' }])
    expect(blocks('```', true)).toEqual([{ type: 'code', text: '', open: true }])
    // Inside a list item that reaches the end, the fence is still arriving.
    expect(blocks('1. run\n   ```sh\n   pnpm', true)).toEqual([
      { type: 'list', ordered: true, start: 1, items: [{ children: [{ type: 'paragraph', children: [t('run')] }, { type: 'code', lang: 'sh', text: 'pnpm', open: true }] }] },
    ])
    // A fence closed by the end of its container, with more after, is not.
    const [first] = blocks('> ```\n> code\n\nafter', true)
    expect(first).toEqual({ type: 'blockquote', children: [{ type: 'code', text: 'code' }] })
  })

  it('does not flash a heading or a stray fence line while a chunk is still arriving', () => {
    // A lone `-` at the streaming edge is an empty list item, not a setext underline...
    expect(blocks('Steps\n-', true).map((b) => b.type)).toEqual(['paragraph', 'list'])
    // ...but it is one once the text is final, and `---` always is.
    expect(blocks('Steps\n-').map((b) => b.type)).toEqual(['heading'])
    expect(blocks('Steps\n---', true).map((b) => b.type)).toEqual(['heading'])
    // A closing fence half-typed is not shown as code.
    expect(blocks('```js\nx\n``', true)).toEqual([{ type: 'code', lang: 'js', text: 'x', open: true }])
    expect(blocks('````\nx\n```', true)).toEqual([{ type: 'code', text: 'x', open: true }])
    expect(blocks('```js\nx\n``')).toEqual([{ type: 'code', lang: 'js', text: 'x\n``' }])
  })

  it('keeps half-written spans and links literal', () => {
    expect(blocks('Some **bol', true)).toEqual([{ type: 'paragraph', children: [t('Some **bol')] }])
    expect(blocks('See [docs](https://exa', true)).toEqual([{ type: 'paragraph', children: [t('See [docs](https://exa')] }])
    expect(blocks('`unfinished', true)).toEqual([{ type: 'paragraph', children: [t('`unfinished')] }])
  })
})

describe('bounds', () => {
  it('caps container nesting: deeper markers are text', () => {
    const root = parseMarkdown(`${'>'.repeat(30)} deep`)
    let quotes = 0
    let node: Block | undefined = root.children[0]
    while (node !== undefined && node.type === 'blockquote') {
      quotes++
      node = node.children[0]
    }
    expect(quotes).toBe(12)
    expect(node).toEqual({ type: 'paragraph', children: [t(`${'>'.repeat(18)} deep`)] })

    const nested = Array.from({ length: 30 }, (_, level) => `${'  '.repeat(level)}- l${level}`).join('\n')
    const depth = Math.max(...walk(parseMarkdown(nested)).map((entry) => entry.depth))
    expect(depth).toBeLessThanOrEqual(2 * 12 + 3)
    expect(JSON.stringify(parseMarkdown(nested))).toContain('l29')
  })

  it('caps inline nesting: deeper spans are text, nothing is lost', () => {
    const levels = 60
    const text = `${'*a '.repeat(levels)}x${' b*'.repeat(levels)}`
    const root = parseMarkdown(text)
    const depth = Math.max(...walk(root).map((entry) => entry.depth))
    expect(depth).toBeLessThanOrEqual(24 + 3)
    const flat = walk(root)
      .flatMap(({ node }) => (node.type === 'text' ? [node.text] : []))
      .join('')
    expect(flat.replaceAll(/[^x]/g, '')).toBe('x')
    expect(flat.replaceAll(/[^a]/g, '')).toHaveLength(levels)
    expect(flat.replaceAll(/[^b]/g, '')).toHaveLength(levels)
  })

  it('parses the first 200 000 characters and appends the rest as one plain paragraph', () => {
    const body = `${'word '.repeat(40_000)}`
    expect(body.length).toBe(200_000)
    const tail = '\n\n# not a heading *not em*'
    const root = parseMarkdown(body + tail)
    expect(root.children[root.children.length - 1]).toEqual({ type: 'paragraph', children: [t(tail)] })
    expect(root.children).toHaveLength(2)
    expect(parseMarkdown(body).children).toHaveLength(1)
  })

  it('finishes pathological lines quickly', () => {
    const size = 50_000
    const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size)
    const lines = [
      `a${fill('*_[')}`,
      `a${fill('*_')}`,
      `a${fill('[')}`,
      `a${fill(']')}`,
      `a${fill('*a')}`,
      `a${fill('_a ')}`,
      `a${fill('**a ')}`,
      `a${fill('[a](')}`,
      `a${fill('[a](<')}`,
      `a${fill('[a]("')}`,
      `a${fill('![[')}`,
      `a${fill('`')}`,
      `a${fill('` `` ``` ```` ')}`,
      `a${fill('<')}`,
      `a${fill('<a')}`,
      `a${fill('<a@b')}`,
      `a${fill('&#')}`,
      `a${fill(' https://x')}`,
      `a${fill(' www.(')}`,
      `a${fill('~~a ')}`,
      `a${fill('\\')}`,
      // A bare URL whose host fails, rescanned from every boundary inside it.
      `a${fill('*https://x(')}`,
      `a${fill('(www.a')}`,
      // A paragraph of many short lines: each soft break must not re-read the whole paragraph.
      fill('a\n'),
      fill('a  \n'),
      fill('> '),
      fill('- '),
      fill('1. '),
      fill('|'),
      `| a |\n|${fill('-|')}`,
    ]
    const started = performance.now()
    for (const line of lines) {
      for (const streaming of [false, true]) expect(() => parseMarkdown(line, { streaming })).not.toThrow()
    }
    expect(performance.now() - started).toBeLessThan(15_000)
  })
})
