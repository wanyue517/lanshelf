export type ItemKind = 'file' | 'folder' | 'text'

export interface SharedItem {
  id: string
  ownerId: string
  name: string
  kind: ItemKind
  size: number
  createdAt: number
}

export interface ShelfItem extends SharedItem {
  ownerName: string
  available: boolean
  cached: boolean
  mine: boolean
}

export interface DeviceInfo {
  id: string
  name: string
  online: boolean
  paired: boolean
}

export interface ShelfState {
  deviceId: string
  deviceName: string
  pairingCode: string
  pairingExpiresAt: number
  items: ShelfItem[]
  devices: DeviceInfo[]
  autoStart: boolean
}

export interface TransferProgress {
  itemId: string
  transferred: number
  total: number
}

export interface ShelfAPI {
  getState: () => Promise<ShelfState>
  onState: (listener: (state: ShelfState) => void) => () => void
  onProgress: (listener: (data: TransferProgress) => void) => () => void
  onNotice: (listener: (message: string) => void) => () => void
  setExpanded: (expanded: boolean) => Promise<void>
  selectFiles: () => Promise<void>
  addText: (text: string) => Promise<void>
  pairDevice: (deviceId: string, code: string) => Promise<void>
  prepareItem: (id: string) => Promise<void>
  startDrag: (id: string) => Promise<void>
  openItem: (id: string) => Promise<void>
  saveItem: (id: string) => Promise<void>
  removeItem: (id: string) => Promise<void>
  setAutoStart: (enabled: boolean) => Promise<void>
  copyText: (text: string) => void
}
