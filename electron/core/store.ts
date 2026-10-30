import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { SharedItem } from '../../shared/types'
import { formatDeviceName } from './util'

export interface LocalItem extends SharedItem {
  filePath: string
}
export interface TrustedPeer {
  id: string
  name: string
  inboundToken: string
  outboundToken: string
}
interface StoreData {
  deviceId: string
  name: string
  items: LocalItem[]
  trusted: TrustedPeer[]
  autoStart: boolean
}

export class ShelfStore {
  private readonly statePath: string
  private data: StoreData

  constructor(readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true })
    this.statePath = path.join(dataDir, 'state.json')
    const defaults: StoreData = {
      deviceId: randomUUID(),
      name: formatDeviceName(os.hostname()),
      items: [],
      trusted: [],
      autoStart: false
    }
    try {
      this.data = { ...defaults, ...JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as Partial<StoreData> }
    } catch {
      this.data = defaults
    }
    this.save()
  }

  get deviceId(): string { return this.data.deviceId }
  get name(): string { return this.data.name }
  get items(): LocalItem[] { return [...this.data.items] }
  get trusted(): TrustedPeer[] { return [...this.data.trusted] }
  get autoStart(): boolean { return this.data.autoStart }

  getItem(id: string): LocalItem | undefined {
    return this.data.items.find(item => item.id === id)
  }

  addItem(item: LocalItem): void {
    this.data.items.unshift(item)
    this.save()
  }

  removeItem(id: string): LocalItem | undefined {
    const item = this.getItem(id)
    if (item) {
      this.data.items = this.data.items.filter(entry => entry.id !== id)
      this.save()
    }
    return item
  }

  upsertPeer(peer: TrustedPeer): void {
    this.data.trusted = this.data.trusted.filter(entry => entry.id !== peer.id)
    this.data.trusted.push(peer)
    this.save()
  }

  getPeer(id: string): TrustedPeer | undefined {
    return this.data.trusted.find(entry => entry.id === id)
  }

  setAutoStart(enabled: boolean): void {
    this.data.autoStart = enabled
    this.save()
  }

  private save(): void {
    const temporary = this.statePath + '.tmp'
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    fs.renameSync(temporary, this.statePath)
  }
}
