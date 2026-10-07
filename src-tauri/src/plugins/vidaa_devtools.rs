//! Chrome DevTools for a FreeTV build running on a VIDAA TV — Console, Network, Elements — without
//! the TV's own DevTools port, which VIDAA keeps closed on our sets (AGENTS.md → VIDAA plan).
//!
//! Two pieces, served from one listener on this computer:
//!
//! - **A reverse proxy for the app.** The TV is given the proxy's URL instead of FreeTV's. Every
//!   request is forwarded to the real host, so page, JS and `/api` share one origin — the proxy —
//!   as they share `uat-web.freetv.tv` in production. Only the app's index.html changes: its own
//!   origin becomes the proxy's, and Chii's `target.js` is injected first in `<head>`.
//! - **A Chii server** (MIT, github.com/liriliri/chii), reimplemented here: `target.js` implements
//!   the DevTools protocol inside the page (chobitsu) and connects to `/__chii/target/<id>`; the
//!   DevTools frontend, bundled from the `chii` npm package as an app resource, connects to
//!   `/__chii/client/<id>?target=<id>`; this relays messages between them.
//!
//! One listener per upstream origin, on a fixed port, because the proxied URL is baked into the
//! TV's app entry at install time and must keep working after the QA tool restarts.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::{SocketAddr, UdpSocket};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{HeaderName, HeaderValue, CACHE_CONTROL, CONTENT_TYPE, HOST, ORIGIN, REFERER};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_http::reqwest;
use tokio::net::TcpListener;
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Role;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use crate::error::Error;

/// Where the Chii server and its files live on every proxy port.
const CHII: &str = "/__chii/";

/// Answers the TV-side launcher: "the QA tool is here, go through the proxy".
const PING: &str = "/__qa/ping";

/// Fixed ports for the FreeTV hosts, so an installed app's URL survives a restart of the tool.
/// Mirrored by `DEVTOOLS_PORTS` in `src/app/vidaa/vidaa-presets.ts`.
const KNOWN_PORTS: &[(&str, u16)] = &[("https://uat-web.freetv.tv", 8765), ("https://web.freetv.tv", 8766)];

fn port_for(origin: &str) -> u16 {
    if let Some((_, port)) = KNOWN_PORTS.iter().find(|(o, _)| *o == origin) {
        return *port;
    }
    // Any other host: a stable port in 8770..8799 derived from the origin.
    8770 + (origin.bytes().fold(0u32, |h, b| h.wrapping_mul(31).wrapping_add(b as u32)) % 30) as u16
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevtoolsProxy {
    origin: String,
    port: u16,
    lan_ip: String,
}

/// A page that has loaded `target.js` and is waiting for DevTools.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevtoolsTarget {
    id: String,
    url: String,
    title: String,
    ip: String,
    user_agent: String,
    /// The proxy port it came through — DevTools must connect to the same one.
    port: u16,
    /// Milliseconds since the epoch, so the UI can pick the newest page for a TV.
    connected_at: u64,
}

struct TargetSlot {
    info: DevtoolsTarget,
    to_target: mpsc::UnboundedSender<Message>,
    clients: Vec<mpsc::UnboundedSender<Message>>,
}

type Targets = Arc<StdMutex<HashMap<String, TargetSlot>>>;

struct Proxy {
    port: u16,
    task: JoinHandle<()>,
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Default)]
pub struct VidaaDevtoolsState {
    proxies: Mutex<HashMap<String, Proxy>>,
    targets: Targets,
}

struct Ctx {
    origin: String,
    port: u16,
    chii_dir: PathBuf,
    client: reqwest::Client,
    targets: Targets,
}

type Body = Full<Bytes>;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The address this computer uses to reach `peer` — the one the TV must be given.
fn lan_ip_towards(peer: &str) -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    // UDP connect sends nothing; it only selects the route and with it the local address.
    socket.connect((peer, 9)).ok()?;
    Some(socket.local_addr().ok()?.ip().to_string())
}

/// Points the page at the proxy and loads Chii first. Only the app's own origin is rewritten:
/// its API host may be another one (PreProd talks to web.freetv.tv), which already answers CORS
/// for any origin.
fn rewrite_index(html: &str, upstream: &str, own: &str) -> String {
    let html = html.replace(upstream, own);
    let tag = format!(r#"<script src="{own}{CHII}target.js"></script>"#);
    match html.find("<head").and_then(|start| html[start..].find('>').map(|end| start + end + 1)) {
        Some(at) => format!("{}{}{}", &html[..at], tag, &html[at..]),
        None => format!("{tag}{html}"),
    }
}

/// Upstream cookies are scoped to freetv.tv over https; make them valid for this plain-http origin.
fn rewrite_cookie(cookie: &str) -> String {
    cookie
        .split(';')
        .map(str::trim)
        .filter(|part| {
            let lower = part.to_ascii_lowercase();
            !(lower.starts_with("domain=") || lower == "secure" || lower == "samesite=none")
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn is_app_page(path: &str) -> bool {
    path.starts_with("/apps/") && path.ends_with("index.html")
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or_default() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "avif" => "image/avif",
        "gif" => "image/gif",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// Resolves `rel` under the bundled Chii files, refusing anything that climbs out of them.
fn chii_file(dir: &Path, rel: &str) -> Option<PathBuf> {
    let rel = Path::new(rel.trim_start_matches('/'));
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    Some(dir.join(rel))
}

fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| percent_decode(v))
    })
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                match u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz"), 16) {
                    Ok(b) => {
                        out.push(b);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn plain(status: StatusCode, text: impl Into<Bytes>) -> Response<Body> {
    let mut r = Response::new(Full::new(text.into()));
    *r.status_mut() = status;
    r
}

async fn handle(req: Request<Incoming>, ctx: Arc<Ctx>) -> Result<Response<Body>, Infallible> {
    let path = req.uri().path().to_owned();
    if path == PING {
        // The launcher installed on the TV asks this before choosing proxied or direct; it runs
        // from a data: URL, so the answer has to be readable cross-origin.
        let mut r = plain(StatusCode::NO_CONTENT, Bytes::new());
        r.headers_mut().insert("access-control-allow-origin", HeaderValue::from_static("*"));
        r.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        return Ok(r);
    }
    let result = if let Some(rest) = path.strip_prefix(CHII) {
        chii(req, rest.to_owned(), &ctx).await
    } else {
        proxy(req, &ctx).await
    };
    Ok(result.unwrap_or_else(|e| {
        log::warn!("[vidaa-devtools] {path}: {e}");
        plain(StatusCode::BAD_GATEWAY, e)
    }))
}

/// `/__chii/…`: the WebSocket relay, the target list and the bundled frontend files.
async fn chii(mut req: Request<Incoming>, rest: String, ctx: &Ctx) -> Result<Response<Body>, String> {
    let is_upgrade = req
        .headers()
        .get(hyper::header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    if is_upgrade {
        let (kind, id) = rest.split_once('/').ok_or("bad websocket path")?;
        if kind != "target" && kind != "client" {
            return Ok(plain(StatusCode::NOT_FOUND, "unknown socket"));
        }
        let key = req
            .headers()
            .get("sec-websocket-key")
            .ok_or("missing sec-websocket-key")?
            .as_bytes()
            .to_vec();
        let query = req.uri().query().unwrap_or_default().to_owned();
        let ip = req
            .extensions()
            .get::<SocketAddr>()
            .map(|a| a.ip().to_string())
            .unwrap_or_default();
        let user_agent = req
            .headers()
            .get(hyper::header::USER_AGENT)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let upgrade = hyper::upgrade::on(&mut req);
        let (kind, id) = (kind.to_owned(), id.to_owned());
        let targets = ctx.targets.clone();
        let port = ctx.port;
        tokio::spawn(async move {
            match upgrade.await {
                Ok(upgraded) => {
                    let ws = WebSocketStream::from_raw_socket(TokioIo::new(upgraded), Role::Server, None).await;
                    if kind == "target" {
                        let info = DevtoolsTarget {
                            id: id.clone(),
                            url: query_param(&query, "url").unwrap_or_default(),
                            title: query_param(&query, "title").unwrap_or_default(),
                            ip,
                            user_agent,
                            port,
                            connected_at: now_ms(),
                        };
                        run_target(ws, info, targets).await;
                    } else if let Some(target) = query_param(&query, "target") {
                        run_client(ws, target, targets).await;
                    }
                }
                Err(e) => log::warn!("[vidaa-devtools] websocket upgrade failed: {e}"),
            }
        });
        let mut r = plain(StatusCode::SWITCHING_PROTOCOLS, Bytes::new());
        let h = r.headers_mut();
        h.insert(hyper::header::UPGRADE, HeaderValue::from_static("websocket"));
        h.insert(hyper::header::CONNECTION, HeaderValue::from_static("Upgrade"));
        h.insert(
            "sec-websocket-accept",
            HeaderValue::from_str(&derive_accept_key(&key)).map_err(|e| e.to_string())?,
        );
        return Ok(r);
    }

    if rest == "targets" {
        let list: Vec<DevtoolsTarget> = ctx.targets.lock().unwrap().values().map(|t| t.info.clone()).collect();
        let mut r = plain(StatusCode::OK, serde_json::to_vec(&serde_json::json!({ "targets": list })).unwrap_or_default());
        r.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        return Ok(r);
    }

    let file = chii_file(&ctx.chii_dir, &rest).ok_or("bad path")?;
    match tokio::fs::read(&file).await {
        Ok(data) => {
            let mut r = plain(StatusCode::OK, data);
            r.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static(content_type(&file)));
            Ok(r)
        }
        Err(_) => Ok(plain(StatusCode::NOT_FOUND, "not found")),
    }
}

/// A page's DevTools-protocol socket: its messages go to every attached DevTools, theirs to it.
async fn run_target<S>(ws: WebSocketStream<S>, info: DevtoolsTarget, targets: Targets)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let id = info.id.clone();
    log::info!("[vidaa-devtools] target {id} connected from {}: {}", info.ip, info.url);
    let (mut sink, mut stream) = ws.split();
    let (to_target, mut inbox) = mpsc::unbounded_channel::<Message>();
    targets
        .lock()
        .unwrap()
        .insert(id.clone(), TargetSlot { info, to_target, clients: Vec::new() });
    let writer = tokio::spawn(async move {
        while let Some(msg) = inbox.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });
    while let Some(Ok(msg)) = stream.next().await {
        if !(msg.is_text() || msg.is_binary()) {
            continue;
        }
        if let Some(slot) = targets.lock().unwrap().get_mut(&id) {
            slot.clients.retain(|c| c.send(msg.clone()).is_ok());
        }
    }
    writer.abort();
    // Dropping the slot drops the client senders, which ends their sockets too.
    targets.lock().unwrap().remove(&id);
    log::info!("[vidaa-devtools] target {id} disconnected");
}

/// A DevTools frontend attached to one target.
async fn run_client<S>(ws: WebSocketStream<S>, target: String, targets: Targets)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut sink, mut stream) = ws.split();
    let (tx, mut inbox) = mpsc::unbounded_channel::<Message>();
    let to_target = {
        let mut map = targets.lock().unwrap();
        let Some(slot) = map.get_mut(&target) else {
            return;
        };
        slot.clients.push(tx);
        slot.to_target.clone()
    };
    let writer = tokio::spawn(async move {
        while let Some(msg) = inbox.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    while let Some(Ok(msg)) = stream.next().await {
        if (msg.is_text() || msg.is_binary()) && to_target.send(msg).is_err() {
            break;
        }
    }
    writer.abort();
}

/// Everything else: forward to the real host.
async fn proxy(req: Request<Incoming>, ctx: &Ctx) -> Result<Response<Body>, String> {
    let own = format!(
        "http://{}",
        req.headers().get(HOST).and_then(|h| h.to_str().ok()).unwrap_or("localhost")
    );
    let path_and_query = req.uri().path_and_query().map(|p| p.as_str().to_owned()).unwrap_or_else(|| "/".into());
    let path = req.uri().path().to_owned();
    let method = reqwest::Method::from_bytes(req.method().as_str().as_bytes()).map_err(|e| e.to_string())?;

    let mut upstream = ctx.client.request(method.clone(), format!("{}{}", ctx.origin, path_and_query));
    for (name, value) in req.headers() {
        if [HOST, hyper::header::CONNECTION, hyper::header::ACCEPT_ENCODING, hyper::header::CONTENT_LENGTH]
            .contains(name)
        {
            continue;
        }
        let value = value.to_str().unwrap_or_default();
        let value = if name == ORIGIN || name == REFERER { value.replace(&own, &ctx.origin) } else { value.to_owned() };
        upstream = upstream.header(name.as_str(), value);
    }
    if req.method() != Method::GET && req.method() != Method::HEAD {
        let body = req.into_body().collect().await.map_err(|e| e.to_string())?.to_bytes();
        upstream = upstream.body(body.to_vec());
    }

    let up = upstream.send().await.map_err(|e| e.to_string())?;
    let status = up.status().as_u16();
    let headers = up.headers().clone();
    let bytes = up.bytes().await.map_err(|e| e.to_string())?;

    let is_html = headers
        .get(CONTENT_TYPE.as_str())
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("text/html"));
    let inject = method == reqwest::Method::GET && is_app_page(&path) && is_html;
    let body = if inject {
        log::info!("[vidaa-devtools] serving {path} with DevTools attached");
        Bytes::from(rewrite_index(&String::from_utf8_lossy(&bytes), &ctx.origin, &own))
    } else {
        Bytes::from(bytes.to_vec())
    };

    let mut response = plain(StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY), body);
    let out = response.headers_mut();
    for (name, value) in headers.iter() {
        let n = name.as_str();
        if matches!(
            n,
            "content-length" | "content-encoding" | "transfer-encoding" | "connection" | "keep-alive"
                | "strict-transport-security" | "content-security-policy" | "alt-svc"
        ) {
            continue;
        }
        let Ok(v) = value.to_str() else { continue };
        let v = match n {
            "set-cookie" => rewrite_cookie(v),
            "location" => v.replace(&ctx.origin, &own),
            _ => v.to_owned(),
        };
        if let (Ok(hn), Ok(hv)) = (HeaderName::from_bytes(n.as_bytes()), HeaderValue::from_str(&v)) {
            out.append(hn, hv);
        }
    }
    if inject {
        out.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    Ok(response)
}

async fn serve(listener: TcpListener, ctx: Arc<Ctx>) {
    loop {
        let Ok((stream, peer)) = listener.accept().await else { continue };
        let ctx = ctx.clone();
        tokio::spawn(async move {
            let service = service_fn(move |mut req: Request<Incoming>| {
                req.extensions_mut().insert(peer);
                handle(req, ctx.clone())
            });
            let conn = http1::Builder::new().serve_connection(TokioIo::new(stream), service).with_upgrades();
            if let Err(e) = conn.await {
                log::debug!("[vidaa-devtools] connection from {peer} ended: {e}");
            }
        });
    }
}

/// Starts (or reuses) the DevTools proxy for `origin`, e.g. `https://uat-web.freetv.tv`.
#[tauri::command]
pub async fn vidaa_devtools_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VidaaDevtoolsState>,
    origin: String,
    tv_ip: Option<String>,
) -> Result<DevtoolsProxy, Error> {
    let origin = origin.trim_end_matches('/').to_owned();
    if !(origin.starts_with("https://") || origin.starts_with("http://")) || origin.matches('/').count() != 2 {
        return Err(Error::new(format!("Not an origin: {origin}")));
    }
    let lan_ip = tv_ip
        .as_deref()
        .and_then(lan_ip_towards)
        .or_else(|| lan_ip_towards("192.168.0.1"))
        .ok_or_else(|| Error::new("Could not work out this computer's LAN address."))?;

    let mut proxies = state.proxies.lock().await;
    if let Some(proxy) = proxies.get(&origin) {
        if !proxy.task.is_finished() {
            return Ok(DevtoolsProxy { origin, port: proxy.port, lan_ip });
        }
    }
    let chii_dir = app
        .path()
        .resolve("chii", BaseDirectory::Resource)
        .map_err(|e| Error::new(format!("DevTools files are missing from the app: {e}")))?;
    let port = port_for(&origin);
    let listener = TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port))).await.map_err(|e| {
        Error::new(format!(
            "Port {port} is in use, so DevTools cannot start. Close whatever holds it (an older log proxy?) and try again. ({e})"
        ))
    })?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| Error::new(e.to_string()))?;
    let ctx = Arc::new(Ctx { origin: origin.clone(), port, chii_dir, client, targets: state.targets.clone() });
    let task = tokio::spawn(serve(listener, ctx));
    log::info!("[vidaa-devtools] proxy for {origin} on {lan_ip}:{port}");
    proxies.insert(origin.clone(), Proxy { port, task });
    Ok(DevtoolsProxy { origin, port, lan_ip })
}

/// Pages currently attached, newest first.
#[tauri::command]
pub async fn vidaa_devtools_targets(state: State<'_, VidaaDevtoolsState>) -> Result<Vec<DevtoolsTarget>, Error> {
    let mut list: Vec<DevtoolsTarget> = state.targets.lock().unwrap().values().map(|t| t.info.clone()).collect();
    list.sort_by(|a, b| b.connected_at.cmp(&a.connected_at));
    Ok(list)
}

#[tauri::command]
pub async fn vidaa_devtools_stop(state: State<'_, VidaaDevtoolsState>) -> Result<(), Error> {
    state.proxies.lock().await.clear();
    state.targets.lock().unwrap().clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_points_at_the_proxy_and_loads_chii_first() {
        let html = "<!doctype html><html><head><meta charset=utf-8><script>window.c={hostUrl:'https://uat-web.freetv.tv/apps',baseUrl:'https://web.freetv.tv'}</script>";
        let out = rewrite_index(html, "https://uat-web.freetv.tv", "http://192.168.1.5:8765");
        assert!(out.contains("hostUrl:'http://192.168.1.5:8765/apps'"));
        assert!(out.contains("baseUrl:'https://web.freetv.tv'"), "the API host is left alone");
        assert!(
            out.contains(r#"<head><script src="http://192.168.1.5:8765/__chii/target.js"></script><meta"#),
            "Chii must load before the app: {out}"
        );
    }

    #[test]
    fn cookies_lose_domain_and_secure() {
        assert_eq!(
            rewrite_cookie("sid=1; Domain=.freetv.tv; Path=/; Secure; SameSite=None; HttpOnly"),
            "sid=1; Path=/; HttpOnly"
        );
    }

    #[test]
    fn freetv_hosts_have_fixed_ports() {
        assert_eq!(port_for("https://uat-web.freetv.tv"), 8765);
        assert_eq!(port_for("https://web.freetv.tv"), 8766);
        let other = port_for("https://example.com");
        assert!((8770..8800).contains(&other));
        assert_eq!(other, port_for("https://example.com"));
    }

    #[test]
    fn only_app_pages_are_rewritten() {
        assert!(is_app_page("/apps/smarttv/preprod/hisense/index.html"));
        assert!(!is_app_page("/api/products"));
        assert!(!is_app_page("/apps/smarttv/preprod/hisense/js/index.abc.js"));
    }

    #[test]
    fn chii_files_cannot_escape_their_folder() {
        let dir = Path::new("/res/chii");
        assert_eq!(chii_file(dir, "front_end/chii_app.html"), Some(PathBuf::from("/res/chii/front_end/chii_app.html")));
        assert_eq!(chii_file(dir, "../secrets"), None);
        assert_eq!(chii_file(dir, "front_end/../../x"), None);
    }

    #[test]
    fn target_query_is_decoded() {
        let q = "url=http%3A%2F%2F192.168.1.5%3A8765%2Fapps%2Findex.html&title=Free%20TV&__chobitsu-hide__=true";
        assert_eq!(query_param(q, "url").as_deref(), Some("http://192.168.1.5:8765/apps/index.html"));
        assert_eq!(query_param(q, "title").as_deref(), Some("Free TV"));
        assert_eq!(query_param(q, "missing"), None);
    }
}
