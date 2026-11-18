// @ts-check
/**
 * Syntax highlighting for the browser's code blocks: `highlight(code, lang)`
 * cuts `code` into tokens whose texts concatenate back to exactly `code`, each
 * with an optional kind the stylesheet colours. A tokenizer per language
 * FAMILY (C-like, Python, shell, PowerShell, markup, data, SQL, diff), not a
 * parser: a token is wrong now and then, a byte is never lost or invented.
 *
 * Three rules hold every family to that:
 * - every rule is a sticky regex that either matches at the cursor or not, and
 *   none has nested ambiguous quantifiers, so a hostile line costs linear time;
 * - an unclosed string or comment runs to its natural end (the line, or the
 *   input) instead of failing and being retried at every later position;
 * - nothing here builds markup: the caller makes one text node per token, so a
 *   kind is a class name and a token's text is never interpreted.
 *
 * Plain ES module shipped without a build step; no imports, no DOM.
 */

/**
 * @typedef {'comment'|'string'|'number'|'keyword'|'function'|'constant'|'type'|'property'|'operator'|'punctuation'|'inserted'|'deleted'|'meta'} Kind
 * @typedef {{ text: string, kind?: Kind }} Token
 */

/**
 * What a rule may read besides the text at the cursor.
 * @typedef {object} State
 * @property {string} prev the last significant token: not whitespace, not a comment
 * @property {boolean} bol only whitespace since the start of the line
 * @property {number} depth `{` nesting, for CSS
 */

/**
 * @typedef {object} Rule
 * @property {RegExp} re sticky (`y`): it matches at the cursor or not at all
 * @property {Kind | ((text: string, code: string, end: number, st: State) => Kind | undefined)} [kind]
 * @property {(code: string, pos: number, st: State) => boolean} [when]
 */

/** Past this many characters a block is one plain token: highlighting is a nicety, not worth a stall. */
const MAX_CODE = 100_000

/**
 * @param {Token[]} out
 * @param {string} text
 * @param {Kind | undefined} kind
 */
function push(out, text, kind) {
  if (text === '') return
  const last = out[out.length - 1]
  if (last !== undefined && last.kind === kind) last.text += text
  else out.push(kind === undefined ? { text } : { text, kind })
}

const WHITESPACE_ONLY = /^\s+$/

/**
 * @param {State} st
 * @param {string} text
 * @param {Kind | undefined} kind
 */
function advance(st, text, kind) {
  if (WHITESPACE_ONLY.test(text)) {
    if (text.includes('\n')) st.bol = true
    return
  }
  st.bol = false
  if (kind === 'comment') return
  st.prev = text
  if (text === '{') st.depth++
  else if (text === '}') st.depth = Math.max(0, st.depth - 1)
}

/**
 * The engine every rule-table family shares: at each position the first rule
 * that matches a non-empty text wins; if none does, one character is plain.
 * @param {string} code
 * @param {readonly Rule[]} rules
 * @returns {Token[]}
 */
function tokenize(code, rules) {
  /** @type {Token[]} */
  const out = []
  /** @type {State} */
  const st = { prev: '', bol: true, depth: 0 }
  let pos = 0
  while (pos < code.length) {
    let matched = false
    for (const rule of rules) {
      if (rule.when !== undefined && !rule.when(code, pos, st)) continue
      rule.re.lastIndex = pos
      const m = rule.re.exec(code)
      if (m === null || m[0] === '') continue
      const text = m[0]
      const end = pos + text.length
      const kind = typeof rule.kind === 'function' ? rule.kind(text, code, end, st) : rule.kind
      push(out, text, kind)
      advance(st, text, kind)
      pos = end
      matched = true
      break
    }
    if (!matched) {
      const ch = code.charAt(pos)
      push(out, ch, undefined)
      advance(st, ch, undefined)
      pos++
    }
  }
  return out
}

/**
 * The next character after `end` past spaces and tabs on the same line.
 * @param {string} code
 * @param {number} end
 */
function nextNonSpace(code, end) {
  let i = end
  while (code.charAt(i) === ' ' || code.charAt(i) === '\t') i++
  return code.charAt(i)
}

/** @param {string} code @param {number} pos */
const afterSpace = (code, pos) => pos === 0 || /\s/.test(code.charAt(pos - 1))

/** @param {string} words */
const set = (words) => new Set(words.split(/\s+/).filter(Boolean))

// ---------------------------------------------------------------------------
// Shared rules
// ---------------------------------------------------------------------------

/** @type {Rule} */
const SPACE = { re: /\s+/y }
/** @type {Rule} */
const LINE_COMMENT = { re: /\/\/[^\n]*/y, kind: 'comment' }
/** @type {Rule} */
const BLOCK_COMMENT = { re: /\/\*[\s\S]*?(?:\*\/|$)/y, kind: 'comment' }
/** @type {Rule} */
const HASH_COMMENT = { re: /#[^\n]*/y, kind: 'comment' }
/** @type {Rule} */
const DQ_STRING = { re: /"(?:[^"\\\n]|\\[\s\S])*"?/y, kind: 'string' }
/** @type {Rule} */
const SQ_STRING = { re: /'(?:[^'\\\n]|\\[\s\S])*'?/y, kind: 'string' }
/** @type {Rule} */
const NUMBER = {
  re: /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.\d[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)[A-Za-z_\d]*/y,
  kind: 'number',
}
/** @type {Rule} */
const OPERATOR = { re: /[+\-*/%=<>!&|^~?:]+/y, kind: 'operator' }
/** @type {Rule} */
const PUNCTUATION = { re: /[()[\]{},;.]/y, kind: 'punctuation' }

const FN_DECL = set('function def fn func sub')
const TYPE_DECL = set('class struct interface enum trait type impl union record')
const MEMBER = set('. ?. ->')

/**
 * The C-like word classifier: keyword sets first, then the shape of the word
 * and its neighbours — a call, a declaration, a member, a PascalCase type.
 * @param {{ keywords: Set<string>, constants: Set<string>, types?: Set<string>, macros?: boolean }} lang
 * @returns {(text: string, code: string, end: number, st: State) => Kind | undefined}
 */
function cWord(lang) {
  return (text, code, end, st) => {
    if (lang.keywords.has(text)) return 'keyword'
    if (lang.constants.has(text)) return 'constant'
    if (lang.types !== undefined && lang.types.has(text)) return 'type'
    if (FN_DECL.has(st.prev)) return 'function'
    if (TYPE_DECL.has(st.prev)) return 'type'
    const next = nextNonSpace(code, end)
    if (next === '(' || (lang.macros === true && code.charAt(end) === '!' && code.charAt(end + 1) !== '=')) return 'function'
    if (MEMBER.has(st.prev)) return 'property'
    if (/^[A-Z][A-Z\d_]+$/.test(text)) return 'constant'
    if (/^[A-Z]/.test(text)) return 'type'
    return undefined
  }
}

const IDENT = /[\p{L}_$][\p{L}\p{N}_$]*/uy

/**
 * @param {{ keywords: string, constants: string, types?: string, macros?: boolean }} spec
 * @param {readonly Rule[]} strings the family's string and literal rules, tried before words
 * @param {readonly Rule[]} [extra] rules tried before everything but whitespace and comments
 * @returns {Rule[]}
 */
function cLike(spec, strings, extra = []) {
  const word = cWord({
    keywords: set(spec.keywords),
    constants: set(spec.constants),
    ...(spec.types === undefined ? {} : { types: set(spec.types) }),
    ...(spec.macros === undefined ? {} : { macros: spec.macros }),
  })
  return [SPACE, LINE_COMMENT, BLOCK_COMMENT, ...extra, ...strings, NUMBER, { re: IDENT, kind: word }, OPERATOR, PUNCTUATION]
}

// ---------------------------------------------------------------------------
// C-like languages
// ---------------------------------------------------------------------------

const JS_KEYWORDS =
  'break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield async await of static get set from as'
const JS_CONSTANTS = 'true false null undefined NaN Infinity'
const TS_KEYWORDS = `${JS_KEYWORDS} interface type enum implements namespace declare abstract private protected public readonly keyof infer is satisfies override module asserts unique`
const TS_TYPES = 'string number boolean any unknown never object symbol bigint'

/** @type {Rule} */
const TEMPLATE = { re: /`(?:[^`\\]|\\[\s\S])*`?/y, kind: 'string' }
/** @type {Rule} */
const DECORATOR = { re: /@[\p{L}_$][\p{L}\p{N}_$.]*/uy, kind: 'meta' }
/**
 * A JSX tag opener: `<` or `</` before a name. The name that follows reads as
 * a type through `prev`, which is rough (a `<` comparison before a word does
 * the same) and harmless.
 * @type {Rule}
 */
const JSX_TAG = { re: /<\/?(?=[A-Za-z])/y, kind: 'punctuation' }
/** @type {Rule} */
const JSX_NAME = { re: /[A-Za-z][\w.-]*/y, kind: 'type', when: (_code, _pos, st) => st.prev === '<' || st.prev === '</' }

const JS = cLike({ keywords: JS_KEYWORDS, constants: JS_CONSTANTS }, [DQ_STRING, SQ_STRING, TEMPLATE], [DECORATOR])
const TS = cLike({ keywords: TS_KEYWORDS, constants: JS_CONSTANTS, types: TS_TYPES }, [DQ_STRING, SQ_STRING, TEMPLATE], [DECORATOR])
const JSX = cLike({ keywords: JS_KEYWORDS, constants: JS_CONSTANTS }, [DQ_STRING, SQ_STRING, TEMPLATE], [DECORATOR, JSX_TAG, JSX_NAME])
const TSX = cLike({ keywords: TS_KEYWORDS, constants: JS_CONSTANTS, types: TS_TYPES }, [DQ_STRING, SQ_STRING, TEMPLATE], [DECORATOR, JSX_TAG, JSX_NAME])

const RUST = cLike(
  {
    keywords:
      'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while macro_rules',
    constants: 'true false None Some Ok Err',
    types: 'i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box',
    macros: true,
  },
  [
    DQ_STRING,
    { re: /r#*"[\s\S]*?(?:"#*|$)/y, kind: 'string' },
    // A char literal must close; an unclosed quote is a lifetime (`'a`).
    { re: /'(?:[^'\\\n]|\\[^\n]{1,10}?)'/y, kind: 'string' },
    { re: /'[A-Za-z_]\w*/y, kind: 'type' },
  ],
  [{ re: /#!?\[[^\]\n]*\]?/y, kind: 'meta' }],
)

const GO = cLike(
  {
    keywords:
      'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
    constants: 'true false nil iota',
    types:
      'bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any',
  },
  [DQ_STRING, SQ_STRING, { re: /`[^`]*`?/y, kind: 'string' }],
)

const JAVA = cLike(
  {
    keywords:
      'abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try volatile while var record sealed permits yield',
    constants: 'true false null',
    types: 'boolean byte char double float int long short void String Object',
  },
  [{ re: /"""[\s\S]*?(?:"""|$)/y, kind: 'string' }, DQ_STRING, SQ_STRING],
  [DECORATOR],
)

/** @type {Rule} */
const PREPROCESSOR = { re: /#[ \t]*[A-Za-z]+[^\n]*/y, kind: 'meta', when: (_code, _pos, st) => st.bol }
const C_KEYWORDS =
  'auto break case const continue default do else enum extern for goto if inline register restrict return signed sizeof static struct switch typedef union unsigned volatile while'
const C_TYPES = 'int char float double void long short bool size_t ssize_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t FILE'

const C = cLike({ keywords: C_KEYWORDS, constants: 'NULL true false', types: C_TYPES }, [DQ_STRING, SQ_STRING], [PREPROCESSOR])
const CPP = cLike(
  {
    keywords: `${C_KEYWORDS} alignas alignof catch class concept const_cast consteval constexpr constinit co_await co_return co_yield decltype delete dynamic_cast explicit export friend mutable namespace new noexcept operator private protected public reinterpret_cast requires static_assert static_cast template this thread_local throw try typeid typename using virtual override final`,
    constants: 'nullptr NULL true false',
    types: `${C_TYPES} std string vector auto wchar_t char8_t char16_t char32_t`,
  },
  [{ re: /R"([^(\s]{0,16})\([\s\S]*?(?:\)\1"|$)/y, kind: 'string' }, DQ_STRING, SQ_STRING],
  [PREPROCESSOR],
)
const CS = cLike(
  {
    keywords:
      'abstract as base break case catch checked class const continue default delegate do else enum event explicit extern finally fixed for foreach goto if implicit in interface internal is lock namespace new operator out override params private protected public readonly ref return sealed sizeof stackalloc static struct switch this throw try typeof unchecked unsafe using virtual volatile while var async await record init get set value yield where when nameof',
    constants: 'true false null',
    types: 'bool byte char decimal double float int long object sbyte short string uint ulong ushort void dynamic',
  },
  [{ re: /\$?@"(?:[^"]|"")*"?/y, kind: 'string' }, { re: /\$"(?:[^"\\\n]|\\[\s\S])*"?/y, kind: 'string' }, DQ_STRING, SQ_STRING],
  [PREPROCESSOR],
)

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PY_KEYWORDS = set(
  'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self cls',
)
const PY_CONSTANTS = set('True False None NotImplemented Ellipsis')
const PY_TYPES = set('int str float list dict set tuple bool bytes object type complex frozenset bytearray')

/** @type {Rule[]} */
const PYTHON = [
  SPACE,
  HASH_COMMENT,
  { re: /(?:[rRbBuUfF]{1,2})?(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$))/y, kind: 'string' },
  { re: /(?:[rRbBuUfF]{1,2})?(?:"(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\\\n]|\\[\s\S])*'?)/y, kind: 'string' },
  { re: /@[\p{L}_][\p{L}\p{N}_.]*/uy, kind: 'meta', when: (_code, _pos, st) => st.bol },
  NUMBER,
  {
    re: /[\p{L}_][\p{L}\p{N}_]*/uy,
    kind: (text, code, end, st) => {
      if (PY_KEYWORDS.has(text)) return 'keyword'
      if (PY_CONSTANTS.has(text)) return 'constant'
      if (st.prev === 'def') return 'function'
      if (st.prev === 'class') return 'type'
      if (nextNonSpace(code, end) === '(') return 'function'
      if (PY_TYPES.has(text)) return 'type'
      if (st.prev === '.') return 'property'
      if (/^[A-Z][A-Z\d_]+$/.test(text)) return 'constant'
      if (/^[A-Z]/.test(text)) return 'type'
      return undefined
    },
  },
  { re: /[+\-*/%=<>!&|^~@:]+/y, kind: 'operator' },
  PUNCTUATION,
]

// ---------------------------------------------------------------------------
// Shell and PowerShell
// ---------------------------------------------------------------------------

const SH_KEYWORDS = set('if then else elif fi for while until do done case esac in function select time return exit export local readonly declare unset break continue')
/** Where a word is a command: the start of a line or after a separator or a keyword that opens a body. */
const SH_COMMAND_AFTER = set('| || && ; ;; ( { ! $( ` then do else elif time')

/** @type {Rule[]} */
const SHELL = [
  SPACE,
  { re: /#[^\n]*/y, kind: 'comment', when: afterSpace },
  // An escaped character is one plain unit: `\"` must not open a string.
  { re: /\\[\s\S]/y },
  { re: /\$'(?:[^'\\]|\\[\s\S])*'?/y, kind: 'string' },
  { re: /'[^']*'?/y, kind: 'string' },
  { re: /"(?:[^"\\]|\\[\s\S])*"?/y, kind: 'string' },
  { re: /`[^`]*`?/y, kind: 'string' },
  { re: /\$\(/y, kind: 'punctuation' },
  { re: /\$(?:\{[^}\n]*\}?|[A-Za-z_]\w*|[0-9@#?*$!-])/y, kind: 'property' },
  { re: /[A-Za-z_]\w*(?==)/y, kind: 'property' },
  { re: /--?[A-Za-z][\w-]*/y, kind: 'constant', when: afterSpace },
  {
    re: /[^\s|&;()<>"'`$#\\=]+/y,
    kind: (text, _code, _end, st) => {
      if (SH_KEYWORDS.has(text)) return 'keyword'
      if (/^\d+$/.test(text)) return 'number'
      if (st.bol || SH_COMMAND_AFTER.has(st.prev)) return 'function'
      return undefined
    },
  },
  { re: /[|&;<>!=]+|[(){}]/y, kind: 'operator' },
]

const PS_KEYWORDS = set(
  'begin break catch class continue data define do dynamicparam else elseif end enum exit filter finally for foreach from function hidden if in param process return static switch throw trap try until using var while workflow',
)
const PS_OPERATORS = set(
  'eq ne gt ge lt le like notlike match notmatch contains notcontains in notin replace and or not xor band bor bxor bnot split join is isnot as f ceq cne clike cmatch ieq ine ilike imatch shl shr',
)
const PS_CONSTANTS = set('$true $false $null')

/** @type {Rule[]} */
const PWSH = [
  SPACE,
  { re: /<#[\s\S]*?(?:#>|$)/y, kind: 'comment' },
  HASH_COMMENT,
  { re: /@"[\s\S]*?(?:\n"@|$)/y, kind: 'string' },
  { re: /@'[\s\S]*?(?:\n'@|$)/y, kind: 'string' },
  { re: /"(?:[^"`]|`[\s\S]|"")*"?/y, kind: 'string' },
  { re: /'(?:[^']|'')*'?/y, kind: 'string' },
  {
    re: /\$(?:\{[^}\n]*\}?|[A-Za-z_]\w*(?::[A-Za-z_]\w*)?|[$?^_])/y,
    kind: (text) => (PS_CONSTANTS.has(text.toLowerCase()) ? 'constant' : 'property'),
  },
  { re: /\[[A-Za-z_][\w.]*(?:\[[\w.,\s]*\])?\]/y, kind: 'type' },
  NUMBER,
  {
    re: /-[A-Za-z][\w]*/y,
    when: (code, pos) => pos === 0 || /[\s(,|]/.test(code.charAt(pos - 1)),
    kind: (text) => (PS_OPERATORS.has(text.slice(1).toLowerCase()) ? 'operator' : 'constant'),
  },
  {
    re: /[A-Za-z_][\w]*(?:-[A-Za-z][\w]*)*/y,
    kind: (text, code, end, st) => {
      const lower = text.toLowerCase()
      if (PS_KEYWORDS.has(lower)) return 'keyword'
      if (text.includes('-')) return 'function'
      if (st.prev === '.' || st.prev === '::') return nextNonSpace(code, end) === '(' ? 'function' : 'property'
      if (st.bol || SH_COMMAND_AFTER.has(st.prev) || st.prev === '{') return 'function'
      return undefined
    },
  },
  { re: /::|[+\-*/%=<>!&|]+/y, kind: 'operator' },
  PUNCTUATION,
]

// ---------------------------------------------------------------------------
// Data languages
// ---------------------------------------------------------------------------

/** @type {Rule[]} */
const JSON_RULES = [
  SPACE,
  LINE_COMMENT,
  BLOCK_COMMENT,
  { re: /"(?:[^"\\\n]|\\[\s\S])*"?/y, kind: (_text, code, end) => (nextNonSpace(code, end) === ':' ? 'property' : 'string') },
  { re: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, kind: 'number' },
  { re: /true|false|null/y, kind: 'constant' },
  { re: /[{}[\],:]/y, kind: 'punctuation' },
]

const YAML_CONSTANTS = set('true false null yes no on off True False Null TRUE FALSE NULL ~')
/** @param {string} _code @param {number} _pos @param {State} st */
const yamlKeyPosition = (_code, _pos, st) => st.bol || st.prev === '-' || st.prev === '?'

/** @type {Rule[]} */
const YAML = [
  SPACE,
  { re: /#[^\n]*/y, kind: 'comment', when: afterSpace },
  { re: /(?:---|\.\.\.)(?=\s|$)/y, kind: 'meta', when: (_code, _pos, st) => st.bol },
  // A key is tried only where one can start, and a plain key is at most 200
  // characters: a line of `- x - x …` would otherwise rescan to its end at
  // every `-`.
  {
    re: /(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\n]|'')*'|[^\s#'"\-[\]{},:][^\n:]{0,200}?)(?=:(?:[ \t\n]|$))/y,
    kind: 'property',
    when: yamlKeyPosition,
  },
  { re: /"(?:[^"\\]|\\[\s\S])*"?/y, kind: 'string' },
  { re: /'(?:[^']|'')*'?/y, kind: 'string' },
  { re: /[&*][\w-]+/y, kind: 'meta', when: afterSpace },
  { re: /!!?[\w-]*/y, kind: 'type', when: afterSpace },
  { re: /-(?=[ \t\n]|$)/y, kind: 'punctuation' },
  {
    re: /[^\s#,[\]{}:]+(?::[^\s#,[\]{}:]+)*/y,
    kind: (text) => {
      if (YAML_CONSTANTS.has(text)) return 'constant'
      if (/^[-+]?(?:\d[\d_]*(?:\.\d*)?(?:[eE][-+]?\d+)?|0x[\da-fA-F]+|\.inf|\.nan)$/i.test(text)) return 'number'
      return undefined
    },
  },
  { re: /[:,[\]{}|>]/y, kind: 'punctuation' },
]

/** @type {Rule[]} */
const TOML = [
  SPACE,
  HASH_COMMENT,
  { re: /\[\[?[^\]\n]*\]{0,2}/y, kind: 'type', when: (_code, _pos, st) => st.bol },
  { re: /"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)/y, kind: 'string' },
  { re: /"(?:[^"\\\n]|\\[\s\S])*"?|'[^'\n]*'?/y, kind: 'string' },
  { re: /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?/y, kind: 'number' },
  { re: /[+-]?(?:0x[\da-fA-F_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|inf|nan)(?![\w-])/y, kind: 'number' },
  {
    re: /[A-Za-z_][\w-]*/y,
    kind: (text, code, end) => {
      if (text === 'true' || text === 'false') return 'constant'
      const next = nextNonSpace(code, end)
      return next === '=' || next === '.' ? 'property' : undefined
    },
  },
  { re: /=/y, kind: 'operator' },
  { re: /[[\]{},.]/y, kind: 'punctuation' },
]

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

/** @param {string} _code @param {number} _pos @param {State} st */
const inBlock = (_code, _pos, st) => st.depth > 0
/** @param {string} _code @param {number} _pos @param {State} st */
const atSelector = (_code, _pos, st) => st.depth === 0

/** @type {Rule[]} */
const CSS = [
  SPACE,
  BLOCK_COMMENT,
  DQ_STRING,
  SQ_STRING,
  { re: /@[\w-]+/y, kind: 'keyword' },
  { re: /!important/y, kind: 'keyword' },
  { re: /#[\da-fA-F]{3,8}(?![\w-])/y, kind: 'number', when: inBlock },
  { re: /[.#][A-Za-z_-][\w-]*/y, kind: 'type', when: atSelector },
  { re: /::?[A-Za-z-]+/y, kind: 'keyword', when: atSelector },
  { re: /-?(?:\d+(?:\.\d+)?|\.\d+)(?:%|[A-Za-z]+)?/y, kind: 'number' },
  {
    re: /-{0,2}[A-Za-z_][\w-]*/y,
    kind: (_text, code, end, st) => {
      if (nextNonSpace(code, end) === '(') return 'function'
      if (st.depth === 0) return 'keyword'
      if ((st.prev === '{' || st.prev === ';') && nextNonSpace(code, end) === ':') return 'property'
      return undefined
    },
  },
  { re: /[{}();:,]/y, kind: 'punctuation' },
  { re: /[>+~*=|^$]/y, kind: 'operator' },
]

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const SQL_KEYWORDS = set(
  'select from where and or not insert into values update set delete create table drop alter add column index view join inner left right outer full cross on as group by order having limit offset union all distinct case when then else end is null in exists between like ilike primary key foreign references unique default check constraint if begin commit rollback transaction returning with recursive asc desc database schema grant revoke trigger procedure function return returns declare cast',
)
const SQL_TYPES = set('int integer bigint smallint tinyint serial bigserial real double float decimal numeric varchar char text boolean bool date time timestamp timestamptz interval json jsonb uuid blob bytea')
const SQL_CONSTANTS = set('true false null current_date current_time current_timestamp')

/** @type {Rule[]} */
const SQL = [
  SPACE,
  { re: /--[^\n]*/y, kind: 'comment' },
  BLOCK_COMMENT,
  { re: /'(?:[^']|'')*'?/y, kind: 'string' },
  { re: /"(?:[^"]|"")*"?|`[^`]*`?/y, kind: 'property' },
  NUMBER,
  {
    re: /[A-Za-z_][\w$]*/y,
    kind: (text, code, end) => {
      const lower = text.toLowerCase()
      if (SQL_CONSTANTS.has(lower)) return 'constant'
      if (SQL_TYPES.has(lower)) return 'type'
      if (SQL_KEYWORDS.has(lower)) return 'keyword'
      if (nextNonSpace(code, end) === '(') return 'function'
      return undefined
    },
  },
  { re: /[+\-*/%=<>!|&^~:]+/y, kind: 'operator' },
  PUNCTUATION,
]

// ---------------------------------------------------------------------------
// Line- and state-driven families: diff, console, markup
// ---------------------------------------------------------------------------

const DIFF_META = /^(?:diff |index |@@|\+\+\+ |--- |\+\+\+$|---$|new file|deleted file|similarity |rename |old mode|new mode|Binary files )/

/**
 * Whole lines: `+` inserted, `-` deleted, headers and hunk ranges meta. The
 * newline that ends a line stays plain, so a coloured background never runs
 * past its line.
 * @param {string} code
 * @returns {Token[]}
 */
function diff(code) {
  /** @type {Token[]} */
  const out = []
  const lines = code.split('\n')
  lines.forEach((line, index) => {
    if (index > 0) push(out, '\n', undefined)
    const kind = DIFF_META.test(line) ? 'meta' : line.startsWith('+') ? 'inserted' : line.startsWith('-') ? 'deleted' : undefined
    push(out, line, kind)
  })
  return out
}

const PROMPT = /^(?:PS [^>\n]*> ?|[$%>] |\$$)/

/**
 * A terminal transcript: a line that starts with a prompt is the prompt
 * (meta) and a shell command; any other line is output and stays plain.
 * @param {string} code
 * @returns {Token[]}
 */
function consoleSession(code) {
  /** @type {Token[]} */
  const out = []
  const lines = code.split('\n')
  lines.forEach((line, index) => {
    if (index > 0) push(out, '\n', undefined)
    const prompt = PROMPT.exec(line)
    if (prompt === null) {
      push(out, line, undefined)
      return
    }
    push(out, prompt[0], 'meta')
    const rules = prompt[0].startsWith('PS ') ? PWSH : SHELL
    for (const token of tokenize(line.slice(prompt[0].length), rules)) push(out, token.text, token.kind)
  })
  return out
}

/**
 * HTML and XML: tags, attributes and values; comments, doctype and processing
 * instructions; entities. Text between tags is plain, and so is the content
 * of `<script>` and `<style>` — roughly, as promised.
 * @param {string} code
 * @returns {Token[]}
 */
function markup(code) {
  /** @type {Token[]} */
  const out = []
  const n = code.length
  let pos = 0
  /** @param {string} close @param {number} from */
  const upTo = (close, from) => {
    const at = code.indexOf(close, from)
    return at < 0 ? n : at + close.length
  }
  while (pos < n) {
    if (code.startsWith('<!--', pos)) {
      const end = upTo('-->', pos + 4)
      push(out, code.slice(pos, end), 'comment')
      pos = end
      continue
    }
    if (code.startsWith('<![CDATA[', pos)) {
      const end = upTo(']]>', pos + 9)
      push(out, code.slice(pos, end), 'string')
      pos = end
      continue
    }
    const ch = code.charAt(pos)
    const next = code.charAt(pos + 1)
    if (ch === '<' && (next === '!' || next === '?')) {
      const end = upTo('>', pos + 2)
      push(out, code.slice(pos, end), 'meta')
      pos = end
      continue
    }
    if (ch === '<' && /[A-Za-z/]/.test(next)) {
      pos = tag(code, pos, out)
      continue
    }
    if (ch === '&') {
      ENTITY.lastIndex = pos
      const m = ENTITY.exec(code)
      if (m !== null) {
        push(out, m[0], 'constant')
        pos += m[0].length
        continue
      }
    }
    let end = pos + 1
    while (end < n && code.charAt(end) !== '<' && code.charAt(end) !== '&') end++
    push(out, code.slice(pos, end), undefined)
    pos = end
  }
  return out
}

const ENTITY = /&(?:#\d+|#[xX][\da-fA-F]+|[A-Za-z][\w]*);/y
const TAG_NAME = /[A-Za-z][\w:.-]*/y
const ATTR_NAME = /[^\s"'<>/=]+/y
const ATTR_VALUE = /"[^"]*"?|'[^']*'?|[^\s"'<>=`]+/y
const TAG_SPACE = /\s+/y

/**
 * One tag from its `<` to its `>` (or the end of the input).
 * @param {string} code
 * @param {number} start
 * @param {Token[]} out
 * @returns {number} the position after the tag
 */
function tag(code, start, out) {
  /** @param {RegExp} re @param {number} from */
  const at = (re, from) => {
    re.lastIndex = from
    const m = re.exec(code)
    return m === null ? '' : m[0]
  }
  let pos = start
  const open = code.charAt(pos + 1) === '/' ? '</' : '<'
  push(out, open, 'punctuation')
  pos += open.length
  const name = at(TAG_NAME, pos)
  push(out, name, 'keyword')
  pos += name.length
  while (pos < code.length) {
    const space = at(TAG_SPACE, pos)
    if (space !== '') {
      push(out, space, undefined)
      pos += space.length
      continue
    }
    if (code.startsWith('/>', pos)) {
      push(out, '/>', 'punctuation')
      return pos + 2
    }
    const ch = code.charAt(pos)
    if (ch === '>') {
      push(out, '>', 'punctuation')
      return pos + 1
    }
    if (ch === '<') return pos
    if (ch === '=') {
      push(out, '=', 'operator')
      pos++
      const value = at(ATTR_VALUE, pos)
      push(out, value, 'string')
      pos += value.length
      continue
    }
    const attr = at(ATTR_NAME, pos)
    if (attr !== '') {
      push(out, attr, 'property')
      pos += attr.length
      continue
    }
    // A stray quote or slash inside a tag: one plain character, so the loop always advances.
    push(out, ch, undefined)
    pos++
  }
  return pos
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/** @type {Record<string, (code: string) => Token[]>} */
const FAMILIES = {
  js: (code) => tokenize(code, JS),
  ts: (code) => tokenize(code, TS),
  jsx: (code) => tokenize(code, JSX),
  tsx: (code) => tokenize(code, TSX),
  json: (code) => tokenize(code, JSON_RULES),
  python: (code) => tokenize(code, PYTHON),
  shell: (code) => tokenize(code, SHELL),
  console: consoleSession,
  pwsh: (code) => tokenize(code, PWSH),
  rust: (code) => tokenize(code, RUST),
  go: (code) => tokenize(code, GO),
  java: (code) => tokenize(code, JAVA),
  c: (code) => tokenize(code, C),
  cpp: (code) => tokenize(code, CPP),
  cs: (code) => tokenize(code, CS),
  css: (code) => tokenize(code, CSS),
  markup,
  yaml: (code) => tokenize(code, YAML),
  toml: (code) => tokenize(code, TOML),
  sql: (code) => tokenize(code, SQL),
  diff,
}

/** Fence language names to families. */
const ALIASES = new Map(
  Object.entries({
    js: 'js',
    javascript: 'js',
    mjs: 'js',
    cjs: 'js',
    ts: 'ts',
    typescript: 'ts',
    mts: 'ts',
    cts: 'ts',
    jsx: 'jsx',
    tsx: 'tsx',
    json: 'json',
    jsonc: 'json',
    json5: 'json',
    py: 'python',
    python: 'python',
    python3: 'python',
    sh: 'shell',
    bash: 'shell',
    shell: 'shell',
    zsh: 'shell',
    console: 'console',
    'shell-session': 'console',
    ps1: 'pwsh',
    pwsh: 'pwsh',
    powershell: 'pwsh',
    rs: 'rust',
    rust: 'rust',
    go: 'go',
    golang: 'go',
    java: 'java',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    'c++': 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    cs: 'cs',
    csharp: 'cs',
    'c#': 'cs',
    css: 'css',
    html: 'markup',
    htm: 'markup',
    xml: 'markup',
    svg: 'markup',
    xhtml: 'markup',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    sql: 'sql',
    diff: 'diff',
    patch: 'diff',
  }),
)

/**
 * The family a fence language names, or undefined when it names none.
 * @param {string | undefined} lang
 * @returns {string | undefined}
 */
export function languageOf(lang) {
  if (typeof lang !== 'string') return undefined
  return ALIASES.get(lang.trim().toLowerCase())
}

/**
 * Cut `code` into tokens for `lang` (a fence language name or alias). The
 * texts always concatenate to exactly `code`; an unknown language, or a block
 * over 100 000 characters, is one plain token.
 * @param {string} code
 * @param {string | undefined} lang
 * @returns {Token[]}
 */
export function highlight(code, lang) {
  if (typeof code !== 'string' || code === '') return []
  const family = languageOf(lang)
  const run = family === undefined ? undefined : FAMILIES[family]
  if (run === undefined || code.length > MAX_CODE) return [{ text: code }]
  return run(code)
}
