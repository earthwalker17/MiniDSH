import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The app and the package are one release identity: the packer refuses two
 * versions (desktop/scripts/package.ts). This puts that refusal in `pnpm check`,
 * so a release that bumps only the root fails here, not on every desktop leg.
 */
describe('the desktop release identity', () => {
  it('has the runtime package version', () => {
    const version = (path: string): unknown => (JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as { version?: unknown }).version
    expect(version('../package.json')).toBe(version('../../package.json'))
  })
})
