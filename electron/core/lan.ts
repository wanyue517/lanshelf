import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import net from 'node:net'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { Bonjour } from 'bonjour-service'
import WebSocket, { WebSocketServer } from 'ws'
import type { SharedItem, DeviceInfo, TransferProgress } from '../../shared/types'
import type { ShelfStore, TrustedPeer } from './store'
import { formatDeviceName, generatePairingCode } from './util'

interface DiscoveredPeer {
  id: string
  name: string
  host: string
  port: number
  seenAt: number
}

export class LanNetwork {
  private server?: http.Server
  private bonjour?: Bonjour
  private wsServer?: WebSocketServer
  private browser?: ReturnType<Bonjour['find']>
  private discovered = new Map<string, DiscoveredPeer>()
  private sockets = new Map<string, WebSocket>()
  private remoteItems = new Map<string, SharedItem[]>()
  private attempts = new Map<string, { count: number; until: number }>()
  private maintenance?: NodeJS.Timeout
  private code = generatePairingCode()
  private codeExpiresAt = Date.now() + 5 * 60_000
  private stopped = false

  constructor(
    private readonly store: ShelfStore,
    private readonly onUpdate: () => void
  ) {}

  get pairingCode(): string {
    this.refreshCode()
    return this.code
  }

  get pairingExpiresAt(): number {
    this.refreshCode()
    return this.codeExpiresAt
  }

  get devices(): DeviceInfo[] {
    const ids = new Set([...this.discovered.keys(), ...this.store.trusted.map(peer => peer.id)])
    return [...ids].map(id => {
      const found = this.discovered.get(id)
      const trusted = this.store.getPeer(id)
      const socket = this.sockets.get(id)
      return {
        id,
        name: found?.name ?? trusted?.name ?? '未知设备',
        paired: Boolean(trusted),
        online: Boolean(found && (!trusted || socket?.readyState === WebSocket.OPEN))
      }
    }).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
  }

  get sharedItems(): SharedItem[] {
    return [...this.remoteItems.values()].flat()
  }

  isOnline(deviceId: string): boolean {
    return this.sockets.get(deviceId)?.readyState === WebSocket.OPEN
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => { void this.handleRequest(req, res) })
    this.wsServer = new WebSocketServer({ noServer: true })
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/ws' || !this.authenticate(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      this.wsServer?.handleUpgrade(req, socket, head, ws => {
        this.wsServer?.emit('connection', ws, req)
      })
    })
    this.wsServer.on('connection', (socket, request) => {
      const peer = this.authenticate(request)
      if (!peer) return socket.close()
      socket.on('message', message => {
        if (message.toString() === 'changed') void this.fetchItems(peer.id)
      })
    })

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '0.0.0.0', () => {
        this.server!.off('error', reject)
        resolve()
      })
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('无法获取服务端口')

    try {
      this.bonjour = new Bonjour()
      this.bonjour.publish({
        name: 'LanShelf-' + this.store.deviceId.slice(0, 8),
        type: 'lanshelf',
        protocol: 'tcp',
        port: address.port,
        txt: { id: this.store.deviceId, label: this.store.name }
      })
      this.browser = this.bonjour.find({ type: 'lanshelf', protocol: 'tcp' })
      this.browser.on('up', service => {
        const id = String(service.txt?.id ?? '')
        if (!id || id === this.store.deviceId) return
        const host = service.addresses?.find(value => net.isIP(value) === 4)
        if (!host) return
        const found: DiscoveredPeer = {
          id,
          name: formatDeviceName(String(service.txt?.label || service.name)),
          host,
          port: service.port,
          seenAt: Date.now()
        }
        this.discovered.set(id, found)
        this.connectPeer(id)
        this.onUpdate()
      })
      this.browser.on('down', service => {
        const id = String(service.txt?.id ?? '')
        this.discovered.delete(id)
        this.sockets.get(id)?.close()
        this.onUpdate()
      })
    } catch (error) {
      // Local sharing stays available through the network server; discovery may
      // fail on restricted adapters or when Windows firewall blocks mDNS.
      console.error('mDNS discovery failed:', error)
    }

    this.maintenance = setInterval(() => {
      this.refreshCode()
      for (const peer of this.store.trusted) this.connectPeer(peer.id)
      this.onUpdate()
    }, 10_000)
    this.onUpdate()
  }

  stop(): void {
    this.stopped = true
    if (this.maintenance) clearInterval(this.maintenance)
    for (const socket of this.sockets.values()) socket.terminate()
    this.browser?.stop()
    this.bonjour?.destroy()
    this.wsServer?.close()
    this.server?.close()
  }

  broadcastChanges(): void {
    for (const socket of this.sockets.values()) {
      if (socket.readyState === WebSocket.OPEN) socket.send('changed')
    }
  }

  async pair(deviceId: string, code: string): Promise<void> {
    const remote = this.discovered.get(deviceId)
    if (!remote) throw new Error('目标设备不在线，请检查两台电脑是否处于同一局域网')
    if (!/^\d{6}$/.test(code)) throw new Error('请输入对方显示的 6 位配对码')
    const ourToken = randomBytes(32).toString('hex')
    const response = await fetch(`http://${remote.host}:${remote.port}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: this.store.deviceId,
        name: this.store.name,
        code,
        inboundToken: ourToken
      }),
      signal: AbortSignal.timeout(8000)
    })
    if (!response.ok) throw new Error(response.status === 429 ? '配对尝试过多，请稍后重试' : '配对失败，请确认对方的配对码')
    const result = await response.json() as { token: string; id: string }
    if (result.id !== deviceId || !/^[a-f0-9]{64}$/.test(result.token)) throw new Error('设备身份验证失败')
    this.store.upsertPeer({
      id: deviceId,
      name: remote.name,
      inboundToken: ourToken,
      outboundToken: result.token
    })
    this.connectPeer(deviceId)
    this.onUpdate()
  }

  async download(item: SharedItem, targetPath: string, onProgress: (progress: TransferProgress) => void): Promise<void> {
    const remote = this.discovered.get(item.ownerId)
    const peer = this.store.getPeer(item.ownerId)
    if (!remote || !peer || !this.isOnline(item.ownerId)) throw new Error('来源设备当前离线，无法下载')
    const response = await fetch(`http://${remote.host}:${remote.port}/file/${encodeURIComponent(item.id)}`, {
      headers: { Authorization: `Bearer ${peer.outboundToken}` },
      signal: AbortSignal.timeout(60 * 60_000)
    })
    if (!response.ok || !response.body) throw new Error('文件下载失败，请检查来源设备')
    const { pipeline } = await import('node:stream/promises')
    const { Readable, Transform } = await import('node:stream')
    const { createWriteStream } = await import('node:fs')
    let transferred = 0
    const counter = new Transform({
      transform(chunk: Buffer, _enc, callback) {
        transferred += chunk.length
        onProgress({ itemId: item.id, transferred, total: item.size })
        callback(null, chunk)
      }
    })
    await pipeline(Readable.fromWeb(response.body as any), counter, createWriteStream(targetPath))
    if (item.size !== transferred) throw new Error('文件大小校验失败')
  }

  private refreshCode(): void {
    if (Date.now() < this.codeExpiresAt) return
    this.code = generatePairingCode()
    this.codeExpiresAt = Date.now() + 5 * 60_000
  }

  private authenticate(req: IncomingMessage): TrustedPeer | undefined {
    const authorization = req.headers.authorization ?? ''
    if (!authorization.startsWith('Bearer ')) return undefined
    const token = Buffer.from(authorization.slice(7))
    return this.store.trusted.find(peer => {
      const expected = Buffer.from(peer.inboundToken)
      return expected.length === token.length && timingSafeEqual(expected, token)
    })
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method === 'POST' && req.url === '/pair') {
        const host = req.socket.remoteAddress || 'unknown'
        const attempts = this.attempts.get(host)
        if (attempts && attempts.until > Date.now() && attempts.count >= 5) {
          return this.respond(res, 429, { error: 'too many attempts' })
        }
        const body = await this.readBody(req)
        this.refreshCode()
        if (body.code !== this.code || typeof body.id !== 'string' ||
            !/^[a-zA-Z0-9-]{8,80}$/.test(body.id) ||
            typeof body.inboundToken !== 'string' || !/^[a-f0-9]{64}$/.test(body.inboundToken)) {
          this.attempts.set(host, {
            count: attempts && attempts.until > Date.now() ? attempts.count + 1 : 1,
            until: Date.now() + 5 * 60_000
          })
          return this.respond(res, 403, { error: 'invalid code' })
        }
        this.attempts.delete(host)
        const token = randomBytes(32).toString('hex')
        this.store.upsertPeer({
          id: body.id,
          name: formatDeviceName(String(body.name ?? '未知设备')),
          inboundToken: token,
          outboundToken: body.inboundToken
        })
        this.connectPeer(body.id)
        this.onUpdate()
        return this.respond(res, 200, { id: this.store.deviceId, token })
      }
      const peer = this.authenticate(req)
      if (!peer) return this.respond(res, 401, { error: 'unauthorized' })
      if (req.method === 'GET' && req.url === '/items') {
        return this.respond(res, 200, { items: this.store.items.map(({ filePath: _filePath, ...item }) => item) })
      }
      if (req.method === 'GET' && req.url?.startsWith('/file/')) {
        const id = decodeURIComponent(req.url.slice('/file/'.length))
        const item = this.store.getItem(id)
        if (!item || !existsSync(item.filePath)) return this.respond(res, 404, { error: 'not found' })
        const size = statSync(item.filePath).size
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': size,
          'Cache-Control': 'no-store'
        })
        createReadStream(item.filePath).pipe(res)
        return
      }
      this.respond(res, 404, { error: 'not found' })
    } catch (error) {
      console.error('LAN request failed:', error)
      if (!res.headersSent) this.respond(res, 500, { error: 'request failed' })
      else res.destroy()
    }
  }

  private respond(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(value))
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    let text = ''
    for await (const chunk of req) {
      text += chunk.toString()
      if (text.length > 4096) throw new Error('request too large')
    }
    return JSON.parse(text) as Record<string, unknown>
  }

  private connectPeer(id: string): void {
    if (this.stopped) return
    const remote = this.discovered.get(id)
    const peer = this.store.getPeer(id)
    if (!remote || !peer) return
    const existing = this.sockets.get(id)
    if (existing && [WebSocket.CONNECTING, WebSocket.OPEN].includes(existing.readyState)) return
    const socket = new WebSocket(`ws://${remote.host}:${remote.port}/ws`, {
      headers: { Authorization: `Bearer ${peer.outboundToken}` },
      handshakeTimeout: 5000
    })
    this.sockets.set(id, socket)
    socket.on('open', () => {
      void this.fetchItems(id)
      this.onUpdate()
    })
    socket.on('message', message => {
      if (message.toString() === 'changed') void this.fetchItems(id)
    })
    socket.on('error', () => { /* retry on the maintenance tick */ })
    socket.on('close', () => {
      if (this.sockets.get(id) === socket) this.sockets.delete(id)
      this.onUpdate()
    })
  }

  private async fetchItems(id: string): Promise<void> {
    const remote = this.discovered.get(id)
    const peer = this.store.getPeer(id)
    if (!remote || !peer) return
    try {
      const response = await fetch(`http://${remote.host}:${remote.port}/items`, {
        headers: { Authorization: `Bearer ${peer.outboundToken}` },
        signal: AbortSignal.timeout(8000)
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json() as { items: SharedItem[] }
      if (!Array.isArray(body.items)) throw new Error('invalid response')
      const valid = body.items.filter(item =>
        item && typeof item.id === 'string' && item.ownerId === id &&
        typeof item.name === 'string' && typeof item.size === 'number' &&
        ['file', 'folder', 'text'].includes(item.kind)
      )
      this.remoteItems.set(id, valid)
      this.onUpdate()
    } catch (error) {
      console.warn('Failed to sync peer items:', id, error)
    }
  }
}
