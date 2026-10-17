# Word (.docx)

## Build spec

```json
{
  "title": "Quarterly Report",
  "pageSize": "A4",
  "body": [
    {"heading": "Summary", "level": 1},
    {"paragraph": "Plain text. A \n inside text is a line break, a \t a tab."},
    {"paragraph": [{"text": "Revenue rose "}, {"text": "12%", "bold": true}, {"text": " this year.", "italic": true}]},
    {"bullets": ["First point", [{"text": "Second, ", "underline": true}, {"text": "with runs"}]]},
    {"numbered": ["Step one", "Step two"]},
    {"table": {"header": ["Region", "Total"], "rows": [["North", 1200], ["South", 950]]}},
    {"pageBreak": true}
  ]
}
```

- `title` is shown first in the Title style and stored as the document title.
- `pageSize` is `A4` (default) or `Letter`; margins are one inch.
- `heading` levels 1-3 use the Heading1-3 styles, so Word's navigation pane and a table of contents see them.
- Each `numbered` block restarts at 1. All `bullets` blocks share one bullet list.
- Tables get equal column widths, grid borders, a bold header row repeated on every page, and right-aligned numbers. A cell is a string or a number: format a number as text ("1,200.00") when its look matters.
- Unknown keys are refused, and the error names the path, such as `spec.body[5].table.rows[1][0]`.

## What `read` shows

```
[Title] Quarterly Report
[Heading1] Summary
[Normal] Revenue rose **12%** *this year.*
[ListParagraph, list 2 level 0] Step one
[table: 3 rows x 2 columns]
| **Region** | **Total** |
| North | 1200 |
```

Each paragraph starts with its style id and, for list items, the list (numId) and level. Marks are **bold**, *italic*, `<u>underline</u>` and `~~deleted~~` (tracked deletions). A style id that styles.xml does not define is flagged, because Word silently shows such a paragraph as Normal.

## Parts after `unpack`

| part | holds |
|---|---|
| `word/document.xml` | the body: `w:p` paragraphs and `w:tbl` tables, then `w:sectPr` (page size, margins) last |
| `word/styles.xml` | style definitions, by `w:styleId` |
| `word/numbering.xml` | list definitions: every `w:abstractNum` first, then the `w:num` entries |
| `word/_rels/document.xml.rels` | links from the body to styles, numbering, images, headers |
| `[Content_Types].xml` | the content type of every part |
| `docProps/core.xml` | title and author |

## Editing recipes

A paragraph:

```xml
<w:p>
  <w:pPr><w:pStyle w:val="Heading2"/></w:pPr>
  <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Bold text </w:t></w:r>
  <w:r><w:t>then plain</w:t></w:r>
</w:p>
```

- Change text inside `<w:t>`. Word often splits a phrase across runs (spelling marks, revisions): search for one distinctive word, not the whole sentence, and keep each run's `<w:rPr>`.
- Add a paragraph by copying a neighbour of the same kind and changing its text, so it keeps the right style.
- In text, write `&` `<` `>` as `&amp;` `&lt;` `&gt;`. A `<w:t>` whose text starts or ends with a space needs `xml:space="preserve"`.
- Children of `<w:rPr>` go in schema order: `w:rStyle`, `w:rFonts`, `w:b`, `w:i`, `w:strike`, `w:color`, `w:sz`, `w:highlight`, `w:u`. Children of `<w:pPr>`: `w:pStyle`, `w:keepNext`, `w:pageBreakBefore`, `w:numPr`, `w:spacing`, `w:ind`, `w:jc`, then `w:rPr`. Word "repairs" a file whose order is wrong.
- A list item: `<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>`, with a numId that exists in numbering.xml.
- A page break: `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`.
- Every `<w:tc>` holds at least one `<w:p>`, even an empty one. A new column needs a `<w:gridCol>` in `<w:tblGrid>` and a `<w:tc>` in every `<w:tr>`.
- `<w:sectPr>` stays the last child of `<w:body>`.

## Traps

- Tracked changes (`w:ins`, `w:del`) survive edits. To accept one, delete the `w:del` element and unwrap the `w:ins` (keep its runs).
- Fields (table of contents, page numbers) show their stored result until Word updates fields.
- Pack checks the main content type against the output extension: pack a .dotx or .docm back to the same extension.
- Word substitutes fonts that are not installed; keep the default fonts unless the user asks for others.
