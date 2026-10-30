<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { DeviceInfo, ShelfItem, ShelfState, TransferProgress } from '../shared/types'

type Tab = 'files' | 'devices' | 'settings'
type Scope = 'all' | 'mine' | 'remote'

const emptyState: ShelfState = {
  deviceId: '', deviceName: '', pairingCode: '------', pairingExpiresAt: 0,
  items: [], devices: [], autoStart: false
}
const state = ref<ShelfState>(emptyState)
const expanded = ref(false)
const tab = ref<Tab>('files')
const scope = ref<Scope>('all')
const query = ref('')
const layout = ref<'grid' | 'list'>('grid')
const inputCodes = ref<Record<string, string>>({})
const busyItems = ref<Record<string, boolean>>({})
const progress = ref<Record<string, TransferProgress>>({})
const notice = ref('')
const textEditor = ref(false)
const textValue = ref('')
const draggingIn = ref(false)
const working = ref(false)
let noticeTimeout: ReturnType<typeof setTimeout> | undefined
const unsubscribers: Array<() => void> = []

const onlineCount = computed(() => state.value.devices.filter(device => device.online && device.paired).length)
const filtered = computed(() => state.value.items.filter(item => {
  if (scope.value === 'mine' && !item.mine) return false
  if (scope.value === 'remote' && item.mine) return false
  return item.name.toLowerCase().includes(query.value.trim().toLowerCase())
}))
const totalSize = computed(() => state.value.items.reduce((sum, item) => sum + item.size, 0))
const pendingDevices = computed(() => state.value.devices.filter(device => !device.paired))
const pairedDevices = computed(() => state.value.devices.filter(device => device.paired))
const currentCodeTime = computed(() => new Date(state.value.pairingExpiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))

function message(text: string): void {
  notice.value = text
  if (noticeTimeout) clearTimeout(noticeTimeout)
  noticeTimeout = setTimeout(() => { notice.value = '' }, 3500)
}

async function action(job: () => Promise<unknown>): Promise<void> {
  try { await job() }
  catch (error) { message(error instanceof Error ? error.message : String(error)) }
}

async function toggle(expand: boolean): Promise<void> {
  expanded.value = expand
  await action(() => window.lanShelf.setExpanded(expand))
}

async function selectFiles(): Promise<void> {
  await action(() => window.lanShelf.selectFiles())
}

async function addText(): Promise<void> {
  if (!textValue.value.trim()) return message('请先输入要共享的文本')
  working.value = true
  try {
    await window.lanShelf.addText(textValue.value)
    textEditor.value = false
    textValue.value = ''
  } catch (error) {
    message(error instanceof Error ? error.message : String(error))
  } finally {
    working.value = false
  }
}

async function pair(device: DeviceInfo): Promise<void> {
  const code = inputCodes.value[device.id]?.trim() ?? ''
  if (!/^\d{6}$/.test(code)) return message('请输入对方设备上显示的 6 位配对码')
  busyItems.value[device.id] = true
  try {
    await window.lanShelf.pairDevice(device.id, code)
    message('设备已配对，正在同步文件')
  } catch (error) {
    message(error instanceof Error ? error.message : String(error))
  } finally {
    busyItems.value[device.id] = false
  }
}

async function prepare(item: ShelfItem): Promise<void> {
  if (busyItems.value[item.id]) return
  busyItems.value[item.id] = true
  try { await window.lanShelf.prepareItem(item.id) }
  catch (error) { message(error instanceof Error ? error.message : String(error)) }
  finally { busyItems.value[item.id] = false; delete progress.value[item.id] }
}

async function openItem(item: ShelfItem): Promise<void> {
  await action(() => window.lanShelf.openItem(item.id))
}

async function saveItem(item: ShelfItem): Promise<void> {
  await action(() => window.lanShelf.saveItem(item.id))
}

async function removeItem(item: ShelfItem): Promise<void> {
  if (!window.confirm(`确定从共享文件架删除「${item.name}」？所有设备都将不再看到它。`)) return
  await action(() => window.lanShelf.removeItem(item.id))
}

async function startNativeDrag(event: DragEvent, item: ShelfItem): Promise<void> {
  event.preventDefault()
  event.stopPropagation()
  if (!item.available) return message('来源设备离线，文件暂时不可用')
  if (!item.cached) return message('远程文件首次拖出前，请先点击下载按钮')
  await action(() => window.lanShelf.startDrag(item.id))
}

function iconFor(item: ShelfItem): string {
  if (item.kind === 'folder' || /\.zip$/i.test(item.name)) return '🗜️'
  if (item.kind === 'text') return '📝'
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(item.name)) return '🖼️'
  if (/\.pdf$/i.test(item.name)) return '📕'
  if (/\.(mp4|mov|mkv|webm)$/i.test(item.name)) return '🎞️'
  if (/\.(js|ts|vue|json|sql|html|css|md)$/i.test(item.name)) return '⌨️'
  return '📄'
}

function formatBytes(value: number): string {
  if (value < 1024) return value + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)) - 1, units.length - 1)
  return (value / 1024 ** (unit + 1)).toFixed(unit < 2 ? 1 : 2) + ' ' + units[unit]
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function copyCode(): void {
  window.lanShelf.copyText(state.value.pairingCode)
  message('配对码已复制')
}

async function changeAutoStart(event: Event): Promise<void> {
  const enabled = (event.target as HTMLInputElement).checked
  await action(() => window.lanShelf.setAutoStart(enabled))
}

function onDragEnter(event: DragEvent): void {
  if (event.dataTransfer?.types.includes('Files')) {
    draggingIn.value = true
    if (!expanded.value) void toggle(true)
  }
}

function onDragLeave(event: DragEvent): void {
  if (!event.relatedTarget) draggingIn.value = false
}

onMounted(() => {
  unsubscribers.push(window.lanShelf.onState(value => { state.value = value }))
  unsubscribers.push(window.lanShelf.onProgress(value => { progress.value[value.itemId] = value }))
  unsubscribers.push(window.lanShelf.onNotice(message))
  void window.lanShelf.getState().then(value => { state.value = value }).catch(error => message(String(error)))
})
onUnmounted(() => {
  unsubscribers.forEach(unsubscribe => unsubscribe())
  if (noticeTimeout) clearTimeout(noticeTimeout)
})
</script>

<template>
  <div class="shell" @dragenter="onDragEnter" @dragleave="onDragLeave" @drop.prevent="draggingIn = false">
    <button v-if="!expanded" class="compact" title="展开 LanShelf" @click="toggle(true)">
      <span class="brand-icon">▣</span>
      <span class="compact-name">LanShelf</span>
      <span v-if="state.items.length" class="compact-count">{{ state.items.length }}</span>
      <span class="compact-chevron">⌄</span>
    </button>

    <section v-else class="panel" aria-label="LanShelf 共享文件架">
      <header class="panel-header">
        <div class="header-brand">
          <span class="brand-icon">▣</span>
          <div>
            <strong>LanShelf</strong>
            <span class="brand-desc">跨设备共享文件架</span>
          </div>
        </div>
        <div class="header-actions">
          <span class="online-dot"></span>
          <span class="online-text">{{ onlineCount }} 台在线</span>
          <button class="icon-button collapse" aria-label="收起" title="收起文件架" @click="toggle(false)">⌃</button>
        </div>
      </header>

      <nav class="tabs" aria-label="切换功能">
        <button :class="{ active: tab === 'files' }" @click="tab = 'files'">共享文件 <span class="tab-count">{{ state.items.length }}</span></button>
        <button :class="{ active: tab === 'devices' }" @click="tab = 'devices'">设备 <span v-if="state.devices.length" class="tab-count">{{ state.devices.length }}</span></button>
        <button :class="{ active: tab === 'settings' }" @click="tab = 'settings'">设置</button>
      </nav>

      <main v-if="tab === 'files'" class="content files-content">
        <div class="tools-row">
          <label class="search">
            <span aria-hidden="true">⌕</span>
            <input v-model="query" placeholder="搜索共享文件…" aria-label="搜索共享文件"/>
          </label>
          <button class="tool-button" title="添加文件或文件夹" @click="selectFiles">＋</button>
          <button class="tool-button" title="共享文本" @click="textEditor = true">T</button>
        </div>

        <div class="filter-row">
          <div class="filter-pills" aria-label="筛选文件">
            <button :class="{ selected: scope === 'all' }" @click="scope = 'all'">全部</button>
            <button :class="{ selected: scope === 'mine' }" @click="scope = 'mine'">本机</button>
            <button :class="{ selected: scope === 'remote' }" @click="scope = 'remote'">其他设备</button>
          </div>
          <button class="layout-button" :title="layout === 'grid' ? '切换列表' : '切换网格'" @click="layout = layout === 'grid' ? 'list' : 'grid'">
            {{ layout === 'grid' ? '☷' : '▦' }}
          </button>
        </div>

        <div v-if="filtered.length" class="file-scroller">
          <div class="file-grid" :class="{ 'file-list': layout === 'list' }">
            <div v-for="item in filtered" :key="item.ownerId + ':' + item.id"
              class="file-card" :class="{ unavailable: !item.available, 'is-busy': busyItems[item.id] }"
              :draggable="item.cached && item.available"
              :title="item.cached ? '拖出到桌面或其他应用；双击直接打开' : '点击下载到本机缓存后即可拖出'"
              @dragstart="startNativeDrag($event, item)"
              @dblclick="openItem(item)">
              <span class="file-symbol">{{ iconFor(item) }}</span>
              <div class="file-data">
                <span class="file-name" :title="item.name">{{ item.name }}</span>
                <span class="file-detail">{{ formatBytes(item.size) }} · {{ item.mine ? '本机' : item.ownerName }}</span>
              </div>
              <div class="file-actions">
                <button v-if="!item.cached && item.available" class="mini-action" title="下载到本地缓存" :disabled="busyItems[item.id]" @click.stop="prepare(item)">↓</button>
                <button class="mini-action" title="另存为" :disabled="!item.available" @click.stop="saveItem(item)">⇩</button>
                <button v-if="item.mine" class="mini-action danger" title="删除共享文件" @click.stop="removeItem(item)">×</button>
              </div>
              <div v-if="!item.available" class="file-status">源设备离线</div>
              <div v-else-if="busyItems[item.id]" class="file-status">正在获取 {{ progress[item.id] ? Math.floor(progress[item.id].transferred / Math.max(1, progress[item.id].total) * 100) + '%' : '…' }}</div>
            </div>
          </div>
        </div>
        <div v-else class="empty-state">
          <div class="empty-illustration">▤</div>
          <strong>{{ query ? '没有找到匹配的文件' : '这里还空空的' }}</strong>
          <p>{{ query ? '试试其他关键词' : '拖入文件、图片、文件夹，其他已配对的电脑就能看到' }}</p>
          <button v-if="!query" class="primary-button" @click="selectFiles">＋ 添加第一个文件</button>
        </div>

        <div class="drop-zone" :class="{ 'drag-active': draggingIn }" @dragover.prevent>
          <span class="drop-plus">＋</span>
          <span>{{ draggingIn ? '松开鼠标，即可共享到其他电脑' : '拖入文件或文件夹，立即共享' }}</span>
        </div>
      </main>

      <main v-else-if="tab === 'devices'" class="content device-content">
        <div class="section-title">本机配对码 <span>给其他设备输入后即可互相访问</span></div>
        <div class="pair-card">
          <div class="pair-code">{{ state.pairingCode }}</div>
          <button class="text-button" @click="copyCode">复制</button>
          <div class="pair-hint">有效期至 {{ currentCodeTime }} · 仅与可信设备分享</div>
        </div>
        <div class="section-title">已配对 <span>{{ pairedDevices.length }} 台</span></div>
        <div v-if="!pairedDevices.length" class="small-empty">暂无已配对设备</div>
        <div v-for="device in pairedDevices" :key="device.id" class="device-row">
          <span class="device-icon">▣</span>
          <div class="device-main">
            <strong>{{ device.name }}</strong>
            <small>{{ device.id.slice(0, 8) }}</small>
          </div>
          <span class="device-state" :class="{ online: device.online }">{{ device.online ? '在线' : '离线' }}</span>
        </div>
        <div class="section-title near-title">发现的设备 <span>{{ pendingDevices.length }} 台待配对</span></div>
        <div v-if="!pendingDevices.length" class="small-empty">暂无新设备 · 请确认设备位于同一局域网并已启动 LanShelf</div>
        <div v-for="device in pendingDevices" :key="device.id" class="device-pair">
          <div class="device-row compact-row">
            <span class="device-icon">▣</span>
            <div class="device-main"><strong>{{ device.name }}</strong><small>等待配对</small></div>
          </div>
          <div class="pair-form">
            <input v-model="inputCodes[device.id]" placeholder="输入对方的 6 位配对码" maxlength="6" inputmode="numeric" />
            <button class="primary-button" :disabled="busyItems[device.id]" @click="pair(device)">{{ busyItems[device.id] ? '配对中' : '配对' }}</button>
          </div>
        </div>
      </main>

      <main v-else class="content settings-content">
        <div class="setting-row">
          <div><strong>开机自动启动</strong><small>登录 Windows 后自动打开 LanShelf</small></div>
          <label class="switch"><input type="checkbox" :checked="state.autoStart" @change="changeAutoStart" /><span></span></label>
        </div>
        <div class="setting-row">
          <div><strong>全局快捷键</strong><small>快速展开或收起文件架</small></div>
          <kbd>Ctrl + Shift + Space</kbd>
        </div>
        <div class="setting-row">
          <div><strong>文件存储</strong><small>拖入后创建托管副本；远程文件按需缓存</small></div>
          <span class="setting-value">本地</span>
        </div>
        <div class="setting-row">
          <div><strong>文件夹共享</strong><small>当前版本自动打包为 ZIP 文件</small></div>
          <span class="setting-value">ZIP</span>
        </div>
        <div class="security-note">🔒 首次配对必须输入对方的 6 位配对码。当前测试版适用于可信局域网，数据传输尚未启用 TLS 加密，请勿用于不可信公共网络。</div>
        <div class="app-version">LanShelf v0.1.0 · 本机文件 {{ state.items.filter(item => item.mine).length }} 个 · 共享总量 {{ formatBytes(totalSize) }}</div>
      </main>

      <footer class="footer">
        <span><span class="footer-dot"></span> {{ state.deviceName || '正在初始化…' }}</span>
        <span>{{ tab === 'files' ? '双击打开 · 拖出使用' : '局域网 · 无需中心服务器' }}</span>
      </footer>
    </section>

    <div v-if="textEditor && expanded" class="modal-overlay" @click.self="textEditor = false">
      <div class="text-modal">
        <div class="modal-title">共享一段文本 <button aria-label="关闭" @click="textEditor = false">×</button></div>
        <textarea v-model="textValue" placeholder="粘贴代码、链接、备注或任意文本…" autofocus></textarea>
        <div class="modal-actions"><button class="secondary-button" @click="textEditor = false">取消</button><button class="primary-button" :disabled="working" @click="addText">加入共享架</button></div>
      </div>
    </div>
    <div v-if="notice" class="toast" role="status">{{ notice }}</div>
  </div>
</template>
