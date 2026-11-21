/**
 * The fuse reader of `desktop/scripts/check-fuses.ts`, against binaries made
 * up here: a real one is 200 MB and exists only after packing, where every
 * desktop leg runs the script on it. (This file sits with the repository's
 * scripts because that is where the unit suite looks; the desktop's own
 * scripts are not one of its roots.)
 */
import { describe, expect, it } from 'vitest'
import { describeWires, FUSE_NAMES, FUSE_SENTINEL, FUSES_THAT_MUST_BE_OFF, fuseFile, fuseProblems, readFuseWires } from '../desktop/scripts/check-fuses.ts'

/** A wire as Electron lays it out: the sentinel, the version, the length, a byte per fuse. */
const wire = (fuses: string, version = 1, length = fuses.length): Buffer => Buffer.concat([Buffer.from(FUSE_SENTINEL, 'latin1'), Buffer.from([version, length]), Buffer.from(fuses, 'latin1')])
const padding = (bytes: number): Buffer => Buffer.alloc(bytes, 0xcc)
/** A binary with code before and after each wire. */
const binary = (...wires: Buffer[]): Buffer => Buffer.concat([padding(4096), ...wires.flatMap((each) => [each, padding(977)])])

/** What package.ts asks for, as Electron 45 writes it: nine fuses, ours off, one it leaves on. */
const SHIPPED = '000000001'

describe('the fuse check', () => {
  it('reads the wire that follows the sentinel, wherever it is in the file', () => {
    const wires = readFuseWires(binary(wire(SHIPPED)))
    expect(wires).toEqual([{ offset: 4096 + FUSE_SENTINEL.length + 2, fuses: [...Buffer.from(SHIPPED, 'latin1')] }])
    expect(describeWires(wires)).toEqual([
      'wire 1 of 1: runAsNode=off enableCookieEncryption=off enableNodeOptionsEnvironmentVariable=off enableNodeCliInspectArguments=off enableEmbeddedAsarIntegrityValidation=off onlyLoadAppFromAsar=off loadBrowserProcessSpecificV8Snapshot=off grantFileProtocolExtraPrivileges=off fuse8=ON',
    ])
    expect(fuseProblems(binary(wire(SHIPPED)))).toEqual([])
  })

  it('refuses each of the four when it is on, by name, and leaves the others to be whatever they are', () => {
    for (const name of FUSES_THAT_MUST_BE_OFF) {
      const fuses = [...'00000000']
      fuses[FUSE_NAMES.indexOf(name)] = '1'
      expect(fuseProblems(binary(wire(fuses.join('')))), name).toEqual([`${name} is ON in wire 1, and must be off`])
    }
    // Every fuse that is NOT one of the four, on: nothing to refuse.
    const others = FUSE_NAMES.map((name) => ((FUSES_THAT_MUST_BE_OFF as readonly string[]).includes(name) ? '0' : '1')).join('')
    expect(others).toBe('01001110')
    expect(fuseProblems(binary(wire(others)))).toEqual([])
  })

  it('refuses anything that is not a plain off: a removed fuse, an unknown state, a wire too short to hold the fuse', () => {
    expect(fuseProblems(binary(wire('r0000000')))).toEqual(['runAsNode is removed in wire 1, and must be off'])
    expect(fuseProblems(binary(wire('00\x9000000')))).toEqual(['enableNodeOptionsEnvironmentVariable is the unknown state 0x90 in wire 1, and must be off'])
    expect(fuseProblems(binary(wire('0000')))).toEqual(['wire 1 has 4 fuses and no grantFileProtocolExtraPrivileges'])
  })

  it('holds EVERY wire to the rule: a universal binary has one per architecture', () => {
    expect(readFuseWires(binary(wire(SHIPPED), wire(SHIPPED)))).toHaveLength(2)
    expect(fuseProblems(binary(wire(SHIPPED), wire(SHIPPED)))).toEqual([])
    expect(fuseProblems(binary(wire(SHIPPED), wire('100000001')))).toEqual(['runAsNode is ON in wire 2, and must be off'])
  })

  it('says so when there is nothing to read, rather than passing: no sentinel, another wire version, a file cut short', () => {
    expect(fuseProblems(padding(8192))).toEqual([expect.stringMatching(/^no fuse wire/)])
    expect(fuseProblems(binary(wire(SHIPPED, 2)))).toEqual([expect.stringMatching(/is version 2, and this reader knows version 1/)])
    expect(fuseProblems(Buffer.concat([padding(64), wire('0000', 1, 9)]))).toEqual([expect.stringMatching(/says it has 9 fuses, and the file ends after 4/)])
    expect(fuseProblems(Buffer.concat([padding(64), Buffer.from(FUSE_SENTINEL, 'latin1')]))).toEqual([expect.stringMatching(/the file ends inside the fuse wire/)])
  })

  it('looks in the framework on macOS, and in the executable itself elsewhere', () => {
    expect(fuseFile('/tmp/mac/MiniDSH.app/Contents/MacOS/MiniDSH').replaceAll('\\', '/')).toBe('/tmp/mac/MiniDSH.app/Contents/Frameworks/Electron Framework.framework/Electron Framework')
    expect(fuseFile('D:\\a\\dist\\win-unpacked\\MiniDSH.exe')).toBe('D:\\a\\dist\\win-unpacked\\MiniDSH.exe')
    expect(fuseFile('/tmp/appimage/squashfs-root/minidsh-desktop')).toBe('/tmp/appimage/squashfs-root/minidsh-desktop')
  })
})
