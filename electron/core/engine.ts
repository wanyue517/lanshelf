import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import archiver from 'archiver'
import type { SharedItem, ShelfItem, ShelfState, TransferProgress } from '../../shared/types'
import { ShelfStore } from './store'
import { LanNetwork } from './lan'
import { safeFileName } from './util'

export class ShelfEngine {
  readonly network: LanNetwork
  private readonly filesDir: string
  private readonly cacheDir: string
  private downloads = new Map<string, Promise<string>>()

  constructor(
    readonly store: ShelfStore,
    private readonly onUpdate: () => void,
    private readonly onProgress: (progress: TransferProgress) => void
  ) {
    this.filesDir = path.join(store.dataDir, 'files')
    this.cacheDir = path.join(store.dataDir, 'cache')
    fs.mkdirSync(this.filesDir, { recursive: true })
    fs.mkdirSync(this.cacheDir, { recursive: true })
    this.network = new LanNetwork(store, onUpdate)
  }

  get state(): ShelfState {
    const items: ShelfItem[] = [
      ...this.store.items.map(item => ({
        id: item.id, name: item.name, kind: item.kind, size: item.size,
        createdAt: item.createdAt, ownerId: item.ownerId,
        ownerName: this.store.name,
        mine: true, cached: fs.existsSync(item.filePath),
        available: fs.existsSync(item.filePath)
      })),
      ...this.network.sharedItems.map(item => ({
        ...item,
        ownerName: this.store.getPeer(item.ownerId)?.name ?? '其他设备',
        mine: false,
        cached: fs.existsSync(this.cachePath(item)),
        available: this.network.isOnline(item.ownerId) || fs.existsSync(this.cachePath(item))
      }))
    ]
    return {
      deviceId: this.store.deviceId,
      deviceName: this.store.name,
      pairingCode: this.network.pairingCode,
      pairingExpiresAt: this.network.pairingExpiresAt,
      autoStart: this.store.autoStart,
      items: items.sort((a, b) => b.createdAt - a.createdAt),
      devices: this.network.devices
    }
  }

  async addPaths(paths: string[]): Promise<void> {
    for (const original of new Set(paths)) {
      if (!original) continue
      const source = path.resolve(original)
      const info = await fs.promises.stat(source)
      if (!info.isFile() && !info.isDirectory()) continue
      const id = randomUUID()
      const dir = path.join(this.filesDir, id)
      await fs.promises.mkdir(dir, { recursive: true })
      const basename = safeFileName(path.basename(source))
      const isFolder = info.isDirectory()
      const name = isFolder ? basename + '.zip' : basename
      const target = path.join(dir, name)
      try {
        if (isFolder) await this.zipDirectory(source, target)
        else await fs.promises.copyFile(source, target)
        const actual = await fs.promises.stat(target)
        this.store.addItem({
          id, ownerId: this.store.deviceId, name,
          kind: isFolder ? 'folder' : 'file',
          size: actual.size, createdAt: Date.now(), filePath: target
        })
        this.changed()
      } catch (error) {
        await fs.promises.rm(dir, { recursive: true, force: true })
        throw error
      }
    }
  }

  async addText(text: string): Promise<void> {
    if (!text.trim()) throw new Error('文本不能为空')
    const id = randomUUID()
    const dir = path.join(this.filesDir, id)
    await fs.promises.mkdir(dir, { recursive: true })
    const name = '文本-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt'
    const filePath = path.join(dir, name)
    await fs.promises.writeFile(filePath, text, 'utf8')
    const info = await fs.promises.stat(filePath)
    this.store.addItem({
      id, ownerId: this.store.deviceId, name, kind: 'text',
      size: info.size, createdAt: Date.now(), filePath
    })
    this.changed()
  }

  async remove(id: string): Promise<void> {
    const item = this.store.removeItem(id)
    if (!item) throw new Error('只能删除本机添加的共享文件')
    this.changed()
    await fs.promises.rm(path.dirname(item.filePath), { recursive: true, force: true })
  }

  async prepare(id: string): Promise<string> {
    const local = this.store.getItem(id)
    if (local) {
      if (!fs.existsSync(local.filePath)) throw new Error('源文件已丢失')
      return local.filePath
    }
    const item = this.network.sharedItems.find(entry => entry.id === id)
    if (!item) throw new Error('文件不存在或设备尚未同步')
    const target = this.cachePath(item)
    if (fs.existsSync(target)) return target
    const key = item.ownerId + ':' + item.id
    const inflight = this.downloads.get(key)
    if (inflight) return inflight
    const promise = this.download(item, target)
    this.downloads.set(key, promise)
    try {
      return await promise
    } finally {
      this.downloads.delete(key)
    }
  }

  private async download(item: SharedItem, target: string): Promise<string> {
    const temporary = target + '.part'
    try {
      await this.network.download(item, temporary, this.onProgress)
      await fs.promises.rename(temporary, target)
      this.onUpdate()
      return target
    } catch (error) {
      await fs.promises.rm(temporary, { force: true })
      throw error
    }
  }

  private cachePath(item: SharedItem): string {
    return path.join(this.cacheDir, item.ownerId + '-' + item.id + '-' + safeFileName(item.name))
  }

  private changed(): void {
    this.onUpdate()
    this.network.broadcastChanges()
  }

  private async zipDirectory(source: string, target: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(target)
      const archive = archiver('zip', { zlib: { level: 5 } })
      output.on('close', () => resolve())
      output.on('error', reject)
      archive.on('error', reject)
      archive.pipe(output)
      archive.directory(source, false)
      void archive.finalize().catch(reject)
    })
  }
}
