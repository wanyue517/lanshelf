import { contextBridge, ipcRenderer, webUtils, clipboard } from 'electron'
import type { ShelfAPI, ShelfState, TransferProgress } from '../shared/types'

const listen = <T>(channel: string, listener: (value: T) => void): (() => void) => {
  const callback = (_event: Electron.IpcRendererEvent, value: T) => listener(value)
  ipcRenderer.on(channel, callback)
  return () => ipcRenderer.removeListener(channel, callback)
}

const api: ShelfAPI = {
  getState: () => ipcRenderer.invoke('shelf:state'),
  onState: (fn: (state: ShelfState) => void) => listen('shelf:state-changed', fn),
  onProgress: (fn: (value: TransferProgress) => void) => listen('shelf:progress', fn),
  onNotice: (fn: (message: string) => void) => listen('shelf:notice', fn),
  setExpanded: (expanded) => ipcRenderer.invoke('shelf:expand', expanded),
  selectFiles: () => ipcRenderer.invoke('shelf:select'),
  addText: (text) => ipcRenderer.invoke('shelf:add-text', text),
  pairDevice: (id, code) => ipcRenderer.invoke('shelf:pair', id, code),
  prepareItem: (id) => ipcRenderer.invoke('shelf:prepare', id),
  startDrag: (id) => ipcRenderer.invoke('shelf:drag', id),
  openItem: (id) => ipcRenderer.invoke('shelf:open', id),
  saveItem: (id) => ipcRenderer.invoke('shelf:save', id),
  removeItem: (id) => ipcRenderer.invoke('shelf:remove', id),
  setAutoStart: (enabled) => ipcRenderer.invoke('shelf:auto-start', enabled),
  copyText: (text) => clipboard.writeText(text)
}

contextBridge.exposeInMainWorld('lanShelf', api)

// The sandboxed renderer does not receive local file paths.
// webUtils resolves dropped File objects in the privileged preload only.
window.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('dragover', event => event.preventDefault(), true)
  document.addEventListener('drop', event => {
    event.preventDefault()
    const paths = [...(event.dataTransfer?.files ?? [])]
      .map(file => webUtils.getPathForFile(file))
      .filter(Boolean)
    if (paths.length > 0) ipcRenderer.send('shelf:add-paths', paths)
  }, true)
})
