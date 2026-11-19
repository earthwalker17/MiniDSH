import { describe, expect, it } from 'vitest'
import { folderOfRemoveId, MENU_IDS, menuTemplate, removeFolderId, type MenuItemTemplate } from './menu.ts'

const flatten = (items: readonly MenuItemTemplate[]): MenuItemTemplate[] => items.flatMap((item) => [item, ...flatten(item.submenu ?? [])])
const labels = (items: readonly MenuItemTemplate[] | undefined): (string | undefined)[] => (items ?? []).map((item) => item.label ?? item.role ?? item.type)
const NO_OPEN_ROLES = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'reload', 'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen', 'hide', 'hideOthers', 'unhide'])

const WIN = { platform: 'win32' as const, folders: ['C:\\code\\a', 'C:\\code\\R&D'], current: 'c:\\CODE\\a', appName: 'MiniDSH' }
const MAC = { platform: 'darwin' as const, folders: ['/Users/z/a'], current: '/Users/z/a', appName: 'MiniDSH' }

describe('the application menu', () => {
  it('has File, Edit, View and Help on Windows and Linux, with access keys', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const menu = menuTemplate({ ...WIN, platform })
      expect(labels(menu)).toEqual(['&File', '&Edit', '&View', '&Help'])
      expect(labels(menu[0]!.submenu)).toEqual(['Open Folder…', 'Remove Folder', 'Provider Keys…', 'separator', 'Quit'])
      expect(labels(menu[1]!.submenu)).toEqual(['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll'])
      expect(labels(menu[2]!.submenu)).toEqual(['reload', 'separator', 'resetZoom', 'zoomIn', 'zoomOut', 'separator', 'togglefullscreen'])
      expect(labels(menu[3]!.submenu)).toEqual(['Check for Updates…', 'Show Logs', 'MiniDSH on GitHub', 'separator', 'Toggle Developer Tools', 'separator', 'About MiniDSH'])
    }
  })

  it('keeps About, Hide and Quit in the macOS application menu', () => {
    const menu = menuTemplate(MAC)
    expect(labels(menu)).toEqual(['MiniDSH', 'File', 'Edit', 'View', 'Help'])
    expect(labels(menu[0]!.submenu)).toEqual(['About MiniDSH', 'separator', 'hide', 'hideOthers', 'unhide', 'separator', 'Quit MiniDSH'])
    expect(labels(menu[1]!.submenu)).toEqual(['Open Folder…', 'Remove Folder', 'Provider Keys…'])
    expect(labels(menu[4]!.submenu)).toEqual(['Check for Updates…', 'Show Logs', 'MiniDSH on GitHub', 'separator', 'Toggle Developer Tools'])
  })

  it('binds only Open Folder and Quit; Developer Tools has no accelerator', () => {
    for (const state of [WIN, MAC, { ...WIN, platform: 'linux' as const }]) {
      const items = flatten(menuTemplate(state))
      const bound = items.filter((item) => item.accelerator !== undefined).map((item) => [item.id, item.accelerator])
      expect(bound.toSorted((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
        [MENU_IDS.openFolder, 'CmdOrCtrl+O'],
        [MENU_IDS.quit, 'CmdOrCtrl+Q'],
      ])
      const devTools = items.find((item) => item.id === MENU_IDS.toggleDevTools)
      expect(devTools).toEqual({ label: 'Toggle Developer Tools', id: MENU_IDS.toggleDevTools })
    }
  })

  it('opens nothing by itself: every item is a role that opens nothing, an id for main, a submenu or a separator', () => {
    for (const state of [WIN, MAC]) {
      for (const item of flatten(menuTemplate(state))) {
        expect('click' in item).toBe(false)
        if (item.role !== undefined) expect(NO_OPEN_ROLES.has(item.role), item.role).toBe(true)
        else expect(item.id !== undefined || item.submenu !== undefined || item.type === 'separator', JSON.stringify(item)).toBe(true)
      }
    }
  })

  it('lists one Remove Folder item per folder, current marked, & shown as itself, folder in the id', () => {
    const remove = menuTemplate(WIN)[0]!.submenu![1]!
    expect(remove.enabled).toBe(true)
    expect(remove.submenu).toEqual([
      { label: 'C:\\code\\a (current)', id: 'remove-folder:C:\\code\\a' },
      { label: 'C:\\code\\R&&D', id: 'remove-folder:C:\\code\\R&D' },
    ])
    // macOS has no access keys, so an ampersand needs no doubling there.
    expect(menuTemplate({ ...MAC, folders: ['/a&b'] })[1]!.submenu![1]!.submenu![0]!.label).toBe('/a&b')
    expect(folderOfRemoveId(removeFolderId('C:\\code\\R&D'))).toBe('C:\\code\\R&D')
    expect(folderOfRemoveId('remove-folder:')).toBeUndefined()
    expect(folderOfRemoveId(MENU_IDS.openFolder)).toBeUndefined()
  })

  it('disables Remove Folder when there is none', () => {
    const remove = menuTemplate({ ...WIN, folders: [] })[0]!.submenu![1]!
    expect(remove).toEqual({ label: 'Remove Folder', enabled: false, submenu: [] })
  })

  it('uses the ids it is given', () => {
    const ids = { ...MENU_IDS, quit: 'app:quit', removeFolder: 'app:remove' }
    const items = flatten(menuTemplate(WIN, ids))
    expect(items.some((item) => item.id === 'app:quit')).toBe(true)
    expect(items.filter((item) => item.id?.startsWith('app:remove:'))).toHaveLength(2)
    expect(folderOfRemoveId('app:remove:C:\\x', ids)).toBe('C:\\x')
  })
})
