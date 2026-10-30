import { randomBytes } from 'node:crypto'

export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/^\.+/g, '')
    .replace(/[. ]+$/g, '')
    .slice(0, 180)
  if (!cleaned) return 'unnamed'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) return '_' + cleaned
  return cleaned
}

export function generatePairingCode(): string {
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

export function formatDeviceName(name: string): string {
  return name.trim().slice(0, 60) || '未命名设备'
}
