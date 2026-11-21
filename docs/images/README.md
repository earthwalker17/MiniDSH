# Pictures

What each file in this folder is and how to make it again. `scripts/check-docs.ts` fails on a picture here that no document shows or lists, and on a document that shows one that is missing.

## Logo

`logo/` holds the mark for listings and launch pages. The drawing is the one the app uses: `scripts/logo.test.ts` holds its geometry equal across all six places it is written.

| File | What |
|---|---|
| `logo/minidsh-logo.svg` | the mark on a full-bleed square. Use this where the site rounds the corners itself. |
| `logo/minidsh-logo-1024.png`, `logo/minidsh-logo-512.png`, `logo/minidsh-logo-240.png` | the same, rendered at 1024, 512 and 240 px |
| `logo/minidsh-mark.svg` | the rounded tile on a transparent ground, byte for byte the desktop app's icon |
| `logo/minidsh-mark-1024.png` | the same, at 1024 px |

The PNGs were rendered from the SVGs with a headless browser at the size in the name. Colours: ground `#0f1115`, stroke `#ffffff`, dot `#3cc2b0`.

## The hero

`README_hero.png` opens the README. It is a drawn image, not a screenshot, and its path is kept: the npm page and older links point at it.
