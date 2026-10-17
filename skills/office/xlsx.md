# Excel (.xlsx)

## Build spec

```json
{"sheets": [{
  "name": "Sales",
  "boldHeader": true,
  "freezeHeader": true,
  "columnWidths": [18, 12, 14],
  "rows": [
    ["Region", "Total", "As of"],
    ["North", 1200, {"date": "2026-10-18"}],
    ["South", {"value": 950.5, "format": "#,##0.00"}, null],
    ["Sum", {"formula": "SUM(B2:B3)", "value": 2150.5}, true]
  ]
}]}
```

A cell is a string, a number, a boolean, `null` (empty), or an object:

- `{"formula": "SUM(B2:B3)", "value"?: cached, "format"?}`: no leading `=` (one is stripped). Use A1 references, English function names and commas between arguments; the file stores formulas that way whatever the user's locale. Another sheet is `'Other Sheet'!A1`.
- `{"value": 950.5, "format": "#,##0.00"}`: a number (or string) with an Excel number format, such as `0`, `0.00`, `#,##0`, `0%`, `0.00%`, `"$"#,##0.00`. A percentage is a fraction: 0.12 with `0%` shows 12%.
- `{"date": "YYYY-MM-DD", "format"?}`: stored as Excel's date number, shown as `yyyy-mm-dd` unless you give a format.

Sheet options: `columnWidths` in characters (`null` keeps a column's default), `boldHeader` and `freezeHeader` for the first row. Sheet names have at most 31 characters, are unique, and contain none of `[ ] : * ? / \`.

**Formulas are not calculated by this helper.** Give `value`, the result, whenever you can compute it: `read` and programs that do not calculate see that value. Excel recalculates every formula on open (build sets `fullCalcOnLoad`). Without `value`, `read` shows `(no cached value)`; tell the user the cell fills in when the file is opened in Excel.

Keep numbers as numbers: write `1200`, not `"1,200"`, which is text that cannot be summed. Keep identifiers with leading zeros or more than 15 digits as strings.

## What `read` shows

```
== sheet 1: Sales
range A1:C4; frozen at A2; widths 1:18.0 2:12.0 3:14.0
A1 "Region"  {bold}
B2 1200
C2 46313 (= 2026-10-18)  {format yyyy-mm-dd}
B4 =SUM(B2:B3) [cached 2150.5]
```

Strings are quoted; a date shows its serial number and the date; a formula shows its cached value or `(no cached value)`.

## Parts after `unpack`

| part | holds |
|---|---|
| `xl/workbook.xml` | the sheet list (`name`, `sheetId`, `r:id`) and `calcPr` |
| `xl/_rels/workbook.xml.rels` | each `r:id` to `worksheets/sheetN.xml`, styles, shared strings |
| `xl/worksheets/sheetN.xml` | the cells, in `sheetData` |
| `xl/sharedStrings.xml` | the text of `t="s"` cells, by index |
| `xl/styles.xml` | `numFmts`, `fonts`, `fills`, `borders`, `cellXfs` |

## Editing recipes

Cells in `sheetData`:

```xml
<row r="2">
  <c r="A2" t="s"><v>0</v></c>
  <c r="B2"><v>1200</v></c>
  <c r="C2" t="inlineStr"><is><t>New text</t></is></c>
  <c r="D2"><f>SUM(B2:C2)</f></c>
</row>
```

- `t="s"` points at shared string 0; a plain `<v>` is a number; a formula without `<v>` has no cached value.
- Add text as `t="inlineStr"`: no shared-string bookkeeping.
- Rows go in ascending `r`, cells within a row in column order, and each cell's `r` matches its row.
- After changing a value that formulas use, delete the `<v>` of the formula cells that depend on it, or they show stale results in programs that do not calculate.
- Worksheet children keep this order: `sheetPr`, `dimension`, `sheetViews`, `sheetFormatPr`, `cols`, `sheetData`, `mergeCells`, `conditionalFormatting`, `dataValidations`, `hyperlinks`, `pageMargins`, `pageSetup`.
- Merge cells with `<mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>` right after `sheetData`.
- `s="N"` on a cell is an index into `cellXfs`. For a new format, add `<numFmt numFmtId="165" formatCode="0.0%"/>` (ids from 164), an `<xf>` that uses it, and update both `count` attributes.
- In `styles.xml` the first two fills (`none`, then `gray125`) are reserved by Excel: keep them.
- A new sheet needs its part, a `<sheet>` in workbook.xml with a new `sheetId` and `r:id`, the relationship, and an `Override` in `[Content_Types].xml`. Pack checks that they agree.

## Traps

- Reading a CSV: honour quoted fields (commas and line breaks inside quotes) and keep leading zeros.
- A date typed as a string is only text; use `{"date": ...}`.
- A misspelled function shows `#NAME?` in Excel; `read` cannot see that, since nothing here calculates. Double-check function names.
