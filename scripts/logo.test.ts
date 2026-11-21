/**
 * The mark is drawn in seven places, each in the syntax its consumer needs: the
 * desktop icon's source, the shell page's mark, the web page's favicon (a data
 * URI) and its in-page mark (built with DOM calls), the two files under
 * `docs/images/logo/` kept for listings, and the repository's social preview
 * (`docs/images/social-preview.svg`). Nothing generates one from another,
 * so a change to the drawing in one place is a second logo. This holds the
 * geometry equal, and the published PNG sizes to what their names say.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

const STRAP = 'M6.5 16.5V9.5a2.5 2.5 0 0 1 5 0v7M11.5 9.5a2.5 2.5 0 0 1 5 0v7'
const TILE = `<rect x="1" y="1" width="22" height="22" rx="7" fill="#0f1115"/>`
const GLYPH = `<path d="${STRAP}" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="17.75" cy="6.25" r="1.6" fill="#3cc2b0"/>`
const svg = (ground: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${ground}${GLYPH}</svg>`

/** A PNG's pixel size, from its IHDR chunk. */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(join(ROOT, path))
  expect(bytes.subarray(1, 4).toString('latin1'), path).toBe('PNG')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('the mark', () => {
  it('is one drawing in the three files that hold the rounded tile', () => {
    for (const file of ['desktop/resources/icon.svg', 'desktop/shell/mark.svg', 'docs/images/logo/minidsh-mark.svg']) {
      expect(read(file).trim(), file).toBe(svg(TILE))
    }
  })

  it('differs in the square logo only by its ground, which fills the whole square', () => {
    expect(read('docs/images/logo/minidsh-logo.svg').trim()).toBe(svg(`<rect width="24" height="24" fill="#0f1115"/>`))
  })

  it("is the same drawing in the web page's favicon and in the mark it builds", () => {
    // The favicon is the tile file as a data URI: single quotes, `#` escaped.
    const favicon = svg(TILE).replaceAll('"', "'").replaceAll('#', '%23').replaceAll('<', '%3C').replaceAll('>', '%3E')
    expect(read('src/app/web/index.html')).toContain(`href="data:image/svg+xml,${favicon}"`)
    const icons = read('src/app/web/icons.js')
    expect(icons).toContain(`d: '${STRAP}'`)
    expect(icons).toContain(`{ x: '1', y: '1', width: '22', height: '22', rx: '7', class: 'mark-tile' }`)
    expect(icons).toContain(`{ cx: '17.75', cy: '6.25', r: '1.6', class: 'mark-dot' }`)
  })

  it('is the same glyph on the social preview, which is the size a repository page takes', () => {
    // No tile there: the picture's own ground is the tile's colour.
    const source = read('docs/images/social-preview.svg')
    expect(source).toContain(GLYPH)
    expect(source).toContain('<rect width="1280" height="640" fill="#0f1115"/>')
    expect(pngSize('docs/images/social-preview.png')).toEqual({ width: 1280, height: 640 })
  })

  it('is published at the sizes its file names say, square', () => {
    const sizes = Object.fromEntries(['minidsh-logo-1024.png', 'minidsh-logo-512.png', 'minidsh-logo-240.png', 'minidsh-mark-1024.png'].map((name) => [name, pngSize(`docs/images/logo/${name}`)]))
    expect(sizes).toEqual({
      'minidsh-logo-1024.png': { width: 1024, height: 1024 },
      'minidsh-logo-512.png': { width: 512, height: 512 },
      'minidsh-logo-240.png': { width: 240, height: 240 },
      'minidsh-mark-1024.png': { width: 1024, height: 1024 },
    })
  })
})
