import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { admitFolder, boundsVisible, canonicalPath, folderKey, isWithin, refusalFor, type FolderContext } from './folders.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A real tree: a profile with userData, an install dir and a home inside it, and a project. */
function world(): { ctx: FolderContext; root: string; project: string } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'minidsh-desktop-folders-')))
  dirs.push(root)
  const profile = join(root, 'Profile')
  const ctx: FolderContext = {
    platform: process.platform,
    profile,
    userData: join(profile, 'AppData', 'Roaming', 'MiniDSH'),
    installDir: join(profile, 'AppData', 'Local', 'Programs', 'MiniDSH'),
    // Not created: a home that does not exist yet is still protected.
    home: join(profile, '.minidsh'),
  }
  for (const dir of [ctx.userData, ctx.installDir, join(profile, 'code', 'project')]) mkdirSync(dir, { recursive: true })
  return { ctx, root, project: join(profile, 'code', 'project') }
}

describe('folder admission, on this host', () => {
  it('admits a project folder as its canonical path', () => {
    const { ctx, project } = world()
    expect(admitFolder(project, ctx)).toEqual({ ok: true, path: realpathSync.native(project) })
  })

  it('refuses a relative path, a missing folder and a file', () => {
    const { ctx, project } = world()
    writeFileSync(join(project, 'file.txt'), 'x')
    expect(admitFolder('code/project', ctx)).toEqual({ ok: false, reason: 'That is not a full folder path.' })
    expect(admitFolder(join(project, 'missing'), ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/does not exist/) })
    expect(admitFolder(join(project, 'file.txt'), ctx)).toEqual({ ok: false, reason: 'That is not a folder.' })
  })

  it('refuses the filesystem root and the profile root', () => {
    const { ctx } = world()
    expect(admitFolder(parse(process.cwd()).root, ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/whole drive/) })
    expect(admitFolder(ctx.profile, ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/whole user folder/) })
  })

  it("refuses MiniDSH's own state: containing userData, the install dir or the home, or inside the first two", () => {
    const { ctx } = world()
    const appData = join(ctx.profile, 'AppData')
    expect(admitFolder(appData, ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/contains MiniDSH's app data/) })
    expect(admitFolder(ctx.userData, ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/contains MiniDSH's app data/) })
    expect(admitFolder(ctx.installDir, ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/contains the MiniDSH installation/) })
    mkdirSync(join(ctx.userData, 'Partitions'), { recursive: true })
    mkdirSync(join(ctx.installDir, 'resources'), { recursive: true })
    expect(admitFolder(join(ctx.userData, 'Partitions'), ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/inside MiniDSH's app data/) })
    expect(admitFolder(join(ctx.installDir, 'resources'), ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/inside the MiniDSH installation/) })
    // The home is not created, yet a folder that would contain it is refused.
    const outer = join(ctx.profile, 'outer')
    mkdirSync(outer)
    const withHome = { ...ctx, home: join(outer, '.minidsh') }
    expect(admitFolder(outer, withHome)).toMatchObject({ ok: false, reason: expect.stringMatching(/home folder/) })
    // Inside the home as well: an agent there rewrites the record or a skill.
    mkdirSync(join(outer, '.minidsh', 'skills'), { recursive: true })
    expect(admitFolder(join(outer, '.minidsh', 'skills'), withHome)).toMatchObject({ ok: false, reason: expect.stringMatching(/inside MiniDSH's home folder/) })
  })

  it('canonicalizes through a link, so a junction cannot walk around a refusal', (test) => {
    const { ctx, root } = world()
    const link = join(root, 'link-to-install')
    try {
      symlinkSync(ctx.installDir, link, 'junction')
    } catch {
      test.skip('no link privilege on this host')
    }
    expect(admitFolder(link, ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/contains the MiniDSH installation/) })
  })

  it.runIf(process.platform === 'win32')('compares case-insensitively on Windows', () => {
    const { ctx } = world()
    expect(admitFolder(ctx.userData.toUpperCase(), ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/app data/) })
    expect(admitFolder(ctx.profile.toLowerCase(), ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/whole user folder/) })
  })

  it('canonicalizes a path that does not exist yet through its nearest existing ancestor', () => {
    const { root } = world()
    expect(canonicalPath(join(root, 'not', 'yet'), process.platform)).toBe(join(root, 'not', 'yet'))
  })
})

describe('folder rules, pure, for both platforms', () => {
  const win: FolderContext = {
    platform: 'win32',
    profile: 'C:\\Users\\Zoë',
    userData: 'C:\\Users\\Zoë\\AppData\\Roaming\\MiniDSH',
    installDir: 'C:\\Users\\Zoë\\AppData\\Local\\Programs\\MiniDSH',
    home: 'C:\\Users\\Zoë\\.minidsh',
  }
  const nix: FolderContext = { platform: 'linux', profile: '/home/zoe', userData: '/home/zoe/.config/MiniDSH', installDir: '/opt/MiniDSH', home: '/home/zoe/.minidsh' }

  it('refuses drive roots and UNC share roots, admits a share folder', () => {
    expect(refusalFor('C:\\', win)).toMatch(/whole drive or network share/)
    expect(refusalFor('\\\\srv\\share', win)).toMatch(/network share/)
    expect(refusalFor('\\\\srv\\share\\', win)).toMatch(/network share/)
    expect(refusalFor('\\\\srv\\share\\project', win)).toBeUndefined()
    expect(refusalFor('/', nix)).toMatch(/whole drive/)
  })

  it('refuses the profile in any case on Windows, and only the exact spelling on Linux', () => {
    expect(refusalFor('c:\\users\\ZOË', win)).toMatch(/whole user folder/)
    expect(refusalFor('/home/zoe', nix)).toMatch(/whole user folder/)
    expect(refusalFor('/home/Zoe', nix)).toBeUndefined()
  })

  it('refuses containing and inside, never a sibling that merely shares a prefix', () => {
    expect(refusalFor('C:\\Users\\Zoë\\AppData', win)).toMatch(/contains MiniDSH's app data/)
    expect(refusalFor('c:\\users\\zoë\\appdata\\roaming\\minidsh\\x', win)).toMatch(/inside MiniDSH's app data/)
    expect(refusalFor('C:\\Users\\Zoë\\AppData\\Roaming\\MiniDSH-other', win)).toBeUndefined()
    expect(refusalFor('/opt', nix)).toMatch(/contains the MiniDSH installation/)
    expect(refusalFor('/opt/MiniDSH/resources', nix)).toMatch(/inside the MiniDSH installation/)
    expect(refusalFor('/opt/MiniDSHx', nix)).toBeUndefined()
    // Inside the home too, refused by the launcher before the CLI ever sees it.
    expect(refusalFor('/home/zoe/.minidsh/skills', nix)).toMatch(/inside MiniDSH's home folder/)
    expect(refusalFor('/home/zoe/code', nix)).toBeUndefined()
    expect(refusalFor('/home/zoe/code', { ...nix, home: '/home/zoe/code/.minidsh' })).toMatch(/home folder/)
  })

  it('takes an AppImage as its FILE: a folder holding it is refused, a project beside it is not', () => {
    const appImage: FolderContext = { ...nix, installDir: '/home/zoe/Downloads/MiniDSH-1.2.0-x86_64.AppImage' }
    expect(refusalFor('/home/zoe/Downloads', appImage)).toMatch(/contains the MiniDSH installation/)
    expect(refusalFor('/home/zoe/Downloads/myrepo', appImage)).toBeUndefined()
  })

  it('treats a child named `..x` as inside, and different drives as unrelated', () => {
    expect(isWithin('/opt/MiniDSH/..x', '/opt/MiniDSH', 'linux')).toBe(true)
    expect(isWithin('/opt', '/opt/MiniDSH', 'linux')).toBe(false)
    expect(isWithin('D:\\Users\\Zoë', 'C:\\Users\\Zoë', 'win32')).toBe(false)
    expect(folderKey('C:\\A\\B\\', 'win32')).toBe('c:\\a\\b')
    expect(folderKey('C:\\', 'win32')).toBe('c:\\')
    expect(folderKey('/a/b/', 'linux')).toBe('/a/b')
  })

  it('strips a verbatim prefix the OS may hand back before judging', () => {
    const fs = { realpath: (path: string) => (path === 'C:\\x' ? '\\\\?\\C:\\' : path), isDirectory: () => true }
    expect(admitFolder('C:\\x', win, fs)).toMatchObject({ ok: false, reason: expect.stringMatching(/whole drive/) })
    const unc = { realpath: () => '\\\\?\\UNC\\srv\\share', isDirectory: () => true }
    expect(admitFolder('Z:\\', win, unc)).toMatchObject({ ok: false, reason: expect.stringMatching(/network share/) })
  })
})

describe('window bounds', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 }
  const left = { x: -1280, y: 0, width: 1280, height: 984 }

  it('keeps bounds whose title strip is on a display, by at least 64 x 64', () => {
    expect(boundsVisible({ x: 100, y: 100, width: 800, height: 600 }, [primary])).toBe(true)
    expect(boundsVisible({ x: -1000, y: 50, width: 800, height: 600 }, [primary, left])).toBe(true)
    // Mostly off to the left, but 64 px of the strip remain on the primary.
    expect(boundsVisible({ x: -736, y: 10, width: 800, height: 600 }, [primary])).toBe(true)
  })

  it('discards bounds off every display, barely on one, or above its top', () => {
    expect(boundsVisible({ x: -1000, y: 50, width: 800, height: 600 }, [primary])).toBe(false)
    expect(boundsVisible({ x: 1900, y: 100, width: 800, height: 600 }, [primary])).toBe(false)
    expect(boundsVisible({ x: 100, y: 1000, width: 800, height: 600 }, [primary])).toBe(false)
    expect(boundsVisible({ x: 100, y: -100, width: 800, height: 600 }, [primary])).toBe(false)
    expect(boundsVisible({ x: 100, y: 100, width: 800, height: 600 }, [])).toBe(false)
    expect(boundsVisible({ x: Number.NaN, y: 100, width: 800, height: 600 }, [primary])).toBe(false)
  })
})
