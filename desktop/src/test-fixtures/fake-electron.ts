/**
 * A stand-in for the `electron` module, for `main.test.ts`. main.ts is wiring
 * and the lifecycle's ordering over Electron; this is just enough Electron
 * for that ordering to RUN under Node: an app that quits the way Electron's
 * does (`before-quit`, each window's preventable `close`, `closed`,
 * `window-all-closed`, `will-quit`), one window, one overlay view, dialogs
 * that answer what a test set, and a record of what main asked of each.
 *
 * It is not a model of Electron. Nothing here draws, loads or confines
 * anything, and a destroyed object does not throw as the real one does: what
 * the real app does with a real window stays the packaged E2E's to prove
 * (desktop/e2e). What this adds is the ORDER of main's own steps around a
 * quit, a start and a save, decided by a test instead of by a runner's speed.
 */
import { EventEmitter } from 'node:events'

export interface PreventableEvent {
  defaultPrevented: boolean
  preventDefault(): void
}

const preventable = (): PreventableEvent => ({
  defaultPrevented: false,
  preventDefault() {
    this.defaultPrevented = true
  },
})

export interface MessageBoxOptions {
  readonly message?: string
  readonly detail?: string
  readonly buttons?: readonly string[]
}

export class FakeWebContents extends EventEmitter {
  private static nextId = 1
  readonly id = FakeWebContents.nextId++
  readonly mainFrame: { url: string } = { url: '' }
  /** Every URL main asked this to load, in order. */
  readonly loads: string[] = []
  /** Every message main sent to the page. */
  readonly sent: { readonly channel: string; readonly payload: unknown }[] = []
  private destroyed = false
  /** A test's switch: a load of a URL this answers true for FAILS, as a missing or unreadable page does. */
  static failing: ((url: string) => boolean) | undefined

  loadURL(url: string): Promise<void> {
    this.loads.push(url)
    this.mainFrame.url = url
    // Later, never during the call: main attaches its `did-finish-load`
    // listener after it asks for the load, as it may with the real thing.
    setImmediate(() => {
      if (this.destroyed) return
      if (FakeWebContents.failing?.(url) === true) this.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', url, true)
      else this.emit('did-finish-load')
    })
    return Promise.resolve()
  }

  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload })
  }

  setWindowOpenHandler(): void {}
  focus(): void {}
  toggleDevTools(): void {}

  isDestroyed(): boolean {
    return this.destroyed
  }

  close(): void {
    this.destroyed = true
  }
}

export class FakeView {
  readonly webContents = new FakeWebContents()
  setBounds(): void {}
  setBackgroundColor(): void {}
}

class FakeContentView {
  readonly children: FakeView[] = []

  addChildView(view: FakeView): void {
    if (!this.children.includes(view)) this.children.push(view)
  }

  removeChildView(view: FakeView): void {
    const at = this.children.indexOf(view)
    if (at >= 0) this.children.splice(at, 1)
  }
}

export function createFakeElectron() {
  const windows: FakeWindow[] = []
  const views: FakeView[] = []
  const { promise: ready, resolve: becomeReady } = Promise.withResolvers<void>()
  const { promise: quitted, resolve: haveQuit } = Promise.withResolvers<void>()

  class FakeApp extends EventEmitter {
    readonly isPackaged = false
    readonly commandLine = { hasSwitch: (): boolean => false }
    /** Every code main passed to `app.exit`. */
    readonly exits: number[] = []
    quitCalls = 0
    hasQuit = false
    private readonly paths = new Map<string, string>()

    setPath(name: string, value: string): void {
      this.paths.set(name, value)
    }

    getPath(name: string): string {
      const path = this.paths.get(name)
      if (path === undefined) throw new Error(`fake electron: main asked for the path "${name}", which the test never set`)
      return path
    }

    setAppLogsPath(path?: string): void {
      if (path !== undefined) this.paths.set('logs', path)
    }

    setAppUserModelId(): void {}
    requestSingleInstanceLock(): boolean {
      return true
    }
    whenReady(): Promise<void> {
      return ready
    }
    getVersion(): string {
      return '0.0.0-fake'
    }
    exit(code = 0): void {
      this.exits.push(code)
    }

    /** As Electron's: `before-quit` may veto; otherwise every window is asked to close, and the app ends once none is left. */
    quit(): void {
      this.quitCalls += 1
      if (this.hasQuit) return
      const event = preventable()
      this.emit('before-quit', event)
      if (event.defaultPrevented) return
      for (const window of windows) window.close()
      // A window that vetoed its close keeps the app; and `window-all-closed`
      // may have quit already, from inside the loop above.
      if (windows.some((window) => !window.isDestroyed()) || this.hasQuit) return
      this.hasQuit = true
      this.emit('will-quit', preventable())
      haveQuit()
    }
  }

  const app = new FakeApp()

  class FakeWindow extends EventEmitter {
    readonly webContents = new FakeWebContents()
    readonly contentView = new FakeContentView()
    shown = false
    private destroyed = false
    private readonly bounds: { x: number; y: number; width: number; height: number }

    constructor(options: { readonly x?: number; readonly y?: number; readonly width?: number; readonly height?: number } = {}) {
      super()
      this.bounds = { x: options.x ?? 40, y: options.y ?? 40, width: options.width ?? 1280, height: options.height ?? 840 }
      windows.push(this)
    }

    /** The person's close, or the app's: `close` may veto it. */
    close(): void {
      if (this.destroyed) return
      const event = preventable()
      this.emit('close', event)
      if (event.defaultPrevented) return
      this.destroyed = true
      this.webContents.close()
      this.emit('closed')
      if (windows.every((window) => window.isDestroyed())) app.emit('window-all-closed')
    }

    /** The person moved the window: what makes main save its bounds. */
    moveTo(x: number, y: number): void {
      this.bounds.x = x
      this.bounds.y = y
      this.emit('moved')
    }

    /** The window gone with no `close` asked of anyone: what a crash of its renderer host, or the OS, does. */
    destroy(): void {
      if (this.destroyed) return
      this.destroyed = true
      this.webContents.close()
      this.emit('closed')
      if (windows.every((window) => window.isDestroyed())) app.emit('window-all-closed')
    }

    isDestroyed(): boolean {
      return this.destroyed
    }
    isVisible(): boolean {
      return this.shown
    }
    isMinimized(): boolean {
      return false
    }
    isMaximized(): boolean {
      return false
    }
    getBounds(): { x: number; y: number; width: number; height: number } {
      return { ...this.bounds }
    }
    getNormalBounds(): { x: number; y: number; width: number; height: number } {
      return { ...this.bounds }
    }
    getContentSize(): [number, number] {
      return [this.bounds.width, this.bounds.height]
    }
    show(): void {
      this.shown = true
    }
    focus(): void {}
    restore(): void {}
    maximize(): void {}
    setBackgroundColor(): void {}
  }

  class TrackedView extends FakeView {
    constructor() {
      super()
      views.push(this)
    }
  }

  const makeSession = () => ({
    setPermissionRequestHandler: (): void => {},
    setPermissionCheckHandler: (): void => {},
    setDevicePermissionHandler: (): void => {},
    setDisplayMediaRequestHandler: (): void => {},
    setProxy: (): Promise<void> => Promise.resolve(),
    on: (): void => {},
    webRequest: { onBeforeSendHeaders: (): void => {}, onHeadersReceived: (): void => {} },
    protocol: { handle: (): void => {} },
  })
  const sessions = new Map<string, ReturnType<typeof makeSession>>()
  const defaultSession = makeSession()

  const dialog = {
    /** Every message box main showed. */
    messageBoxes: [] as MessageBoxOptions[],
    /** The button every message box answers with, by index. A test sets it: nothing is answered by default behaviour it did not choose. */
    answer: undefined as number | undefined,
    /** What the next folder picker returns. */
    openResult: { canceled: true, filePaths: [] as string[] },
    errorBoxes: [] as string[],
    showMessageBox(...args: unknown[]): Promise<{ response: number }> {
      const options = (args.length > 1 ? args[1] : args[0]) as MessageBoxOptions
      dialog.messageBoxes.push(options)
      if (dialog.answer === undefined) throw new Error(`fake electron: main showed a message box the test set no answer for: ${options.message ?? ''} ${options.detail ?? ''}`)
      return Promise.resolve({ response: dialog.answer })
    },
    showOpenDialog(): Promise<{ canceled: boolean; filePaths: string[] }> {
      return Promise.resolve(dialog.openResult)
    },
    showErrorBox(title: string, content: string): void {
      dialog.errorBoxes.push(`${title}: ${content}`)
    },
  }

  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false })

  /** What `import … from 'electron'` gives main.ts. */
  const module = {
    app,
    BrowserWindow: FakeWindow,
    WebContentsView: TrackedView,
    dialog,
    ipcMain: {
      handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void => {
        handlers.set(channel, listener)
      },
    },
    Menu: {
      setApplicationMenu: (): void => {},
      buildFromTemplate: (template: unknown): { template: unknown; popup(): void } => ({ template, popup: (): void => {} }),
    },
    nativeTheme,
    net: { fetch: (): Promise<never> => Promise.reject(new Error('fake electron: no network')) },
    protocol: { registerSchemesAsPrivileged: (): void => {} },
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },
    session: {
      defaultSession,
      fromPartition: (name: string) => {
        const existing = sessions.get(name)
        if (existing !== undefined) return existing
        const made = makeSession()
        sessions.set(name, made)
        return made
      },
    },
    shell: { openExternal: (): Promise<void> => Promise.resolve(), openPath: (): Promise<string> => Promise.resolve('') },
  }

  return {
    module,
    app,
    dialog,
    windows,
    views,
    /** Electron became ready: main builds its window and starts. */
    becomeReady,
    /** Resolves when the app has quit (`will-quit` was emitted). */
    quitted,
    /** Every view main sent the shell page, in order. */
    shellViews(): { readonly kind?: string; readonly notice?: string; readonly title?: string }[] {
      return (views[0]?.webContents.sent ?? [])
        .filter((message) => message.channel === 'shell:view')
        .map((message) => ((message.payload as { view?: object }).view ?? {}) as { kind?: string; notice?: string; title?: string })
    },
    /** A call from the shell page, as its preload would make it: from the overlay's own main frame. */
    invokeShell(channel: string, ...args: unknown[]): unknown {
      const handler = handlers.get(channel)
      const overlay = views[0]
      if (handler === undefined || overlay === undefined) throw new Error(`fake electron: no handler for ${channel}, or no overlay yet`)
      return handler({ sender: overlay.webContents, senderFrame: overlay.webContents.mainFrame }, ...args)
    },
  }
}

export type FakeElectron = ReturnType<typeof createFakeElectron>
