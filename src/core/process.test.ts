/**
 * The two rules every harness spawner shares. The environment rule's own cases
 * are pinned beside the shell that first needed them (`shell.test.ts`,
 * `composition.test.ts`); here, what a second spawner relies on: the tree dies
 * with its root, and the wait returns only once it has.
 */
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { childEnvironment, killAndWait } from './process.ts'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('core/process', () => {
  it('withholds the declared names and MINIDSH_*, and lets the caller overlay win', () => {
    process.env.MINIDSH_PROCESS_TEST = 'harness-own'
    process.env.PROCESS_TEST_DECLARED = 'secret'
    try {
      const env = childEnvironment(['PROCESS_TEST_DECLARED'], { EXTRA: 'added' })
      expect(env.MINIDSH_PROCESS_TEST).toBeUndefined()
      expect(env.PROCESS_TEST_DECLARED).toBeUndefined()
      expect(env.EXTRA).toBe('added')
      expect(env.PATH ?? env.Path).toBeDefined()
    } finally {
      delete process.env.MINIDSH_PROCESS_TEST
      delete process.env.PROCESS_TEST_DECLARED
    }
  })

  it('kills a child AND the process it started, waiting for the root and its killer', { timeout: 60_000 }, async () => {
    // The root prints its grandchild's pid, then idles. On POSIX it leads its
    // own group (`detached`), which is what lets one signal reach the tree.
    const script = `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000)`
    const root = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32', windowsHide: true })
    const grandchild = await new Promise<number>((resolve, reject) => {
      let out = ''
      root.stdout!.on('data', (chunk) => {
        out += chunk
        const match = out.match(/(\d+)\s/)
        if (match) resolve(Number(match[1]))
      })
      root.once('exit', () => reject(new Error(`root exited before reporting its child; it printed ${JSON.stringify(out)}`)))
    })
    expect(alive(grandchild)).toBe(true)
    await killAndWait(root)
    expect(root.exitCode !== null || root.signalCode !== null).toBe(true)
    // The grandchild's death is asynchronous to the root's on every platform:
    // poll briefly, and say what it was waiting on if it never came.
    const deadline = Date.now() + 10_000
    while (alive(grandchild) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
    expect(alive(grandchild), `grandchild ${grandchild} outlived its root's tree kill`).toBe(false)
  })
})
