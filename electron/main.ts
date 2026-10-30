import path from 'node:path'
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron'
import { ShelfStore } from './core/store'
import { ShelfEngine } from './core/engine'

const TRAY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAo0lEQVR4nO2W3Q2AIAyEC3EI0el0MJlOdAt98w8oASuQ2O/Rht7ZI1oAhvk7Ait2w7JRCRmtnFrOh5TCISMyp7irv8SKOUxYE8jNkYfv7eepdR7sx/W1uNFKoBPwiYdqMRSPADWAjZkiAgCAJvVgTASY2eQ7EAPWp+47wAbYQHEDVB8brM9tOcj1OwY4F5O6IvDtbdRcdawJfG3i2b/4VswUZwcwNDYsyYWXBQAAAABJRU5ErkJggg=='
const icon = nativeImage.createFromDataURL('data:image/png;base64,' + TRAY_PNG)
const COMPACT = { width: 196, height: 52 }
const EXPANDED = { width: 472, height: 580 }

let window: BrowserWindow | undefined
let tray: Tray | undefined
let engine: ShelfEngine
let quitting = false
let expanded = false

function showNotice(message: string): void {
  window?.webContents.send('shelf:notice', message)
}

function emitState(): void {
  if (!window || window.isDestroyed()) return
  window.webContents.send('shelf:state-changed', engine.state)
}

function positionWindow(isExpanded: boolean): void {
  if (!window) return
  const point = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(point)
  const area = display.workArea
  const dimensions = isExpanded ? EXPANDED : COMPACT
  window.setBounds({
    x: Math.round(area.x + (area.width - dimensions.width) / 2),
    y: area.y + 8,
    ...dimensions
  }, false)
}

function setExpanded(value: boolean): void {
  expanded = value
  positionWindow(value)
  window?.show()
  if (value) window?.focus()
}

function makeWindow(): void {
  window = new BrowserWindow({
    ...COMPACT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true
    }
  })
  window.setAlwaysOnTop(true, 'floating')
  positionWindow(false)
  window.on('close', event => {
    if (!quitting) {
      event.preventDefault()
      window?.hide()
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  if (app.isPackaged) {
    void window.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'))
  } else {
    void window.loadURL('http://127.0.0.1:5173')
    window.webContents.openDevTools({ mode: 'detach', activate: false })
  }
  window.once('ready-to-show', () => window?.show())
}

function makeTray(): void {
  tray = new Tray(icon)
  tray.setToolTip('LanShelf · 局域网共享文件架')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '展开文件架', click: () => setExpanded(true) },
    { label: '显示悬浮入口', click: () => setExpanded(false) },
    { type: 'separator' },
    { label: '退出 LanShelf', click: () => { quitting = true; app.quit() } }
  ]))
  tray.on('double-click', () => setExpanded(true))
  tray.on('click', () => {
    if (!window?.isVisible()) setExpanded(false)
    else setExpanded(!expanded)
  })
}

async function runAction<T>(action: () => Promise<T> | T): Promise<T> {
  try {
    return await action()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    showNotice(message)
    throw error
  }
}

function registerIpc(): void {
  ipcMain.handle('shelf:state', () => engine.state)
  ipcMain.handle('shelf:expand', (_event, value: boolean) => setExpanded(value))
  ipcMain.handle('shelf:select', () => runAction(async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: '添加到共享文件架',
      properties: ['openFile', 'openDirectory', 'multiSelections']
    })
    if (!result.canceled) {
      await engine.addPaths(result.filePaths)
      showNotice('已添加到共享文件架')
    }
  }))
  ipcMain.handle('shelf:add-text', (_event, value: string) => runAction(async () => {
    await engine.addText(value)
    showNotice('文本已共享')
  }))
  ipcMain.on('shelf:add-paths', (_event, paths: string[]) => {
    void runAction(() => engine.addPaths(paths)).then(() => showNotice('文件已共享')).catch(() => {})
  })
  ipcMain.handle('shelf:pair', (_event, id: string, code: string) =>
    runAction(() => engine.network.pair(id, code)))
  ipcMain.handle('shelf:prepare', (_event, id: string) =>
    runAction(async () => { await engine.prepare(id) }))
  ipcMain.handle('shelf:drag', (_event, id: string) => runAction(async () => {
    const file = await engine.prepare(id)
    window?.webContents.startDrag({ file, icon })
  }))
  ipcMain.handle('shelf:open', (_event, id: string) => runAction(async () => {
    const file = await engine.prepare(id)
    const error = await shell.openPath(file)
    if (error) throw new Error(error)
  }))
  ipcMain.handle('shelf:save', (_event, id: string) => runAction(async () => {
    const item = engine.state.items.find(entry => entry.id === id)
    if (!item) throw new Error('文件不存在')
    const result = await dialog.showSaveDialog(window!, { defaultPath: item.name })
    if (!result.canceled && result.filePath) {
      const source = await engine.prepare(id)
      await (await import('node:fs/promises')).copyFile(source, result.filePath)
      showNotice('文件已保存')
    }
  }))
  ipcMain.handle('shelf:remove', (_event, id: string) => runAction(() => engine.remove(id)))
  ipcMain.handle('shelf:auto-start', (_event, enabled: boolean) => runAction(() => {
    app.setLoginItemSettings({ openAtLogin: enabled })
    engine.store.setAutoStart(enabled)
    emitState()
  }))
  ipcMain.handle('shelf:copy-text', (_event, value: string) => clipboard.writeText(value))
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('online.wanyue.lanshelf')
  const store = new ShelfStore(app.getPath('userData'))
  engine = new ShelfEngine(store, emitState, progress => {
    window?.webContents.send('shelf:progress', progress)
  })
  registerIpc()
  makeWindow()
  makeTray()
  globalShortcut.register('Control+Shift+Space', () => setExpanded(!expanded))
  try {
    await engine.network.start()
  } catch (error) {
    console.error('Network failed to start:', error)
    showNotice('局域网服务启动失败，请检查端口和防火墙')
  }
}).catch(error => {
  console.error('LanShelf failed to start:', error)
  app.quit()
})

app.on('before-quit', () => { quitting = true })
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  engine?.network.stop()
})
app.on('window-all-closed', () => { /* keep running in the system tray */ })
