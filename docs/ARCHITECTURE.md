# LanShelf 技术架构（Tauri 2）

## 技术选型

- 桌面端：Tauri 2，不使用 Electron。
- UI：Vue 3 + TypeScript + Vite，保留原本的悬浮文件架交互。
- 本地服务：Rust + Tokio + Axum，监听随机 TCP 端口。
- LAN 设备自动发现：`mdns-sd`，DNS-SD 服务名 `_lanshelf._tcp.local.`。
- 客户端文件请求：`reqwest`，HTTP 流式传输（Tokio 文件流）。
- 元数据：首版 JSON 持久化；后续迁移 SQLite。
- 文件目录：Tauri appDataDir 下 `files/` 与 `cache/`。
- 桌面功能：Tauri 2 原生托盘、窗口、事件机制及官方 dialog/autostart/global-shortcut/clipboard 插件。

## 数据流

1. 本机添加文件：Tauri 2 前端通过 `onDragDropEvent` 获取 OS 拖入路径，调用 Rust `add_paths`。
2. Rust 复制文件到托管区；文件夹按 ZIP 打包；更新 JSON 文件索引。
3. mDNS 查找局域网其他 LanShelf 实例；UI 显示未配对及已配对设备。
4. 通过对方 6 位验证码建立双向访问令牌。
5. 已授权设备每 3 秒向 `GET /items` 读取文件索引，完成跨端文件池。
6. 下载远端文件：`GET /file/{id}`，流式写入 `cache/`，完成大小检查后重命名。
7. 双击用系统默认程序打开，或者通过原生对话框选择路径「另存为」。

不向前端泄露本机托管路径及网络访问令牌。

## 安全提示

当前配对是开发版设计，访问令牌在 HTTP 传输，不能抵御局域网中具备嗅探能力的攻击者。生产部署前必须引入传输加密及设备身份公钥绑定、限制网络接口、完善身份撤销及访问审计。

首版未引入跨公网协调服务，避免超出核心场景。

## 原生文件拖出

Tauri 2 的 `onDragDropEvent` 负责 **拖入**，不等价于从 WebView 向其他 Windows 程序进行真实文件拖放。计划用 Rust 接入 Windows OLE `IDataObject`、`DoDragDrop`，先支持已缓存的本地文件，后续支持虚拟文件流。

为了不制造错误操作预期，当前 UI 禁止文件卡片启动原生拖出，提供「另存为」作为可用替代。

## 下一阶段

- 测试 Windows 10/11 实机启动、定位、多显示器及托盘。
- 安全加固：TLS/公钥信任、访问令牌轮换、失败限速、缓存限额。
- 从文件架直接拖出到桌面/微信/VS Code，原生拖出动作独立验证。
- 下载中断续传、超时、重试、缓存/托管区清理。
- 事件推送取代定时轮询并支持文件哈希一致性验证。
