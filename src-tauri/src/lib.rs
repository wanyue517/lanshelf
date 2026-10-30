use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    body::Body,
    extract::{Path as AxumPath, State as AxumState},
    http::{header, HeaderMap, Response, StatusCode},
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use rand::Rng;
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, LogicalPosition, LogicalSize, Manager, Position, Size,
};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

const SERVICE_TYPE: &str = "_lanshelf._tcp.local.";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    id: String,
    owner_id: String,
    name: String,
    kind: String,
    size: u64,
    created_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalItem {
    #[serde(flatten)]
    item: Item,
    file_path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrustedPeer {
    id: String,
    name: String,
    inbound_token: String,
    outbound_token: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Persisted {
    device_id: String,
    name: String,
    items: Vec<LocalItem>,
    trusted: Vec<TrustedPeer>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShelfItem {
    #[serde(flatten)]
    item: Item,
    owner_name: String,
    available: bool,
    cached: bool,
    mine: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceInfo {
    id: String,
    name: String,
    online: bool,
    paired: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShelfState {
    device_id: String,
    device_name: String,
    pairing_code: String,
    pairing_expires_at: u64,
    items: Vec<ShelfItem>,
    devices: Vec<DeviceInfo>,
    auto_start: bool,
}

#[derive(Clone)]
struct Found {
    id: String,
    name: String,
    host: String,
    port: u16,
    fullname: String,
    online: bool,
}

struct PairCode {
    code: String,
    expires_at: u64,
}
struct Core {
    data_dir: PathBuf,
    state: Mutex<Persisted>,
    found: Mutex<HashMap<String, Found>>,
    remote: Mutex<HashMap<String, Vec<Item>>>,
    code: Mutex<PairCode>,
    attempts: Mutex<HashMap<String, (u32, u64)>>,
    client: reqwest::Client,
    app: tauri::AppHandle,
}

type Shared = Arc<Core>;

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn code() -> String {
    format!("{:06}", rand::rng().random_range(0..1_000_000u32))
}

fn safe_name(name: &str) -> String {
    let value: String = name
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c })
        .skip_while(|c| *c == '.')
        .take(150)
        .collect::<String>()
        .trim_end_matches(['.', ' '])
        .to_string();
    if value.is_empty() {
        return "unnamed".into();
    }
    let first = value.split('.').next().unwrap_or("").to_uppercase();
    if ["CON", "PRN", "AUX", "NUL"].contains(&first.as_str())
        || (first.len() == 4 && (first.starts_with("COM") || first.starts_with("LPT"))
            && first.chars().last().unwrap_or('0').is_ascii_digit())
    {
        return format!("_{value}");
    }
    value
}

impl Core {
    fn new(app: tauri::AppHandle) -> Result<Shared, String> {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(data_dir.join("files")).map_err(|e| e.to_string())?;
        fs::create_dir_all(data_dir.join("cache")).map_err(|e| e.to_string())?;
        let name = hostname::get()
            .unwrap_or_default()
            .to_string_lossy()
            .chars()
            .take(60)
            .collect::<String>();
        let default = Persisted {
            device_id: Uuid::new_v4().to_string(),
            name: if name.is_empty() { "Windows PC".into() } else { name },
            items: Vec::new(),
            trusted: Vec::new(),
        };
        let data = fs::read(data_dir.join("state.json"))
            .ok()
            .and_then(|raw| serde_json::from_slice::<Persisted>(&raw).ok())
            .unwrap_or(default);
        let core = Arc::new(Self {
            data_dir,
            state: Mutex::new(data),
            found: Mutex::new(HashMap::new()),
            remote: Mutex::new(HashMap::new()),
            code: Mutex::new(PairCode { code: code(), expires_at: now() + 300_000 }),
            attempts: Mutex::new(HashMap::new()),
            client: reqwest::Client::builder().timeout(Duration::from_secs(3600))
                .build().map_err(|e| e.to_string())?,
            app,
        });
        core.persist()?;
        Ok(core)
    }

    fn persist(&self) -> Result<(), String> {
        let text = serde_json::to_vec_pretty(&*self.state.lock().unwrap()).map_err(|e| e.to_string())?;
        let target = self.data_dir.join("state.json");
        let temp = self.data_dir.join("state.tmp");
        fs::write(&temp, text).map_err(|e| e.to_string())?;
        fs::rename(&temp, target).map_err(|e| e.to_string())
    }

    fn notify(&self) {
        let _ = self.app.emit("shelf:state-changed", self.snapshot());
    }

    fn current_code(&self) -> (String, u64) {
        let mut guard = self.code.lock().unwrap();
        if now() >= guard.expires_at {
            guard.code = code();
            guard.expires_at = now() + 300_000;
        }
        (guard.code.clone(), guard.expires_at)
    }

    fn cached_path(&self, item: &Item) -> PathBuf {
        self.data_dir.join("cache").join(format!(
            "{}-{}-{}", item.owner_id, item.id, safe_name(&item.name)
        ))
    }

    fn snapshot(&self) -> ShelfState {
        let persistent = self.state.lock().unwrap().clone();
        let found = self.found.lock().unwrap().clone();
        let remote = self.remote.lock().unwrap().clone();
        let (pairing_code, pairing_expires_at) = self.current_code();

        let mut items: Vec<ShelfItem> = persistent.items.iter().map(|local| {
            let exists = Path::new(&local.file_path).exists();
            ShelfItem {
                item: local.item.clone(),
                owner_name: persistent.name.clone(),
                available: exists,
                cached: exists,
                mine: true,
            }
        }).collect();

        for remote_items in remote.values() {
            for item in remote_items {
                let cached = self.cached_path(item).exists();
                let online = found.get(&item.owner_id).map(|p| p.online).unwrap_or(false);
                items.push(ShelfItem {
                    item: item.clone(),
                    owner_name: persistent.trusted.iter()
                        .find(|p| p.id == item.owner_id).map(|p| p.name.clone())
                        .unwrap_or_else(|| "其他设备".into()),
                    available: cached || online,
                    cached,
                    mine: false,
                });
            }
        }
        items.sort_by(|a, b| b.item.created_at.cmp(&a.item.created_at));

        let mut devices: Vec<DeviceInfo> = found.values().map(|p| DeviceInfo {
            id: p.id.clone(),
            name: p.name.clone(),
            online: p.online,
            paired: persistent.trusted.iter().any(|x| x.id == p.id),
        }).collect();
        for peer in &persistent.trusted {
            if !found.contains_key(&peer.id) {
                devices.push(DeviceInfo {
                    id: peer.id.clone(),
                    name: peer.name.clone(),
                    online: false,
                    paired: true,
                });
            }
        }
        devices.sort_by(|a, b| b.online.cmp(&a.online).then(a.name.cmp(&b.name)));

        ShelfState {
            device_id: persistent.device_id,
            device_name: persistent.name,
            pairing_code,
            pairing_expires_at,
            items,
            devices,
            auto_start: false, // frontend reads actual OS autostart plugin state
        }
    }

    fn authenticate(&self, headers: &HeaderMap) -> bool {
        let raw = match headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
            Some(value) => value.strip_prefix("Bearer ").unwrap_or(""),
            None => "",
        };
        // Token content is 32 random bytes encoded as hex; only accept exact known values.
        raw.len() == 64 && self.state.lock().unwrap().trusted.iter().any(|p| p.inbound_token == raw)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest {
    id: String,
    name: String,
    code: String,
    inbound_token: String,
}

#[derive(Serialize, Deserialize)]
struct PairResponse {
    id: String,
    token: String,
}

fn fresh_token() -> String {
    Uuid::new_v4().simple().to_string() + &Uuid::new_v4().simple().to_string()
}

async fn pair_handler(
    AxumState(core): AxumState<Shared>,
    request: axum::extract::ConnectInfo<std::net::SocketAddr>,
    Json(input): Json<PairRequest>,
) -> Result<Json<PairResponse>, StatusCode> {
    let ip = request.0.ip().to_string();
    {
        let attempts = core.attempts.lock().unwrap();
        if let Some((count, expiry)) = attempts.get(&ip) {
            if *count >= 5 && *expiry > now() {
                return Err(StatusCode::TOO_MANY_REQUESTS);
            }
        }
    }
    let (current, _) = core.current_code();
    if input.code != current || input.id.len() < 8 || input.id.len() > 80
        || !input.id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
        || input.inbound_token.len() != 64
        || !input.inbound_token.chars().all(|ch| ch.is_ascii_hexdigit())
    {
        let mut attempts = core.attempts.lock().unwrap();
        let value = attempts.entry(ip).or_insert((0, now() + 300_000));
        if now() > value.1 {
            *value = (0, now() + 300_000);
        }
        value.0 += 1;
        return Err(StatusCode::FORBIDDEN);
    }
    core.attempts.lock().unwrap().remove(&ip);
    let token = fresh_token();
    let id = core.state.lock().unwrap().device_id.clone();
    {
        let mut guard = core.state.lock().unwrap();
        guard.trusted.retain(|p| p.id != input.id);
        guard.trusted.push(TrustedPeer {
            id: input.id,
            name: input.name.chars().take(60).collect(),
            inbound_token: token.clone(),
            outbound_token: input.inbound_token,
        });
    }
    core.persist().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    core.notify();
    Ok(Json(PairResponse { id, token }))
}

async fn items_handler(
    AxumState(core): AxumState<Shared>,
    headers: HeaderMap,
) -> Result<Json<Vec<Item>>, StatusCode> {
    if !core.authenticate(&headers) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(Json(core.state.lock().unwrap().items.iter().map(|i| i.item.clone()).collect()))
}

async fn file_handler(
    AxumState(core): AxumState<Shared>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<Response<Body>, StatusCode> {
    if !core.authenticate(&headers) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let local = core.state.lock().unwrap().items.iter().find(|i| i.item.id == id).cloned()
        .ok_or(StatusCode::NOT_FOUND)?;
    let file = tokio::fs::File::open(&local.file_path).await.map_err(|_| StatusCode::NOT_FOUND)?;
    let size = file.metadata().await.map_err(|_| StatusCode::NOT_FOUND)?.len();
    let stream = tokio_util::io::ReaderStream::new(file);
    Response::builder().status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, size.to_string())
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from_stream(stream)).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn launch_network(core: Shared) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind("0.0.0.0:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let router = Router::new()
        .route("/pair", post(pair_handler))
        .route("/items", get(items_handler))
        .route("/file/{id}", get(file_handler))
        .with_state(core.clone());
    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, router.into_make_service_with_connect_info::<std::net::SocketAddr>()).await {
            eprintln!("LAN server failed: {error}");
        }
    });

    let mdns = ServiceDaemon::new().map_err(|e| e.to_string())?;
    let (id, name) = {
        let data = core.state.lock().unwrap();
        (data.device_id.clone(), data.name.clone())
    };
    let ip = local_ip_address::local_ip().map_err(|e| e.to_string())?.to_string();
    let hostname = format!("lanshelf-{}.local.", &id[..8]);
    let props = [("id", id.as_str()), ("label", name.as_str())];
    let service = ServiceInfo::new(
        SERVICE_TYPE, &format!("LanShelf-{}", &id[..8]), &hostname,
        ip.as_str(), port, &props[..],
    ).map_err(|e| e.to_string())?;
    mdns.register(service).map_err(|e| e.to_string())?;
    let receiver = mdns.browse(SERVICE_TYPE).map_err(|e| e.to_string())?;

    let discovery_core = core.clone();
    tauri::async_runtime::spawn(async move {
        let _daemon = mdns; // keep daemon alive while browsing
        while let Ok(event) = receiver.recv_async().await {
            match event {
                ServiceEvent::ServiceResolved(service) => {
                    let Some(peer_id) = service.get_property_val_str("id") else { continue };
                    if peer_id == id { continue }
                    let Some(address) = service.get_addresses().iter().find(|ip| ip.is_ipv4()) else { continue };
                    let peer = Found {
                        id: peer_id.to_string(),
                        name: service.get_property_val_str("label").unwrap_or("其他设备").to_string(),
                        host: address.to_string(),
                        port: service.get_port(),
                        fullname: service.get_fullname().to_string(),
                        online: false,
                    };
                    discovery_core.found.lock().unwrap().insert(peer.id.clone(), peer);
                    discovery_core.notify();
                }
                ServiceEvent::ServiceRemoved(_, fullname) => {
                    discovery_core.found.lock().unwrap().retain(|_, p| p.fullname != fullname);
                    discovery_core.notify();
                }
                _ => {}
            }
        }
    });

    tauri::async_runtime::spawn(async move {
        loop {
            sync_peers(core.clone()).await;
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
    Ok(())
}

async fn sync_peers(core: Shared) {
    let peers = core.state.lock().unwrap().trusted.clone();
    for peer in peers {
        let endpoint = core.found.lock().unwrap().get(&peer.id).cloned();
        if let Some(found) = endpoint {
            let url = format!("http://{}:{}/items", found.host, found.port);
            let response = core.client.get(url)
                .bearer_auth(&peer.outbound_token)
                .timeout(Duration::from_secs(5))
                .send().await;
            let mut online = false;
            if let Ok(response) = response {
                if let Ok(response) = response.error_for_status() {
                    if let Ok(items) = response.json::<Vec<Item>>().await {
                        if items.len() <= 10_000 && items.iter().all(|i| i.owner_id == peer.id) {
                            core.remote.lock().unwrap().insert(peer.id.clone(), items);
                            online = true;
                        }
                    }
                }
            }
            if let Some(found) = core.found.lock().unwrap().get_mut(&peer.id) {
                found.online = online;
            }
        }
    }
    core.notify();
}

#[tauri::command]
fn get_state(core: tauri::State<'_, Shared>) -> ShelfState {
    core.snapshot()
}

#[tauri::command]
fn expand(app: tauri::AppHandle, expanded: bool) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("窗口不存在")?;
    let (width, height) = if expanded { (472.0, 580.0) } else { (196.0, 52.0) };
    window.set_size(Size::Logical(LogicalSize::new(width, height))).map_err(|e| e.to_string())?;
    if let Some(monitor) = window.current_monitor().map_err(|e| e.to_string())? {
        let scale = monitor.scale_factor();
        let x = (monitor.position().x as f64 / scale) + (monitor.size().width as f64 / scale - width) / 2.0;
        let y = monitor.position().y as f64 / scale + 8.0;
        window.set_position(Position::Logical(LogicalPosition::new(x, y))).map_err(|e| e.to_string())?;
    }
    window.show().map_err(|e| e.to_string())?;
    let _ = app.emit("shelf:expanded", expanded);
    if expanded {
        let _ = window.set_focus();
    }
    Ok(())
}

fn create_zip(source: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for entry in walkdir::WalkDir::new(source) {
        let entry = entry.map_err(|e| e.to_string())?;
        let relative = entry.path().strip_prefix(source).map_err(|e| e.to_string())?;
        let zip_path = relative.to_string_lossy().replace('\\', "/");
        if zip_path.is_empty() { continue }
        if entry.file_type().is_dir() {
            archive.add_directory(format!("{zip_path}/"), options).map_err(|e| e.to_string())?;
        } else {
            archive.start_file(&zip_path, options).map_err(|e| e.to_string())?;
            let mut input = fs::File::open(entry.path()).map_err(|e| e.to_string())?;
            std::io::copy(&mut input, &mut archive).map_err(|e| e.to_string())?;
        }
    }
    archive.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn add_paths(core: tauri::State<'_, Shared>, paths: Vec<String>) -> Result<(), String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        for raw in paths {
            let source = PathBuf::from(&raw);
            let metadata = fs::metadata(&source).map_err(|e| e.to_string())?;
            if !metadata.is_dir() && !metadata.is_file() { continue }
            let id = Uuid::new_v4().to_string();
            let folder = core.data_dir.join("files").join(&id);
            fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
            let mut name = safe_name(&source.file_name().unwrap_or_default().to_string_lossy());
            let is_dir = metadata.is_dir();
            if is_dir { name.push_str(".zip"); }
            let dest = folder.join(&name);
            let result = if is_dir {
                create_zip(&source, &dest)
            } else {
                fs::copy(&source, &dest).map(|_| ()).map_err(|e| e.to_string())
            };
            if let Err(error) = result {
                let _ = fs::remove_dir_all(folder);
                return Err(error);
            }
            let size = fs::metadata(&dest).map_err(|e| e.to_string())?.len();
            let owner_id = core.state.lock().unwrap().device_id.clone();
            core.state.lock().unwrap().items.insert(0, LocalItem {
                item: Item {
                    id, owner_id, name, size, created_at: now(),
                    kind: if is_dir { "folder".into() } else { "file".into() },
                },
                file_path: dest.to_string_lossy().to_string(),
            });
            core.persist()?;
            core.notify();
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn add_text(core: tauri::State<'_, Shared>, text: String) -> Result<(), String> {
    if text.trim().is_empty() { return Err("文本不能为空".into()) }
    if text.len() > 10_000_000 { return Err("文本不能超过 10 MB".into()) }
    let id = Uuid::new_v4().to_string();
    let folder = core.data_dir.join("files").join(&id);
    tokio::fs::create_dir_all(&folder).await.map_err(|e| e.to_string())?;
    let name = format!("文本-{id}.txt");
    let file_path = folder.join(&name);
    tokio::fs::write(&file_path, &text).await.map_err(|e| e.to_string())?;
    let owner_id = core.state.lock().unwrap().device_id.clone();
    core.state.lock().unwrap().items.insert(0, LocalItem {
        item: Item {
            id, owner_id, name, kind: "text".into(), size: text.len() as u64,
            created_at: now(),
        },
        file_path: file_path.to_string_lossy().to_string(),
    });
    core.persist()?;
    core.notify();
    Ok(())
}

#[tauri::command]
async fn pair_device(core: tauri::State<'_, Shared>, device_id: String, code: String) -> Result<(), String> {
    if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) {
        return Err("请输入对方的 6 位配对码".into());
    }
    let found = core.found.lock().unwrap().get(&device_id).cloned()
        .ok_or("未找到设备，请检查局域网连接")?;
    let token = fresh_token();
    let state = core.state.lock().unwrap().clone();
    let url = format!("http://{}:{}/pair", found.host, found.port);
    let response = core.client.post(url)
        .timeout(Duration::from_secs(8))
        .json(&serde_json::json!({
            "id": state.device_id,
            "name": state.name,
            "code": code,
            "inboundToken": token
        }))
        .send().await.map_err(|e| format!("无法连接设备: {e}"))?
        .error_for_status().map_err(|_| "配对失败，请确认对方的配对码".to_string())?
        .json::<PairResponse>().await.map_err(|e| e.to_string())?;
    if response.id != device_id || response.token.len() != 64 {
        return Err("设备身份校验失败".into());
    }
    {
        let mut guard = core.state.lock().unwrap();
        guard.trusted.retain(|p| p.id != device_id);
        guard.trusted.push(TrustedPeer {
            id: device_id.clone(), name: found.name,
            inbound_token: token, outbound_token: response.token,
        });
    }
    core.persist()?;
    core.notify();
    Ok(())
}

async fn prepare(core: &Shared, id: &str) -> Result<PathBuf, String> {
    if let Some(item) = core.state.lock().unwrap().items.iter()
        .find(|i| i.item.id == id).cloned()
    {
        let path = PathBuf::from(item.file_path);
        if path.exists() { return Ok(path) }
        return Err("本地托管文件已丢失".into());
    }
    let item = core.remote.lock().unwrap().values().flat_map(|items| items.iter())
        .find(|i| i.id == id).cloned().ok_or("共享文件不存在")?;
    let target = core.cached_path(&item);
    if target.exists() { return Ok(target) }
    let peer = core.state.lock().unwrap().trusted.iter()
        .find(|p| p.id == item.owner_id).cloned().ok_or("设备未配对")?;
    let found = core.found.lock().unwrap().get(&item.owner_id)
        .cloned().filter(|f| f.online).ok_or("源设备当前离线")?;
    let response = core.client.get(format!("http://{}:{}/file/{}", found.host, found.port, item.id))
        .bearer_auth(peer.outbound_token)
        .send().await.map_err(|e| e.to_string())?
        .error_for_status().map_err(|e| e.to_string())?;
    let temporary = target.with_extension(format!("{}.part", Uuid::new_v4()));
    let mut file = tokio::fs::File::create(&temporary).await.map_err(|e| e.to_string())?;
    let mut bytes = 0u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        bytes += chunk.len() as u64;
        let _ = core.app.emit("shelf:progress", serde_json::json!({
            "itemId": item.id,
            "transferred": bytes,
            "total": item.size
        }));
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);
    if bytes != item.size {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err("文件大小校验失败".into());
    }
    tokio::fs::rename(&temporary, &target).await.map_err(|e| e.to_string())?;
    core.notify();
    Ok(target)
}

#[tauri::command]
async fn prepare_item(core: tauri::State<'_, Shared>, id: String) -> Result<(), String> {
    prepare(core.inner(), &id).await.map(|_| ())
}

#[tauri::command]
async fn open_item(core: tauri::State<'_, Shared>, id: String) -> Result<(), String> {
    let path = prepare(core.inner(), &id).await?;
    opener::open(path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_item(core: tauri::State<'_, Shared>, id: String, destination: String) -> Result<(), String> {
    let source = prepare(core.inner(), &id).await?;
    tokio::fs::copy(&source, destination).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn remove_item(core: tauri::State<'_, Shared>, id: String) -> Result<(), String> {
    let previous = {
        let mut state = core.state.lock().unwrap();
        let index = state.items.iter().position(|p| p.item.id == id)
            .ok_or("只能删除自己添加的文件")?;
        state.items.remove(index)
    };
    core.persist()?;
    core.notify();
    tokio::fs::remove_dir_all(Path::new(&previous.file_path).parent().ok_or("路径错误")?)
        .await.map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new().with_handler(|app, _, event| {
                if event.state() == ShortcutState::Pressed {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = expand(app.clone(), true);
                        let _ = window.set_focus();
                    }
                }
            }).build()
        )
        .invoke_handler(tauri::generate_handler![
            get_state, expand, add_paths, add_text, pair_device,
            prepare_item, open_item, save_item, remove_item
        ])
        .setup(|app| {
            let core = Core::new(app.handle().clone()).map_err(std::io::Error::other)?;
            app.manage(core.clone());
            let open = MenuItem::with_id(app, "open", "展开文件架", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 LanShelf", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().ok_or_else(|| std::io::Error::other("缺少应用图标"))?.clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => { let _ = expand(app.clone(), true); }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            let shortcut = Shortcut::new(
                Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space
            );
            app.global_shortcut().register(shortcut)?;
            let _ = expand(app.handle().clone(), false);
            tauri::async_runtime::spawn(async move {
                if let Err(err) = launch_network(core.clone()).await {
                    eprintln!("Failed to start LAN networking: {err}");
                    let _ = core.app.emit("shelf:notice", format!("局域网服务启动失败: {err}"));
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run LanShelf");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn safe_windows_file_names() {
        assert_eq!(safe_name("a:b?.txt"), "a_b_.txt");
        assert_eq!(safe_name("CON.txt"), "_CON.txt");
        assert_eq!(safe_name("../"), "unnamed");
    }
    #[test]
    fn pairing_code_has_six_digits() {
        let c = code();
        assert_eq!(c.len(), 6);
        assert!(c.chars().all(|v| v.is_ascii_digit()));
    }
}
