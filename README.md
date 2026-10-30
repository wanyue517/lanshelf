# LanShelf

一个轻量的 **Windows 局域网公共文件架**。每台电脑顶部有一个小悬浮入口，文件拖进去后，其他已配对设备可以看到、下载并打开。

**技术栈：Tauri 2 + Vue 3 + TypeScript + Rust + Tokio + Axum + mDNS。** 不使用 Electron。

> **v0.1.0 开发预览版**：已落地悬浮 UI、局域网服务、设备发现、配对、文件托管和按需下载的首轮代码。尚未完成实际多机与 Windows 原生拖出测试；当前仅建议在可信局域网测试。

## 运行

需要 Windows 10/11、Node.js 22+、Rust >= 1.90，以及 [Tauri 2 Windows 开发环境](https://v2.tauri.app/start/prerequisites/)（Microsoft C++ Build Tools、WebView2 等）。

```bash
git clone https://github.com/wanyue517/lanshelf.git
cd lanshelf
npm install
npm run dev
```

类型检查及发行构建：

```bash
npm run typecheck
npm run build
npm run dist:win
```

Windows 安装包由 Tauri 2 的 NSIS 打包器生成。

## 当前功能

- **置顶悬浮入口**：默认小入口，点击展开文件架；托盘运行与全局快捷键 Ctrl + Shift + Space。
- **文件共享**：从资源管理器直接拖入文件/文件夹，Rust 在本机数据目录创建托管副本，文件夹转为 ZIP。
- **共享文本**：将代码片段、链接、备注存为文本文件。
- **设备发现**：mDNS/DNS-SD 自动搜索同网段的 LanShelf。
- **首次配对**：输入对方设备上显示的 6 位配对码；配对后保存访问凭据。
- **远程文件池**：Rust 后台周期性刷新配对设备的文件索引；源设备在线时可按需下载到本机缓存。
- **文件处理**：双击打开、另存为、仅删除自己添加的文件、搜索、筛选、网格/列表。
- **设置**：通过 Tauri 官方插件管理 Windows 开机自启。

## 两台电脑如何配对

1. A、B 同时运行 LanShelf，在同一允许设备互访的局域网。
2. 在 B 的「设备」中找到 A，输入 A 的 6 位配对码。
3. 配对后，两端自动看到对方公开在文件架的文件。
4. A 拖入文件，B 看到后可以点击下载、双击打开或另存为。

### 已知限制（重要）

- **Windows 原生文件拖出尚未实现**：Tauri 2 支持将本机文件拖入窗口，但不能简单用 HTML5 DragEvent 把真实文件直接拖到资源管理器、微信或 IDE。目前用「另存为」代替，原生拖出需要额外实现 Windows OLE Drag & Drop。
- **通信暂未加密**：HTTP、mDNS 及访问令牌在局域网内传输。六位配对码仅作初步准入控制，**不要在公共网络或共享敏感文件时使用此预览版**。
- 文件复制到托管目录会占用额外本地空间；尚未提供磁盘配额与缓存自动清理。
- 文件夹被转换为 ZIP，不是可远程浏览的目录。
- 未提供续传、自动更新、跨网段或互联网中转、完整的设备撤销配对能力。
- mDNS 发现受 Windows 防火墙、客户端隔离及 VLAN 影响。
- GitHub CI 与 Windows 多机测试结果以仓库最新构建情况为准。

## 工程结构

```
src/
  App.vue            Vue 3 顶部文件架与设备界面
  bridge.ts          Tauri invoke/event、文件拖入及官方插件
  style.css          桌面悬浮 UI 样式
src-tauri/
  src/lib.rs         Rust 文件管理、HTTP 服务、mDNS、配对、Tauri commands
  src/main.rs        Rust 入口
  tauri.conf.json    透明窗口和安装包配置
  capabilities/      Tauri 2 权限白名单
shared/types.ts      IPC 契约
docs/PRODUCT.md      UI 与交互规划
docs/ARCHITECTURE.md Rust 架构、安全及后续技术路线
```

后续优先处理：Windows 原生拖出、TLS/可信设备身份、缓存限制、断点续传、自动更新及大文件性能。
