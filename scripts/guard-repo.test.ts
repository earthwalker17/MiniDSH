/**
 * `.claude/hooks/guard-repo.mjs`, fed tool inputs the way the harness feeds
 * them (JSON on stdin) and judged by its exit code: 2 blocks, 0 lets through.
 * The hook only ever READS a command, so nothing here links to, or deletes,
 * anything real: the one link the cases need points at a scratch folder
 * standing in for a dependency tree, and every command is text.
 *
 * It is the enforcement CLAUDE.md §8 names for "never link node_modules into
 * a worktree", and it had no test: a junction made with New-Item's `-Type`
 * alias passed, and so did the recursive delete of a worktree named by a
 * bare word or after a `cd`, which is how such a delete is usually written.
 * (This file sits with the repository's scripts because that is where the
 * unit suite looks; `.claude/` is not one of its roots.)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const HOOK = resolve(import.meta.dirname, '..', '.claude', 'hooks', 'guard-repo.mjs')
const windows = process.platform === 'win32'

/** The hook's verdict on one command: its exit code, and what it told the agent. */
function verdict(command: string, cwd: string): Promise<{ code: number | null; said: string }> {
  return new Promise((done, failed) => {
    const child = spawn(process.execPath, [HOOK], { stdio: ['pipe', 'ignore', 'pipe'] })
    const said: Buffer[] = []
    child.stderr.on('data', (chunk: Buffer) => said.push(chunk))
    child.once('error', failed)
    child.once('close', (code) => done({ code, said: Buffer.concat(said).toString('utf8') }))
    child.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }))
  })
}

/** What the hook did with each command, as `blocked` or `allowed`, by the case's own name. */
async function verdicts(cases: Readonly<Record<string, string>>, cwd: string): Promise<Record<string, string>> {
  const entries = await Promise.all(
    Object.entries(cases).map(async ([name, command]) => {
      const { code, said } = await verdict(command, cwd)
      const outcome = code === 2 && said.startsWith('BLOCKED by .claude/hooks/guard-repo.mjs') ? 'blocked' : code === 0 && said === '' ? 'allowed' : `exit ${String(code)}: ${said}`
      return [name, outcome] as const
    }),
  )
  return Object.fromEntries(entries)
}

const all = (cases: Readonly<Record<string, string>>, outcome: string): Record<string, string> => Object.fromEntries(Object.keys(cases).map((name) => [name, outcome]))

describe('the node_modules guard hook', { timeout: 120_000 }, () => {
  /** A scratch folder holding: `wt` (a worktree with a linked `node_modules`), `linked` (a link itself), `plain` (real folders only). */
  let dir = ''
  let elsewhere = ''
  const links: string[] = []
  beforeAll(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'minidsh-guard-')))
    elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), 'minidsh-guard-elsewhere-')))
    const tree = join(dir, 'stands-in-for-a-dependency-tree')
    mkdirSync(join(tree, 'kept'), { recursive: true })
    mkdirSync(join(dir, 'wt'))
    mkdirSync(join(dir, 'plain', 'node_modules', 'real'), { recursive: true })
    writeFileSync(join(dir, 'plain', 'notes.txt'), 'x')
    // A junction on Windows (no privilege needed), a symlink elsewhere: what a borrowed dependency tree is.
    for (const link of [join(dir, 'wt', 'node_modules'), join(dir, 'linked')]) {
      symlinkSync(tree, link, windows ? 'junction' : 'dir')
      links.push(link)
    }
  })
  afterAll(() => {
    // The links first, by unlinking them: the cleanup must not be the walk the hook exists to prevent.
    for (const link of links) unlinkSync(link)
    for (const each of [dir, elsewhere]) rmSync(each, { recursive: true, force: true })
  })

  it('blocks every way of LINKING to a node_modules tree, whatever the parameter is called', async () => {
    const cases = {
      'cmd mklink': 'mklink /J C:\\scratch\\wt\\node_modules C:\\repo\\node_modules',
      'cmd mklink through bash': 'cmd //c "mklink /J wt\\node_modules ..\\repo\\node_modules"',
      'New-Item -ItemType Junction': 'New-Item -ItemType Junction -Path C:\\scratch\\wt\\node_modules -Target C:\\repo\\node_modules',
      'New-Item -Type Junction (the alias)': 'New-Item -Type Junction -Path C:\\scratch\\wt\\node_modules -Target C:\\repo\\node_modules',
      'New-Item -Type SymbolicLink, quoted': "New-Item -Type 'SymbolicLink' -Path wt/node_modules -Target ../repo/node_modules",
      'ni, the alias of New-Item': 'ni wt/node_modules -it Junction -Target ../repo/node_modules',
      'ln -s': 'ln -s ../repo/node_modules wt/node_modules',
      'ln -sfn': 'ln -sfn "$REPO/node_modules" wt/node_modules',
      'ln --symbolic': 'ln --symbolic ../repo/node_modules wt/node_modules',
      'after another statement': 'git worktree add ../wt HEAD && New-Item -Type Junction ../wt/node_modules -Target node_modules',
    }
    expect(await verdicts(cases, dir)).toEqual(all(cases, 'blocked'))
  })

  it('lets through what links nothing to node_modules: a mention in another statement, a real folder, a link to something else', async () => {
    const cases = {
      'a search that names the verb elsewhere': 'ls node_modules && echo mklink',
      'a real folder named node_modules': 'New-Item -ItemType Directory -Path wt2/node_modules',
      'a link to something else': 'ln -s ../docs docs-link',
      'pnpm install in the worktree': 'cd ../wt && pnpm install --frozen-lockfile',
      'an empty command': '   ',
    }
    expect(await verdicts(cases, dir)).toEqual(all(cases, 'allowed'))
  })

  it('blocks a recursive delete of the folder that HOLDS a linked node_modules, however the folder is named', async () => {
    const at = dir.replaceAll('\\', '/')
    const cases = {
      'rm -rf ./wt': 'rm -rf ./wt',
      'rm -rf wt (a bare name)': 'rm -rf wt',
      'rm -Rf wt': 'rm -Rf wt',
      'rm -r -f wt': 'rm -r -f wt',
      'rm wt -rf (flags last)': 'rm wt -rf',
      'rm --recursive --force wt': 'rm --recursive --force wt',
      'rm -rf "wt/" (quoted, trailing slash)': 'rm -rf "wt/"',
      'rm -rf plain wt (the second of two)': 'rm -rf plain wt',
      'Remove-Item -Recurse -Force wt': 'Remove-Item -Recurse -Force wt',
      'Remove-Item wt -r -fo (abbreviated)': 'Remove-Item wt -r -fo',
      'Remove-Item -Recurse plain, wt (a list)': 'Remove-Item -Recurse plain, wt',
      'ri -rec wt (an alias)': 'ri -rec wt',
      'rd /s /q wt': 'rd /s /q wt',
      'git worktree remove --force wt': 'git worktree remove --force wt',
      'by its full path': `rm -rf "${at}/wt"`,
      'the link itself, as a path': 'rm -rf wt/node_modules',
      'handed to another shell: bash -c': 'bash -c "rm -rf wt"',
      'handed to another shell: cmd //c': 'cmd //c "rd /s /q wt"',
      'handed to another shell: powershell -Command': "powershell -NoProfile -Command 'Remove-Item wt -Recurse'",
    }
    expect(await verdicts(cases, dir)).toEqual(all(cases, 'blocked'))
  })

  it('follows the line to where it runs: a cd before the delete, a subshell, git -C', async () => {
    const at = dir.replaceAll('\\', '/')
    const cases = {
      'cd && rm -rf wt': `cd "${at}" && rm -rf wt`,
      // Unquoted, as it is usually typed: only where this host's temp path has no space to split it.
      ...(/\s/.test(at) ? {} : { 'cd && rm -rf wt, unquoted': `cd ${at} && rm -rf wt` }),
      'cd "…" ; Remove-Item': `cd "${at}"; Remove-Item -Recurse -Force wt`,
      'Set-Location -Path': `Set-Location -Path '${at}'; Remove-Item wt -Recurse`,
      'a subshell': `(cd "${at}" && rm -rf ./wt)`,
      'two cds': `cd "${at}/plain" && cd .. && rm -rf wt`,
      'git -C <dir> worktree remove': `git -C "${at}" worktree remove --force wt`,
      ...(windows ? { 'the path as Git Bash spells it': `rm -rf "/${at[0]!.toLowerCase()}${at.slice(2)}/wt"` } : {}),
    }
    // Asked from a directory that holds none of it: only the line says where it runs.
    expect(await verdicts(cases, elsewhere)).toEqual(all(cases, 'blocked'))
    // The same deletes, with the cd taken away, name nothing that is there.
    expect(await verdicts({ 'rm -rf wt, from elsewhere': 'rm -rf wt', 'a cd to a variable': 'cd "$SOMEWHERE" && rm -rf wt' }, elsewhere)).toEqual({ 'rm -rf wt, from elsewhere': 'allowed', 'a cd to a variable': 'allowed' })
  })

  it('blocks a recursive delete of a path that IS a link, and says how to unlink it instead', async () => {
    const cases = { 'rm -rf linked': 'rm -rf linked', 'Remove-Item -Recurse linked': 'Remove-Item -Recurse linked', 'rm -rf ./linked/': 'rm -rf ./linked/' }
    expect(await verdicts(cases, dir)).toEqual(all(cases, 'blocked'))
    expect((await verdict('rm -rf linked', dir)).said).toMatch(/is a filesystem LINK[\s\S]*cmd \/\/c rmdir/)
  })

  it('lets every other delete through: real folders, files, a delete that is not recursive, a name that is not there', async () => {
    const cases = {
      'rm -rf plain (its node_modules is real)': 'rm -rf plain',
      'rm -rf plain/node_modules': 'rm -rf plain/node_modules',
      'Remove-Item -Recurse plain': 'Remove-Item -Recurse -Force plain',
      'rm plain/notes.txt': 'rm plain/notes.txt',
      'rm -f plain/notes.txt': 'rm -f plain/notes.txt',
      'rm -rf nothing-here': 'rm -rf nothing-here',
      'a delete held in a variable': 'rm -rf "$DIR/wt"',
      'git worktree list': 'git worktree list',
      'a remove that is not a delete': 'npm rm -g some-package',
      'docker run --rm': 'docker run --rm -e wt image',
    }
    expect(await verdicts(cases, dir)).toEqual(all(cases, 'allowed'))
  })

  it('lets through what is not a command at all', async () => {
    const run = (stdin: string): Promise<number | null> =>
      new Promise((done, failed) => {
        const child = spawn(process.execPath, [HOOK], { stdio: ['pipe', 'ignore', 'ignore'] })
        child.once('error', failed)
        child.once('close', done)
        child.stdin.end(stdin)
      })
    expect(await Promise.all([run(''), run('not json'), run('{}'), run(JSON.stringify({ tool_input: { file_path: 'node_modules/x' } }))])).toEqual([0, 0, 0, 0])
  })
})
