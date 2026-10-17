---
name: pdf
description: Read and create PDF files with a bundled Node helper. Use it when a task involves a .pdf: extracting its text page by page (requirements, invoices, papers, reports), checking its page count or metadata, or producing a PDF, either directly for plain Latin-text documents or by printing HTML with a Chrome or Edge found on this machine, or converting an Office file with LibreOffice when present.
license: MIT
metadata:
  minidsh-reviewed: "2026-10-18"
  minidsh-verified-with: "pending live arc"
---

# PDF

The helper `scripts/pdf.mjs` (Node 24+, no dependencies) reads PDFs and writes simple ones. Run it by its absolute path, quoted, from your own working directory:

```
node "<this skill's directory>/scripts/pdf.mjs" <command> ...
```

`<this skill's directory>` is the folder holding this SKILL.md. Do not change into it and never write inside it: keep inputs, your own scripts and outputs in the workspace, and name them for their task.

## Commands

| command | what it does |
|---|---|
| `probe` | JSON: which of Chrome, Edge, Chromium, soffice and pdftotext exist here, with ready command lines |
| `info <file>` | JSON: page count, version, encryption, title, producer |
| `read <file> [--pages 2-4] [--max-chars N] [--json]` | the text of each page in reading order; says when a page has no extractable text |
| `build <spec.json or spec.md> <out.pdf>` | a plain document: title, headings, paragraphs, bullets, word wrap, page numbers |

The helper refuses to overwrite an existing output unless you pass `--force`. Exit codes: 2 usage, 3 missing input, 4 invalid input, 5 refused output, 6 unsupported (an encrypted PDF).

## Reading

1. `info`, then `read`. Output stops at 20000 characters and says so; read a long file by page ranges.
2. "no extractable text" means a scanned page or text drawn as shapes. Say so and do not guess its content; there is no OCR here.
3. Table cells come out in reading order, separated by spaces, one row per line. When numbers matter, check them against the row and column they belong to.
4. An encrypted PDF is refused. If probe found `pdftotext`, `"<pdftotext>" -layout file.pdf -` may read it; otherwise ask the user for an unencrypted copy.

## Creating

Run `probe` first and never use a tool it did not find. Take the first route that fits:

1. **`build`**, for plain documents in Latin script. The spec is JSON, `{"title": "...", "pageSize": "A4", "blocks": [{"heading": "...", "level": 1}, {"paragraph": "..."}, {"bullets": ["..."]}]}`, or Markdown: `#` and `##` headings, paragraphs separated by blank lines, `- ` bullets. Curly quotes, dashes, bullets, the ellipsis and the euro sign work; any other character outside Latin-1 is refused with a message. Helvetica only, no tables or images.
2. **HTML printed by Chrome or Edge**, when probe found one: tables, images, colours, CSS layout, any script. Write `report.html` in the workspace (UTF-8, `<meta charset="utf-8">`, `@page { size: A4; margin: 2cm }` for print), then:

   ```
   "<browser from probe>" --headless --no-pdf-header-footer --print-to-pdf="<absolute out.pdf>" --user-data-dir="<absolute profile dir>" "<absolute report.html>"
   ```

   Use a fresh profile directory: under `$TMPDIR` when your shell is confined by bubblewrap, inside the workspace under macOS Seatbelt, anywhere in the workspace on Windows. Remove it afterwards if it is in the workspace. Give absolute paths. The browser can return before the file is complete: check that it exists, then read it.
3. **An Office file converted by `soffice`**, when probe found it:

   ```
   "<soffice from probe>" -env:UserInstallation=file:///<absolute profile dir> --headless --convert-to pdf --outdir "<absolute dir>" "<absolute file.docx>"
   ```

   Write the profile URL with forward slashes.

When no route fits (non-Latin text and no browser, say), tell the user what is missing rather than producing a file that drops characters.

## Verifying

Finish with `read` on the output and check exactly what was asked: the title, every required section, number and sentence, the page count and order. The text check does not show the layout. Unless you looked at rendered pages, say in one plain sentence that the content and structure were checked and the visual appearance was not.

## Limits

- `read` has no OCR and no decryption; text order follows the file, so multi-column pages may interleave.
- `build` writes Latin text in Helvetica with no tables or images; anything richer goes through HTML.
