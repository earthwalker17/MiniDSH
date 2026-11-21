/**
 * `browsersUsing` decides "a closed or refused browser left nothing running",
 * and an empty answer is what that check reads as success. So the helper is
 * held to both halves here, with no browser needed: it SEES a process whose
 * command line names the directory (without this, a query that stopped
 * matching would make every such check pass for ever), and a query that
 * cannot run is an error, never an empty answer.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { browsersUsing } from './browser-fixture.ts'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('browsersUsing', () => {
  it('finds a running process whose command line names the directory, and no longer finds it once it is gone', { timeout: 120_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'minidsh-browsers-using-'))
    dirs.push(root)
    expect(browsersUsing(root), 'nothing names a directory that was only just made').toEqual([])
    // What a browser is to this helper: a process with the profile on its command line.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', `--user-data-dir=${join(root, 'profile-1')}`], { stdio: 'ignore' })
    try {
      await once(child, 'spawn')
      expect(browsersUsing(root), `the query did not see pid ${child.pid}, which is running with ${root} on its command line`).toContain(child.pid)
    } finally {
      child.kill('SIGKILL')
    }
    await once(child, 'exit')
    // The process table drops it a moment after the exit is reported: poll the helper itself, bounded.
    const deadline = Date.now() + 30_000
    let seen = browsersUsing(root)
    while (seen.includes(child.pid!) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      seen = browsersUsing(root)
    }
    expect(seen, `pid ${child.pid} exited and is still listed`).toEqual([])
  })

  it('throws when its query cannot run, rather than answering that nothing is running', () => {
    const root = mkdtempSync(join(tmpdir(), 'minidsh-browsers-using-'))
    dirs.push(root)
    // No PATH: neither pwsh nor pgrep can be started, which is what a host without them looks like.
    const saved = process.env.PATH
    process.env.PATH = ''
    try {
      expect(() => browsersUsing(root)).toThrowError(/could not answer, so nothing is known about what is running\nattempt 1: .*ENOENT[^\n]*\nattempt 2: [^\n]*\nattempt 3: /)
    } finally {
      process.env.PATH = saved
    }
  })
})
