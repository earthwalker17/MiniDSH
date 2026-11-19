/**
 * The application menu as plain data. Electron-free: the template is a
 * structural subset of Electron's `MenuItemConstructorOptions`, and main maps
 * it, attaching ONE dispatcher to every item that carries an `id`.
 *
 * No item acts by itself. The only roles used are editing, zoom, reload and
 * the macOS hide trio, which open nothing; everything that opens a dialog, a
 * URL, a folder or DevTools is an `id` main dispatches through its own
 * lifecycle and its one `openExternalSafe`. DevTools in particular has no
 * accelerator (Electron's `toggleDevTools` role would bind Ctrl+Shift+I): it
 * shows the session cookie, so it is opened deliberately, from Help, or not
 * at all.
 *
 * Owns: the menu's shape per platform and the id vocabulary. Must not own:
 * what an id does (main), or the folder list (settings, through main).
 */
import { folderKey } from './folders.ts'

/** The roles this menu uses: none of them opens anything. */
export type MenuRole = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'reload' | 'resetZoom' | 'zoomIn' | 'zoomOut' | 'togglefullscreen' | 'hide' | 'hideOthers' | 'unhide'

export interface MenuItemTemplate {
  readonly label?: string
  readonly role?: MenuRole
  readonly accelerator?: string
  readonly submenu?: readonly MenuItemTemplate[]
  readonly id?: string
  readonly enabled?: boolean
  readonly type?: 'separator'
}

export interface MenuIds {
  readonly openFolder: string
  /** A prefix: each folder's item is `<prefix>:<path>` (`removeFolderId`). */
  readonly removeFolder: string
  readonly providerKeys: string
  readonly quit: string
  readonly checkForUpdates: string
  readonly showLogs: string
  readonly openGitHub: string
  readonly toggleDevTools: string
  readonly about: string
}

export const MENU_IDS: MenuIds = {
  openFolder: 'open-folder',
  removeFolder: 'remove-folder',
  providerKeys: 'provider-keys',
  quit: 'quit',
  checkForUpdates: 'check-for-updates',
  showLogs: 'show-logs',
  openGitHub: 'open-github',
  toggleDevTools: 'toggle-devtools',
  about: 'about',
}

export interface MenuState {
  readonly platform: NodeJS.Platform
  readonly folders: readonly string[]
  readonly current?: string
  readonly appName: string
}

/**
 * The folder rides in the id rather than an index: a menu built before the
 * list changed still names the folder it showed, and main removes it only if
 * it is still in its own settings.
 */
export const removeFolderId = (folder: string, ids: MenuIds = MENU_IDS): string => `${ids.removeFolder}:${folder}`

export function folderOfRemoveId(id: string, ids: MenuIds = MENU_IDS): string | undefined {
  const prefix = `${ids.removeFolder}:`
  return id.startsWith(prefix) && id.length > prefix.length ? id.slice(prefix.length) : undefined
}

const SEPARATOR: MenuItemTemplate = { type: 'separator' }

export function menuTemplate(state: MenuState, ids: MenuIds = MENU_IDS): MenuItemTemplate[] {
  const mac = state.platform === 'darwin'
  // Windows and Linux read `&` as an access-key marker: a path holding one is doubled to show as itself.
  const text = (label: string): string => (mac ? label : label.replace(/&/g, '&&'))
  // Top-level access keys (Alt+F …) where the platform has them.
  const top = (label: string): string => (mac ? label : `&${label}`)
  const currentKey = state.current === undefined ? undefined : folderKey(state.current, state.platform)
  const quit: MenuItemTemplate = { label: mac ? `Quit ${state.appName}` : 'Quit', id: ids.quit, accelerator: 'CmdOrCtrl+Q' }
  const about: MenuItemTemplate = { label: `About ${state.appName}`, id: ids.about }

  const file: MenuItemTemplate = {
    label: top('File'),
    submenu: [
      { label: 'Open Folder…', id: ids.openFolder, accelerator: 'CmdOrCtrl+O' },
      {
        label: 'Remove Folder',
        enabled: state.folders.length > 0,
        submenu: state.folders.map((folder) => ({
          label: text(folderKey(folder, state.platform) === currentKey ? `${folder} (current)` : folder),
          id: removeFolderId(folder, ids),
        })),
      },
      { label: 'Provider Keys…', id: ids.providerKeys },
      ...(mac ? [] : [SEPARATOR, quit]),
    ],
  }
  const edit: MenuItemTemplate = {
    label: top('Edit'),
    submenu: [{ role: 'undo' }, { role: 'redo' }, SEPARATOR, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, SEPARATOR, { role: 'selectAll' }],
  }
  const view: MenuItemTemplate = {
    label: top('View'),
    submenu: [{ role: 'reload' }, SEPARATOR, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, SEPARATOR, { role: 'togglefullscreen' }],
  }
  const help: MenuItemTemplate = {
    label: top('Help'),
    submenu: [
      { label: 'Check for Updates…', id: ids.checkForUpdates },
      { label: 'Show Logs', id: ids.showLogs },
      { label: `${state.appName} on GitHub`, id: ids.openGitHub },
      SEPARATOR,
      { label: 'Toggle Developer Tools', id: ids.toggleDevTools },
      ...(mac ? [] : [SEPARATOR, about]),
    ],
  }
  if (!mac) return [file, edit, view, help]
  // macOS keeps About, Hide and Quit in the application menu, named for the app.
  const app: MenuItemTemplate = {
    label: state.appName,
    submenu: [about, SEPARATOR, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, SEPARATOR, quit],
  }
  return [app, file, edit, view, help]
}
