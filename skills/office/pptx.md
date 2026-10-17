# PowerPoint (.pptx)

## Build spec

```json
{"title": "Quarterly Review", "slides": [
  {"title": "Quarterly Review", "text": "October 2026\n\nPrepared by Finance"},
  {"title": "Highlights", "bullets": ["Revenue up 12%", "Costs flat"], "notes": "Mention the North region."},
  {"title": "Next steps", "text": "One opening sentence.", "bullets": ["Hire two engineers", "Ship the beta"]}
]}
```

- Slides are 16:9 and use one layout: a title and a content box.
- `text` paragraphs (split on blank lines) come first without bullets, then the `bullets`. A single `\n` is a line break.
- The body font shrinks as the text grows; past about 14 lines, build warns and you should split the slide.
- `notes` become the speaker notes.
- Slides read best with at most 6 bullets of about 12 words.

## What `read` shows

```
pptx: 3 slide(s), 16:9 (12192000x6858000 EMU)

== slide 2 (ppt/slides/slide2.xml, layout "Title and Content")
title: Highlights
body:
  • Revenue up 12%
  • Costs flat
notes: Mention the North region.
```

Shapes are listed by role (title, body, subtitle, text box, picture, table); hidden slides are marked.

## Parts after `unpack`

| part | holds |
|---|---|
| `ppt/presentation.xml` | slide order in `p:sldIdLst` (ids from 256), slide size in `p:sldSz` |
| `ppt/_rels/presentation.xml.rels` | each `r:id` to `slides/slideN.xml`, the master, the theme |
| `ppt/slides/slideN.xml` | the shapes of one slide: `p:sp` with `p:txBody` |
| `ppt/slides/_rels/slideN.xml.rels` | its layout, notes slide and images |
| `ppt/notesSlides/notesSlideN.xml` | speaker notes, in the placeholder of type `body` |
| `ppt/slideLayouts`, `ppt/slideMasters`, `ppt/theme` | the design; leave them alone unless asked |

## Editing recipes

A text shape:

```xml
<p:sp>
  <p:nvSpPr><p:cNvPr id="3" name="Content Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>
  <p:spPr/>
  <p:txBody><a:bodyPr/><a:lstStyle/>
    <a:p><a:r><a:rPr lang="en-US"/><a:t>First bullet</a:t></a:r></a:p>
    <a:p><a:pPr lvl="1"/><a:r><a:rPr lang="en-US"/><a:t>A sub-point</a:t></a:r></a:p>
  </p:txBody>
</p:sp>
```

- Change text inside `<a:t>`; add a bullet by copying an `<a:p>`. Bold is `b="1"` on `<a:rPr>`, size `sz="2400"` in hundredths of a point.
- A placeholder (`p:ph`) takes its position and style from the layout, so an empty `<p:spPr/>` is right. A free text box has no placeholder and needs `<a:xfrm><a:off x="..." y="..."/><a:ext cx="..." cy="..."/></a:xfrm>` in its `p:spPr`, or it is invisible. Units are EMU: 914400 per inch; the slide is 12192000 x 6858000.
- Each `cNvPr id` is unique within its slide.
- Reorder slides by reordering the `<p:sldId>` elements in presentation.xml; nothing else changes.
- Add a slide: copy a slideN.xml and its .rels (drop the notesSlide relationship, or copy the notes slide too), then add an `Override` in `[Content_Types].xml`, a relationship in presentation.xml.rels, and `<p:sldId id="(highest + 1)" r:id="..."/>`.
- Delete a slide: remove its `p:sldId`, its relationship, its `Override`, its files and its notes slide. Pack refuses leftovers that point at missing parts.

## Traps

- Text that overflows its box is not an error anywhere; only a renderer shows it. Keep text short or split the slide, and without a renderer say that the layout was not seen.
- Theme fonts (`+mn-lt`, `+mj-lt`) resolve to Calibri; a font that is not installed is substituted.
- Slide ids stay unique and at least 256; master and layout ids at least 2147483648.
