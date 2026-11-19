// The shell overlay's preload: the ONLY renderer API the desktop exposes, and
// only on the overlay's own page. The Web UI is a different webContents with
// no preload at all (S22.2), and main re-checks the sender frame on every
// call (`fromShell` in main.ts), so this guard is the second of two, not the
// boundary. CommonJS because a sandboxed preload cannot be a module.
const { contextBridge, ipcRenderer } = require('electron')

if (location.href.split('#')[0] === 'minidsh-shell://app/index.html') {
  contextBridge.exposeInMainWorld('minidshShell', {
    state: () => ipcRenderer.invoke('shell:state'),
    onView: (callback) => {
      ipcRenderer.on('shell:view', (_event, state) => callback(state))
    },
    chooseFolder: () => ipcRenderer.invoke('shell:chooseFolder'),
    restart: () => ipcRenderer.invoke('shell:restart'),
    quit: () => ipcRenderer.invoke('shell:quit'),
    showLogs: () => ipcRenderer.invoke('shell:showLogs'),
    listKeys: () => ipcRenderer.invoke('shell:listKeys'),
    saveKey: (name, value) => ipcRenderer.invoke('shell:saveKey', String(name), String(value)),
    closeKeys: () => ipcRenderer.invoke('shell:closeKeys'),
  })
}
