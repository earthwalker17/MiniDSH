---
name: office
description: Create, read and edit Word (.docx), Excel (.xlsx) and PowerPoint (.pptx) files with a bundled Node helper, without Office, Python or LibreOffice. Use it when a task asks for a report, letter, spreadsheet, workbook or slide deck as an Office file, needs the text, tables, cells, formulas or slides inside one, or asks to change an existing one. It builds from a JSON spec, edits through unpack/pack of the XML parts, and verifies by reading the result back.
license: MIT
metadata:
  minidsh-reviewed: "2026-10-18"
  minidsh-verified-with: "pending live arc"
---

# Office files: .docx, .xlsx, .pptx

The helper `scripts/office.mjs` (Node 24+, no dependencies) builds, reads, unpacks and packs Office files. Run it by its absolute path, quoted, from your own working directory:

```
node "<this skill's directory>/scripts/office.mjs" <command> ...
```

`<this skill's directory>` is the folder holding this SKILL.md. Do not change into it and never write inside it: keep specs, your own scripts and outputs in the workspace, and name them for their task (`sales-report-spec.json`, `merge-quarters.js`).

## Start

1. Run `probe`. It reports whether a renderer (LibreOffice `soffice`) exists on this machine. Never suggest or use a tool the probe did not find.
2. Read the reference for the format you are producing or changing, and only that one:
   - Word: `docx.md`
   - Excel: `xlsx.md`
   - PowerPoint: `pptx.md`

## Commands

| command | what it does |
|---|---|
| `build <spec.json> <out>` | creates a .docx, .xlsx or .pptx from a JSON spec; the extension picks the format |
| `read <file> [--max-chars N]` | the content as text: paragraphs with style and **bold**/*italic* marks, tables; cells with values, formulas and cached values; slide titles, bodies, notes. It also lists package problems |
| `unpack <file> <dir>` | extracts the parts into a new or empty directory, XML re-indented so a file editor can change it |
| `pack <dir> <out>` | checks every part and writes a NEW package; on a problem it names the part, line and column and writes nothing |

The helper refuses to overwrite an existing output unless you pass `--force`. `build --help` prints the spec of every format. Exit codes: 2 usage, 3 missing input, 4 invalid spec, XML or package, 5 refused output, 6 unsupported file.

## Creating a file

Write the spec as a JSON file in the workspace and `build` it. Prefer `build` whenever the content fits a spec: it gets styles, numbering, the theme and the schema order of every part right, which is where hand-written Office XML fails. Compute numbers (totals, averages) yourself from the source data first, and put the results in the spec.

When the spec cannot express something (images, charts, merged cells, colours), build the closest file first, then edit it as below.

## Editing an existing file

1. `unpack original.docx work-dir`, into a directory that does not exist yet.
2. Change the XML parts with your file editor. The format reference says which part holds what.
3. `pack work-dir edited.docx`. If pack refuses, fix the line it names and pack again.

Pack writes a new ZIP that holds each member exactly once, with `[Content_Types].xml` first. Never append to a ZIP, patch one in place, or re-zip the directory with another tool. Keep the original until the new file reads back correctly.

To only look inside a file, `read` is enough. Unpack when you must edit, or when you need XML that `read` does not show.

## Verifying

Finish with `read` on the output, and check exactly what was asked: every required heading, number, table row, sheet, formula, slide and note, spelled as requested. Compare computed numbers with the source data again.

If probe found `soffice`, you can also render the file: `pdf` gives the page count and page breaks, `png` an image of the first page if your file tools can show images.

```
"<soffice from probe>" -env:UserInstallation=file:///<absolute profile dir> --headless --convert-to pdf --outdir "<absolute dir>" "<absolute file>"
```

Use a fresh profile directory: under `$TMPDIR` when your shell is confined by bubblewrap, inside the workspace under macOS Seatbelt. Remove it afterwards if it is in the workspace.

Without a renderer, say in one plain sentence that the content and structure were checked and the visual appearance was not.

## Limits

- Formulas are stored, not calculated. Give the cached value when you know it; otherwise tell the user Excel will calculate it on open.
- Macros are not created; password-protected files cannot be opened.
- Images and charts have no spec; adding one by hand touches several parts, so do it only when asked.
