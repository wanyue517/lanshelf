import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { open, save } from '@tauri-apps/plugin-dialog'
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import type { ShelfAPI, ShelfState, TransferProgress } from '../shared/types'

async function getState(): Promise<ShelfState> {
  const value = await invoke<ShelfState>('get_state')
  value.autoStart = await isEnabled().catch(() => false)
  return value
}

function onEvent<T>(name: string, listener: (payload: T) => void): () => void {
  let disposed = false
  let unlisten: (() => void) | undefined
  void listen<T>(name, event => listener(event.payload)).then(fn => {
    if (disposed) fn()
    else unlisten = fn
  })
  return () => {
    disposed = true
    unlisten?.()
  }
}

export const shelfAPI: ShelfAPI = {
  getState,
  onState: callback => onEvent<ShelfState>('shelf:state-changed', async value => {
    value.autoStart = await isEnabled().catch(() => false)
    callback(value)
  }),
  onProgress: callback => onEvent<TransferProgress>('shelf:progress', callback),
  onNotice: callback => onEvent<string>('shelf:notice', callback),
  setExpanded: expanded => invoke('expand', { expanded }),
  selectFiles: async () => {
    const paths = await open({ multiple: true, directory: false, title: '选择共享文件' })
    if (paths) await invoke('add_paths', { paths: Array.isArray(paths) ? paths : [paths] })
  },
  addText: text => invoke('add_text', { text }),
  pairDevice: (deviceId, code) => invoke('pair_device', { deviceId, code }),
  prepareItem: id => invoke('prepare_item', { id }),
  startDrag: async () => {
    throw new Error('Tauri 2 Windows 原生文件拖出仍在开发中，请先使用“另存为”')
  },
  openItem: id => invoke('open_item', { id }),
  saveItem: async id => {
    const item = (await getState()).items.find(value => value.id === id)
    if (!item) throw new Error('文件不存在')
    const destination = await save({ defaultPath: item.name, title: '保存共享文件' })
    if (destination) await invoke('save_item', { id, destination })
  },
  removeItem: id => invoke('remove_item', { id }),
  setAutoStart: async enabled => {
    if (enabled) await enable()
    else await disable()
  },
  copyText: text => { void writeText(text) }
}

export async function installDesktopBridge(): Promise<void> {
  window.lanShelf = shelfAPI
  const webview = getCurrentWebviewWindow()
  await webview.onDragDropEvent(event => {
    if (event.payload.type === 'drop') {
      const paths = event.payload.paths
      if (paths.length) {
        void invoke('add_paths', { paths })
          .catch(error => window.dispatchEvent(new CustomEvent('shelf:local-notice', { detail: String(error) })))
      }
    } else if (event.payload.type === 'enter') {
      void invoke('expand', { expanded: true })
      window.dispatchEvent(new CustomEvent('shelf:expand', { detail: true }))
    }
  })
  onEvent<boolean>('shelf:expanded', expanded => {
    window.dispatchEvent(new CustomEvent('shelf:expand', { detail: expanded }))
  })
}
