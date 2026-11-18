/**
 * The browser's highlighter. The one invariant that matters most is that the
 * token texts concatenate to exactly the input, for every language and for
 * any input — the client builds one text node per token, so a lost byte is a
 * code block that lies. Kinds are checked on representative snippets only:
 * they are a nicety and allowed to be rough.
 */
import { describe, expect, it } from 'vitest'
import { highlight, languageOf, type Kind, type Token } from './highlight.js'

const join = (tokens: readonly Token[]) => tokens.map((token) => token.text).join('')

/** The kind of the token that covers the first character of `needle`'s first occurrence. */
function kindAt(code: string, lang: string, needle: string, from = 0): Kind | undefined {
  const tokens = highlight(code, lang)
  const at = code.indexOf(needle, from)
  if (at < 0) throw new Error(`"${needle}" is not in the sample`)
  let offset = 0
  for (const token of tokens) {
    if (at < offset + token.text.length) return token.kind
    offset += token.text.length
  }
  throw new Error('ran past the end')
}

const SAMPLES: Record<string, string> = {
  js: 'import { a } from "./a.js"\n// line\nconst x = `t ${y}` + 0x1f /* block */\nfunction f(n) { return n?.size ?? null }\n',
  ts: 'interface P { name: string }\ntype Q = Array<number>\n@dec class C implements P { private readonly n = 1.5e3 }\n',
  jsx: 'const el = <div className="a">{x}</div>\n',
  tsx: 'export const C = (p: Props) => <Box.Item key={1} />\n',
  json: '{ "a": [1, -2.5e3, true, null], "b": "s\\"q" }\n',
  python: '@cached\ndef f(x: int) -> str:\n    """doc"""\n    return f"v{x}" if x else None  # note\n',
  sh: '#!/bin/bash\nexport A=1 # c\nif [ -f "$A" ]; then echo \'x\' | grep -v y; fi\necho \\"not a string\n',
  console: '$ pnpm test --run\n 9 passed\nPS C:\\w> Get-ChildItem -Path .\n',
  pwsh: '<# block #>\n$x = Get-Item -Path "C:\\a" -ErrorAction Stop\nif ($x -eq $null) { [string]$y = \'a\' } # c\n',
  rust: '#[derive(Debug)]\nfn main<\'a>(s: &\'a str) -> u32 { let c = \'x\'; println!("{}", r#"raw"#); 0 }\n',
  go: 'package main\nfunc main() { s := `raw` ; var r rune = \'x\'; fmt.Println(s, nil) }\n',
  java: '@Override\npublic static void main(String[] args) { int n = 0L; System.out.println("x"); }\n',
  c: '#include <stdio.h>\nint main(void) { char c = \'\\n\'; return NULL; } /* x */\n',
  cpp: '#pragma once\ntemplate <typename T> auto f(T t) { return R"(raw)" + nullptr; }\n',
  cs: 'using System;\nvar s = @"C:\\x" + $"{n}"; public class A { }\n',
  css: '.card > a:hover { color: #fff; margin: -1.5em 0; }\n@media (max-width: 600px) {\n  .card { display: none }\n}\n/* c */\n',
  html: '<!DOCTYPE html>\n<!-- c -->\n<a href="x" data-y=1 disabled>T &amp; U</a><br/>\n',
  xml: '<?xml version="1.0"?>\n<root a=\'b\'><![CDATA[ <x> ]]></root>\n',
  yaml: '---\nkey: value\nlist:\n  - name: "a" # c\n  - 12\nflag: true\nref: *anchor\n',
  toml: '[package]\nname = "x"\nversion = 1_000\ndate = 1979-05-27T07:32:00Z\nflags = [true, false]\n',
  sql: 'SELECT id, count(*) FROM "users" WHERE name = \'O\'\'Brien\' -- c\nLIMIT 10;\n',
  diff: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n',
}

describe('highlight: concatenation identity', () => {
  for (const [lang, code] of Object.entries(SAMPLES)) {
    it(`${lang} reproduces its input exactly`, () => {
      const tokens = highlight(code, lang)
      expect(join(tokens)).toBe(code)
      expect(tokens.every((token) => token.text !== '')).toBe(true)
    })
  }

  it('holds for random input in every language', () => {
    // A seeded generator so a failure reproduces.
    let seed = 0x2545f491
    const random = () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) / 0x1_0000_0000
    }
    const alphabet = [...'abcXYZ019 _$\t\n\r"\'`/\\*#<>!-+=@{}[]();:.,&%~|?^'].concat(['é', '😀', '\u0000', '<!--', '*/', '"""', '@"', '<#', '#>', '${', 'R"(', "r#\"", '&amp;'])
    const langs = [...Object.keys(SAMPLES), 'unknown-lang']
    for (let round = 0; round < 300; round++) {
      const length = Math.floor(random() * 120)
      let code = ''
      for (let i = 0; i < length; i++) code += alphabet[Math.floor(random() * alphabet.length)]
      for (const lang of langs) {
        const tokens = highlight(code, lang)
        if (join(tokens) !== code) throw new Error(`${lang} broke identity on ${JSON.stringify(code)}`)
        if (tokens.some((token) => token.text === '')) throw new Error(`${lang} emitted an empty token on ${JSON.stringify(code)}`)
      }
    }
  })

  it('never merges two adjacent tokens of the same kind into separate entries', () => {
    const tokens = highlight('a  b\n\nc', 'js')
    for (let i = 1; i < tokens.length; i++) expect(tokens[i]?.kind === tokens[i - 1]?.kind).toBe(false)
  })
})

describe('highlight: kinds', () => {
  it('js and ts', () => {
    const js = SAMPLES.js ?? ''
    expect(kindAt(js, 'js', 'import')).toBe('keyword')
    expect(kindAt(js, 'js', '"./a.js"')).toBe('string')
    expect(kindAt(js, 'js', '// line')).toBe('comment')
    expect(kindAt(js, 'js', '`t ${y}`')).toBe('string')
    expect(kindAt(js, 'js', '0x1f')).toBe('number')
    expect(kindAt(js, 'js', '/* block */')).toBe('comment')
    expect(kindAt(js, 'js', 'f(n)')).toBe('function')
    expect(kindAt(js, 'js', 'size')).toBe('property')
    expect(kindAt(js, 'js', 'null')).toBe('constant')
    expect(kindAt(js, 'js', '??')).toBe('operator')
    const ts = SAMPLES.ts ?? ''
    expect(kindAt(ts, 'ts', 'interface')).toBe('keyword')
    expect(kindAt(ts, 'ts', 'string')).toBe('type')
    expect(kindAt(ts, 'ts', 'Q')).toBe('type')
    expect(kindAt(ts, 'ts', '@dec')).toBe('meta')
    expect(kindAt(ts, 'ts', '1.5e3')).toBe('number')
    expect(kindAt(ts, 'typescript', 'readonly')).toBe('keyword')
  })

  it('jsx and tsx tag names', () => {
    expect(kindAt(SAMPLES.jsx ?? '', 'jsx', 'div')).toBe('type')
    expect(kindAt(SAMPLES.jsx ?? '', 'jsx', '"a"')).toBe('string')
    expect(kindAt(SAMPLES.tsx ?? '', 'tsx', 'Box.Item')).toBe('type')
  })

  it('json keys and values', () => {
    const json = SAMPLES.json ?? ''
    expect(kindAt(json, 'json', '"a"')).toBe('property')
    expect(kindAt(json, 'json', '-2.5e3')).toBe('number')
    expect(kindAt(json, 'json', 'true')).toBe('constant')
    expect(kindAt(json, 'jsonc', '"s\\"q"')).toBe('string')
  })

  it('python', () => {
    const py = SAMPLES.python ?? ''
    expect(kindAt(py, 'py', '@cached')).toBe('meta')
    expect(kindAt(py, 'py', 'def')).toBe('keyword')
    expect(kindAt(py, 'py', 'f(x')).toBe('function')
    expect(kindAt(py, 'py', 'int')).toBe('type')
    expect(kindAt(py, 'py', '"""doc"""')).toBe('string')
    expect(kindAt(py, 'python', 'f"v{x}"')).toBe('string')
    expect(kindAt(py, 'py', 'None')).toBe('constant')
    expect(kindAt(py, 'py', '# note')).toBe('comment')
  })

  it('shell and console', () => {
    const sh = SAMPLES.sh ?? ''
    expect(kindAt(sh, 'bash', '#!/bin/bash')).toBe('comment')
    expect(kindAt(sh, 'sh', 'export')).toBe('keyword')
    expect(kindAt(sh, 'sh', 'A=')).toBe('property')
    expect(kindAt(sh, 'sh', '# c')).toBe('comment')
    expect(kindAt(sh, 'sh', '"$A"')).toBe('string')
    expect(kindAt(sh, 'sh', '-f')).toBe('constant')
    expect(kindAt(sh, 'sh', 'echo')).toBe('function')
    expect(kindAt(sh, 'sh', 'grep')).toBe('function')
    expect(kindAt(sh, 'zsh', 'fi')).toBe('keyword')
    // An escaped quote opens nothing: the rest of the line is not a string.
    expect(kindAt(sh, 'sh', 'not a string')).toBeUndefined()
    const con = SAMPLES.console ?? ''
    expect(kindAt(con, 'console', '$ ')).toBe('meta')
    expect(kindAt(con, 'console', 'pnpm')).toBe('function')
    expect(kindAt(con, 'console', '9 passed')).toBeUndefined()
    expect(kindAt(con, 'console', 'PS C:')).toBe('meta')
    expect(kindAt(con, 'console', 'Get-ChildItem')).toBe('function')
  })

  it('powershell', () => {
    const ps = SAMPLES.pwsh ?? ''
    expect(kindAt(ps, 'ps1', '<# block #>')).toBe('comment')
    expect(kindAt(ps, 'pwsh', '$x')).toBe('property')
    expect(kindAt(ps, 'pwsh', 'Get-Item')).toBe('function')
    expect(kindAt(ps, 'pwsh', '-Path')).toBe('constant')
    expect(kindAt(ps, 'pwsh', '-eq')).toBe('operator')
    expect(kindAt(ps, 'pwsh', '$null')).toBe('constant')
    expect(kindAt(ps, 'pwsh', '[string]')).toBe('type')
    expect(kindAt(ps, 'powershell', 'if')).toBe('keyword')
    expect(kindAt(ps, 'pwsh', '# c')).toBe('comment')
  })

  it('rust, go, java, c, c++, c#', () => {
    const rs = SAMPLES.rust ?? ''
    expect(kindAt(rs, 'rs', '#[derive(Debug)]')).toBe('meta')
    expect(kindAt(rs, 'rust', "'a>")).toBe('type')
    expect(kindAt(rs, 'rust', "'x'")).toBe('string')
    expect(kindAt(rs, 'rust', 'println')).toBe('function')
    expect(kindAt(rs, 'rust', 'r#"raw"#')).toBe('string')
    expect(kindAt(rs, 'rust', 'u32')).toBe('type')
    const go = SAMPLES.go ?? ''
    expect(kindAt(go, 'go', 'func')).toBe('keyword')
    expect(kindAt(go, 'go', '`raw`')).toBe('string')
    expect(kindAt(go, 'go', 'Println')).toBe('function')
    expect(kindAt(go, 'go', 'nil')).toBe('constant')
    const java = SAMPLES.java ?? ''
    expect(kindAt(java, 'java', '@Override')).toBe('meta')
    expect(kindAt(java, 'java', 'String')).toBe('type')
    expect(kindAt(java, 'java', 'out')).toBe('property')
    const c = SAMPLES.c ?? ''
    expect(kindAt(c, 'c', '#include')).toBe('meta')
    expect(kindAt(c, 'c', "'\\n'")).toBe('string')
    expect(kindAt(c, 'c', 'NULL')).toBe('constant')
    const cpp = SAMPLES.cpp ?? ''
    expect(kindAt(cpp, 'cpp', 'template')).toBe('keyword')
    expect(kindAt(cpp, 'c++', 'R"(raw)"')).toBe('string')
    expect(kindAt(cpp, 'cpp', 'nullptr')).toBe('constant')
    const cs = SAMPLES.cs ?? ''
    expect(kindAt(cs, 'cs', '@"C:\\x"')).toBe('string')
    expect(kindAt(cs, 'csharp', '$"{n}"')).toBe('string')
    expect(kindAt(cs, 'cs', 'class')).toBe('keyword')
  })

  it('css', () => {
    const css = SAMPLES.css ?? ''
    expect(kindAt(css, 'css', '@media')).toBe('keyword')
    expect(kindAt(css, 'css', '.card')).toBe('type')
    expect(kindAt(css, 'css', ':hover')).toBe('keyword')
    expect(kindAt(css, 'css', 'color')).toBe('property')
    expect(kindAt(css, 'css', '#fff')).toBe('number')
    expect(kindAt(css, 'css', '-1.5em')).toBe('number')
    expect(kindAt(css, 'css', '/* c */')).toBe('comment')
  })

  it('html and xml', () => {
    const html = SAMPLES.html ?? ''
    expect(kindAt(html, 'html', '<!DOCTYPE')).toBe('meta')
    expect(kindAt(html, 'html', '<!-- c -->')).toBe('comment')
    expect(kindAt(html, 'html', 'a href')).toBe('keyword')
    expect(kindAt(html, 'html', 'href')).toBe('property')
    expect(kindAt(html, 'html', '"x"')).toBe('string')
    expect(kindAt(html, 'html', '1 disabled')).toBe('string')
    expect(kindAt(html, 'html', 'disabled')).toBe('property')
    expect(kindAt(html, 'html', '&amp;')).toBe('constant')
    expect(kindAt(html, 'html', 'T ')).toBeUndefined()
    expect(kindAt(html, 'html', '/>')).toBe('punctuation')
    const xml = SAMPLES.xml ?? ''
    expect(kindAt(xml, 'xml', '<?xml')).toBe('meta')
    expect(kindAt(xml, 'xml', "'b'")).toBe('string')
    expect(kindAt(xml, 'xml', '<![CDATA[')).toBe('string')
  })

  it('yaml and toml', () => {
    const yaml = SAMPLES.yaml ?? ''
    expect(kindAt(yaml, 'yaml', '---')).toBe('meta')
    expect(kindAt(yaml, 'yaml', 'key')).toBe('property')
    expect(kindAt(yaml, 'yml', 'name')).toBe('property')
    expect(kindAt(yaml, 'yaml', '"a"')).toBe('string')
    expect(kindAt(yaml, 'yaml', '# c')).toBe('comment')
    expect(kindAt(yaml, 'yaml', '12')).toBe('number')
    expect(kindAt(yaml, 'yaml', 'true')).toBe('constant')
    expect(kindAt(yaml, 'yaml', '*anchor')).toBe('meta')
    expect(kindAt(yaml, 'yaml', 'value')).toBeUndefined()
    const toml = SAMPLES.toml ?? ''
    expect(kindAt(toml, 'toml', '[package]')).toBe('type')
    expect(kindAt(toml, 'toml', 'name')).toBe('property')
    expect(kindAt(toml, 'toml', '"x"')).toBe('string')
    expect(kindAt(toml, 'toml', '1_000')).toBe('number')
    expect(kindAt(toml, 'toml', '1979-05-27T07:32:00Z')).toBe('number')
    expect(kindAt(toml, 'toml', 'true')).toBe('constant')
  })

  it('sql', () => {
    const sql = SAMPLES.sql ?? ''
    expect(kindAt(sql, 'sql', 'SELECT')).toBe('keyword')
    expect(kindAt(sql, 'sql', 'count')).toBe('function')
    expect(kindAt(sql, 'sql', '"users"')).toBe('property')
    expect(kindAt(sql, 'sql', "'O''Brien'")).toBe('string')
    expect(kindAt(sql, 'sql', '-- c')).toBe('comment')
    expect(kindAt(sql, 'sql', '10')).toBe('number')
  })

  it('diff: whole lines', () => {
    const code = SAMPLES.diff ?? ''
    const tokens = highlight(code, 'patch')
    expect(tokens.filter((t) => t.kind === 'inserted').map((t) => t.text)).toEqual(['+new'])
    expect(tokens.filter((t) => t.kind === 'deleted').map((t) => t.text)).toEqual(['-old'])
    expect(kindAt(code, 'diff', '--- a/x')).toBe('meta')
    expect(kindAt(code, 'diff', '+++ b/x')).toBe('meta')
    expect(kindAt(code, 'diff', '@@')).toBe('meta')
    expect(kindAt(code, 'diff', ' ctx')).toBeUndefined()
    // The newline that ends a coloured line stays outside its token.
    expect(tokens.some((t) => t.kind !== undefined && t.text.includes('\n'))).toBe(false)
  })
})

describe('highlight: unknown languages and bounds', () => {
  it('returns one plain token for an unknown or missing language', () => {
    expect(highlight('let x = 1', 'brainfuck')).toEqual([{ text: 'let x = 1' }])
    expect(highlight('let x = 1', undefined)).toEqual([{ text: 'let x = 1' }])
    expect(highlight('let x = 1', '')).toEqual([{ text: 'let x = 1' }])
  })

  it('resolves aliases case-insensitively', () => {
    expect(languageOf('TypeScript')).toBe('ts')
    expect(languageOf(' Shell ')).toBe('shell')
    expect(languageOf('YML')).toBe('yaml')
    expect(languageOf('nope')).toBeUndefined()
  })

  it('returns nothing for empty code', () => {
    expect(highlight('', 'js')).toEqual([])
  })

  it('leaves a block over 100 000 characters as one plain token', () => {
    const code = 'const a = 1\n'.repeat(9000)
    expect(code.length).toBeGreaterThan(100_000)
    expect(highlight(code, 'js')).toEqual([{ text: code }])
    const under = 'const a = 1\n'.repeat(8000)
    expect(highlight(under, 'js').length).toBeGreaterThan(1)
  })

  it('stays linear on hostile input', () => {
    // Each pattern aims at the families it could make quadratic: an unclosed
    // opener rescanned at every later position. At 50 000 characters a
    // quadratic rule costs minutes; a linear one, tens of milliseconds. The
    // bound is loose on purpose — it separates those two, not fast from slow.
    const fill = (unit: string) => unit.repeat(Math.ceil(50_000 / unit.length))
    const cases: [string, string[]][] = [
      [fill('/*'), ['js', 'css', 'sql']],
      [fill('"'), ['js', 'python', 'sh', 'pwsh', 'json', 'yaml', 'toml', 'sql']],
      [fill("'a"), ['rust', 'sh', 'pwsh', 'cpp', 'python']],
      [fill('- x '), ['yaml']],
      [fill('- "x '), ['yaml']],
      [fill('[a['), ['pwsh', 'toml']],
      [fill('<a b="'), ['html', 'jsx']],
      [fill('&a'), ['html']],
      [fill('r#"'), ['rust']],
      [fill('R"('), ['cpp']],
      [fill('\\'), ['sh', 'pwsh']],
      [fill('a b('), ['js', 'python', 'sql', 'css', 'pwsh']],
    ]
    const started = performance.now()
    for (const [code, langs] of cases) {
      for (const lang of langs) expect(join(highlight(code, lang))).toBe(code)
    }
    expect(performance.now() - started).toBeLessThan(15_000)
  })
})
