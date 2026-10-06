//! Hisense VIDAA app control through the DevKit Web relay.
//!
//! DevKit Web (partner-doc.vidaa.com) is a thin client over a public AWS WebSocket relay: the TV's
//! DevKit app ("Connect to PC") shows a 6-character connection code, `verifyConnectionCode` trades
//! it for an `authCode`, and every command is a JSON frame on the `/pc` socket. No partner login
//! and no browser — the code is the only credential. Protocol, typeCodes and the live checks
//! against our U9 set are in AGENTS.md → "VIDAA (Hisense) — Implementation Plan".
//!
//! One session at a time, held in [`VidaaState`]. The TV pushes its info and installed-app list
//! on connect and after every change; those land in a snapshot and go to the UI over the
//! [`Channel`] given to `vidaa_connect`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, State};
use tauri_plugin_http::reqwest;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;

use crate::error::Error;

const VERIFY_URL: &str = "https://t71feyeud8.execute-api.us-east-1.amazonaws.com/verifyConnectionCode";
const SOCKET_URL: &str = "wss://0007z5zfh1.execute-api.us-east-1.amazonaws.com/pc";
/// DevKit Web sends this text frame every 9 minutes; API Gateway drops idle sockets at 10.
const HEARTBEAT: Duration = Duration::from_secs(540);
/// An install makes the TV fetch the page and icon before it answers.
const FEEDBACK_TIMEOUT: Duration = Duration::from_secs(60);
const ACK_TIMEOUT: Duration = Duration::from_secs(15);

const TYPE_TV_INFO: u64 = 0;
const TYPE_INSTALL_APP: u64 = 2;
const TYPE_DEEPLINKING: u64 = 3;
const TYPE_INSTALLED_APPS: u64 = 4;
const TYPE_WEBLOG: u64 = 5;
const TYPE_OTHER_SIDE_OFFLINE: u64 = 7;
const TYPE_INSTALL_FEEDBACK: u64 = 8;
const TYPE_UNINSTALL_APP: u64 = 10;
const TYPE_TV_LOG: u64 = 11;

/// What Close launches. DevKit has no close command, but DEEPLINKING replaces whatever web app
/// is in the foreground, and a page that calls `window.close()` then hands the screen back to the
/// launcher — verified on our U9 set: FreeTV PreProd went away and the TV returned home. The
/// second call is a fallback for firmware that ignores a plain `window.close()`.
const CLOSE_PAGE: &str = "data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Cbody%20style%3D%22background%3A%23000%22%3E%3Cscript%3Ewindow.close()%3BsetTimeout(function()%7Btry%7Bwindow.open(''%2C'_self').close()%7Dcatch(e)%7B%7D%7D%2C1500)%3C%2Fscript%3E";

const RESPONSE_PC_CONNECTED: u64 = 1;
const RESPONSE_SEND_SUCCESS: u64 = 2;

/// What the relay's `resultCode` means, as DevKit Web words it.
fn result_message(code: u64) -> &'static str {
    match code {
        0 => "ok",
        1 => "server error",
        2 => "connection code duplicated",
        3 => "wrong connection code",
        4 => "the TV is offline",
        5 => "already online",
        6 => "the TV reported a failure",
        _ => "unknown error",
    }
}

/// The DevKit `sendMessage` envelope.
fn message(type_code: u64, payload: Value, message_id: u64) -> String {
    json!({"action": "sendMessage", "data": {"typeCode": type_code, "payload": payload, "messageId": message_id}})
        .to_string()
}

fn connect_pc(code: &str, message_id: u64) -> String {
    json!({"action": "connectPC", "data": {"connectionCode": code, "messageId": message_id}}).to_string()
}

/// The install payload exactly as DevKit Web's form builds it. Sending `"Id": ""` — which an
/// edit carries — makes the TV answer the install with resultCode 6, so it is left out.
fn install_payload(name: &str, url: &str, icon_url: &str, resolution: &str) -> Value {
    json!({
        "name": name,
        "url": url,
        "IconUrl": icon_url,
        "currentUpdateDate": "",
        "resolution": resolution,
        "configUrl": "",
    })
}

/// DevKit Web's own rule for app names; the TV derives the app id (`debug-<name>`) from it.
fn valid_app_name(name: &str) -> bool {
    !name.trim().is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c.is_whitespace())
}

fn number(value: &Value, key: &str) -> Option<u64> {
    match value.get(key)? {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VidaaSnapshot {
    connected: bool,
    tv_info: Option<Value>,
    apps: Vec<Value>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum VidaaEvent {
    TvInfo(Value),
    Apps(Vec<Value>),
    Log(String),
    Disconnected(String),
}

/// One request waiting for the TV: the relay's send ack, or the install/uninstall feedback.
enum Waiter {
    Ack(oneshot::Sender<Result<(), Error>>),
    Feedback(u64, oneshot::Sender<Result<(), Error>>),
}

struct Session {
    outgoing: mpsc::UnboundedSender<Message>,
    snapshot: Arc<StdMutex<VidaaSnapshot>>,
    waiters: Arc<StdMutex<Vec<Waiter>>>,
    /// Commands are answered without a message id, so they run one at a time.
    op: Mutex<()>,
    next_id: AtomicU64,
    tasks: Vec<JoinHandle<()>>,
}

impl Session {
    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    fn send(&self, text: String) -> Result<(), Error> {
        self.outgoing
            .send(Message::Text(text))
            .map_err(|_| Error::new("The VIDAA DevKit connection is closed. Connect again."))
    }

    async fn request(&self, frame: String, feedback_for: Option<u64>) -> Result<(), Error> {
        let _guard = self.op.lock().await;
        let (tx, rx) = oneshot::channel();
        let (wait, limit) = match feedback_for {
            Some(type_code) => (Waiter::Feedback(type_code, tx), FEEDBACK_TIMEOUT),
            None => (Waiter::Ack(tx), ACK_TIMEOUT),
        };
        self.waiters.lock().unwrap().push(wait);
        self.send(frame)?;
        match timeout(limit, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(Error::new("The VIDAA DevKit connection closed before the TV answered.")),
            Err(_) => {
                self.waiters.lock().unwrap().clear();
                Err(Error::Timeout)
            }
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.outgoing.send(Message::Close(None));
        for task in &self.tasks {
            task.abort();
        }
    }
}

#[derive(Default)]
pub struct VidaaState {
    /// Held in an `Arc` so a command can wait on the TV without locking out `vidaa_status`.
    session: Mutex<Option<Arc<Session>>>,
}

impl VidaaState {
    async fn current(&self) -> Result<Arc<Session>, Error> {
        self.session.lock().await.clone().ok_or_else(not_connected)
    }
}

/// Routes one frame from the relay: resolves the waiting request, or folds a push into the
/// snapshot and forwards it to the UI. Returns false once the TV has gone away.
fn dispatch(
    frame: &Value,
    snapshot: &StdMutex<VidaaSnapshot>,
    waiters: &StdMutex<Vec<Waiter>>,
    events: &Channel<VidaaEvent>,
) -> bool {
    if number(frame, "responseTypeCode") == Some(RESPONSE_SEND_SUCCESS) {
        let result = match number(frame, "resultCode").unwrap_or(0) {
            0 => Ok(()),
            code => Err(Error::new(format!("VIDAA relay: {}", result_message(code)))),
        };
        let mut waiters = waiters.lock().unwrap();
        if let Some(pos) = waiters.iter().position(|w| matches!(w, Waiter::Ack(_))) {
            if let Waiter::Ack(tx) = waiters.remove(pos) {
                let _ = tx.send(result);
            }
        } else if let Err(e) = result {
            // A failed send whose request was a feedback wait: fail that instead of timing out.
            if let Some(Waiter::Feedback(_, tx)) = waiters.pop() {
                let _ = tx.send(Err(e));
            }
        }
        return true;
    }

    match number(frame, "typeCode") {
        Some(TYPE_TV_INFO) => {
            let info = frame.get("payload").cloned().unwrap_or(Value::Null);
            snapshot.lock().unwrap().tv_info = Some(info.clone());
            let _ = events.send(VidaaEvent::TvInfo(info));
        }
        Some(TYPE_INSTALLED_APPS) => {
            let apps = frame.get("payload").and_then(Value::as_array).cloned().unwrap_or_default();
            snapshot.lock().unwrap().apps = apps.clone();
            let _ = events.send(VidaaEvent::Apps(apps));
        }
        Some(TYPE_INSTALL_FEEDBACK) => {
            let source = number(frame, "sourceTypeCode");
            let result = match number(frame, "resultCode").unwrap_or(0) {
                0 => Ok(()),
                code => Err(Error::new(format!("The TV refused it: {}", result_message(code)))),
            };
            let mut waiters = waiters.lock().unwrap();
            let pos = waiters
                .iter()
                .position(|w| matches!(w, Waiter::Feedback(t, _) if Some(*t) == source));
            // Feedback can trail the ack, and the ack is consumed by the time it arrives; take
            // the oldest feedback waiter if the source type does not match one exactly.
            let pos = pos.or_else(|| waiters.iter().position(|w| matches!(w, Waiter::Feedback(..))));
            if let Some(pos) = pos {
                if let Waiter::Feedback(_, tx) = waiters.remove(pos) {
                    let _ = tx.send(result);
                }
            }
        }
        Some(TYPE_TV_LOG) | Some(TYPE_WEBLOG) => {
            let line = match frame.get("payload") {
                Some(Value::String(s)) => s.clone(),
                Some(other) => other.to_string(),
                None => String::new(),
            };
            let _ = events.send(VidaaEvent::Log(line));
        }
        Some(TYPE_OTHER_SIDE_OFFLINE) => return false,
        _ => log::debug!("[vidaa] unhandled frame: {frame}"),
    }
    true
}

#[tauri::command]
async fn vidaa_connect(
    state: State<'_, VidaaState>,
    code: String,
    on_event: Channel<VidaaEvent>,
) -> Result<VidaaSnapshot, Error> {
    let code = code.trim().to_uppercase();
    if code.len() != 6 || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(Error::new("The connection code is the 6 letters and digits DevKit shows on the TV."));
    }
    // Drop any previous session first: the relay allows one PC per TV code.
    state.session.lock().await.take();

    let response = reqwest::Client::new()
        .post(VERIFY_URL)
        .json(&json!({"connectionCode": code}))
        .timeout(Duration::from_secs(15))
        .send()
        .await?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        log::warn!("[vidaa] verifyConnectionCode -> {status}: {body}");
        return Err(Error::new(format!(
            "The TV did not accept code {code} ({status}). Open DevKit → Connect to PC on the TV and use the code it shows now."
        )));
    }
    let auth_code = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v.get("authCode").and_then(Value::as_str).map(str::to_owned))
        .ok_or_else(|| Error::new(format!("Unexpected answer from the VIDAA relay: {body}")))?;

    let url = format!("{SOCKET_URL}?authCode={}", urlencode(&auth_code));
    let (ws, _) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|e| Error::new(format!("Could not open the VIDAA relay socket: {e}")))?;
    let (mut sink, mut stream) = ws.split();

    sink.send(Message::Text(connect_pc(&code, 1)))
        .await
        .map_err(|e| Error::new(format!("VIDAA relay: {e}")))?;

    // The relay answers connectPC first; pushes (TV info, app list) follow it.
    let snapshot = Arc::new(StdMutex::new(VidaaSnapshot::default()));
    let waiters = Arc::new(StdMutex::new(Vec::new()));
    let mut early = Vec::new();
    let connected = timeout(Duration::from_secs(15), async {
        while let Some(msg) = stream.next().await {
            let Ok(Message::Text(text)) = msg else { continue };
            let Ok(frame) = serde_json::from_str::<Value>(&text) else { continue };
            if number(&frame, "responseTypeCode") == Some(RESPONSE_PC_CONNECTED) {
                return match number(&frame, "resultCode").unwrap_or(0) {
                    0 => Ok(()),
                    c => Err(Error::new(format!("The TV refused the connection: {}", result_message(c)))),
                };
            }
            early.push(frame);
        }
        Err(Error::new("The VIDAA relay closed the connection."))
    })
    .await
    .map_err(|_| Error::Timeout)?;
    connected?;
    log::info!("[vidaa] connected with code {code}");

    snapshot.lock().unwrap().connected = true;
    for frame in &early {
        dispatch(frame, &snapshot, &waiters, &on_event);
    }

    let (outgoing, mut queue) = mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        let mut beat = tokio::time::interval(HEARTBEAT);
        beat.tick().await;
        loop {
            tokio::select! {
                next = queue.recv() => match next {
                    Some(msg) => {
                        let closing = matches!(msg, Message::Close(_));
                        if sink.send(msg).await.is_err() || closing { break; }
                        beat.reset();
                    }
                    None => break,
                },
                _ = beat.tick() => {
                    if sink.send(Message::Text("heartbeat".into())).await.is_err() { break; }
                }
            }
        }
    });

    let reader = {
        let snapshot = snapshot.clone();
        let waiters = waiters.clone();
        tokio::spawn(async move {
            let reason = loop {
                match stream.next().await {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(frame) = serde_json::from_str::<Value>(&text) else { continue };
                        if !dispatch(&frame, &snapshot, &waiters, &on_event) {
                            break "The TV went offline (DevKit was closed or disconnected).".to_owned();
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break "The VIDAA relay closed the connection.".to_owned(),
                    Some(Err(e)) => break format!("VIDAA relay error: {e}"),
                    Some(Ok(_)) => {}
                }
            };
            log::info!("[vidaa] disconnected: {reason}");
            snapshot.lock().unwrap().connected = false;
            waiters.lock().unwrap().clear();
            let _ = on_event.send(VidaaEvent::Disconnected(reason));
        })
    };

    let result = snapshot.lock().unwrap().clone();
    *state.session.lock().await = Some(Arc::new(Session {
        outgoing,
        snapshot,
        waiters,
        op: Mutex::new(()),
        next_id: AtomicU64::new(2),
        tasks: vec![writer, reader],
    }));
    Ok(result)
}

/// Percent-encodes everything outside the URL-safe set, as `encodeURIComponent` does.
fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[tauri::command]
async fn vidaa_disconnect(state: State<'_, VidaaState>) -> Result<(), Error> {
    state.session.lock().await.take();
    Ok(())
}

#[tauri::command]
async fn vidaa_status(state: State<'_, VidaaState>) -> Result<VidaaSnapshot, Error> {
    Ok(match state.session.lock().await.as_deref() {
        Some(session) => session.snapshot.lock().unwrap().clone(),
        None => VidaaSnapshot::default(),
    })
}

#[tauri::command]
async fn vidaa_install(
    state: State<'_, VidaaState>,
    name: String,
    url: String,
    icon_url: String,
    resolution: Option<String>,
) -> Result<(), Error> {
    if !valid_app_name(&name) {
        return Err(Error::new("App names may only contain letters, digits, spaces and underscores."));
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(Error::new("The app URL must start with http:// or https://."));
    }
    let session = state.current().await?;
    let payload = install_payload(name.trim(), &url, &icon_url, resolution.as_deref().unwrap_or("hisense"));
    log::info!("[vidaa] install {name} -> {url}");
    session.request(message(TYPE_INSTALL_APP, payload, session.next_id()), Some(TYPE_INSTALL_APP)).await
}

#[tauri::command]
async fn vidaa_launch(state: State<'_, VidaaState>, url: String, resolution: Option<String>) -> Result<(), Error> {
    let session = state.current().await?;
    let payload = json!({"url": url, "type": resolution.as_deref().unwrap_or("hisense")});
    log::info!("[vidaa] launch {url}");
    session.request(message(TYPE_DEEPLINKING, payload, session.next_id()), None).await
}

/// Closes the web app in the foreground — whichever it is; the TV runs one at a time.
#[tauri::command]
async fn vidaa_close(state: State<'_, VidaaState>) -> Result<(), Error> {
    let session = state.current().await?;
    log::info!("[vidaa] close the foreground app");
    let payload = json!({"url": CLOSE_PAGE, "type": "hisense"});
    session.request(message(TYPE_DEEPLINKING, payload, session.next_id()), None).await
}

#[tauri::command]
async fn vidaa_uninstall(state: State<'_, VidaaState>, id: String) -> Result<(), Error> {
    let session = state.current().await?;
    log::info!("[vidaa] uninstall {id}");
    session
        .request(message(TYPE_UNINSTALL_APP, json!({"Id": id}), session.next_id()), Some(TYPE_UNINSTALL_APP))
        .await
}

fn not_connected() -> Error {
    Error::new("Not connected to a VIDAA TV. Enter the code DevKit shows under Connect to PC.")
}

pub fn plugin<R: Runtime>(name: &'static str) -> TauriPlugin<R> {
    Builder::new(name)
        .invoke_handler(tauri::generate_handler![
            vidaa_connect,
            vidaa_disconnect,
            vidaa_status,
            vidaa_install,
            vidaa_launch,
            vidaa_close,
            vidaa_uninstall,
        ])
        .setup(|app, _api| {
            app.manage(VidaaState::default());
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_payload_matches_devkit_form_and_has_no_id() {
        let p = install_payload("FreeTV PreProd", "https://x/index.html", "https://x/icon.png", "hisense");
        assert_eq!(p["name"], "FreeTV PreProd");
        assert_eq!(p["IconUrl"], "https://x/icon.png");
        assert_eq!(p["resolution"], "hisense");
        assert_eq!(p["currentUpdateDate"], "");
        assert!(p.get("Id").is_none(), "an empty Id makes the TV fail the install");
    }

    #[test]
    fn envelopes_match_devkit_web() {
        let m: Value = serde_json::from_str(&message(3, json!({"url": "u", "type": "hisense"}), 7)).unwrap();
        assert_eq!(m["action"], "sendMessage");
        assert_eq!(m["data"]["typeCode"], 3);
        assert_eq!(m["data"]["messageId"], 7);
        let c: Value = serde_json::from_str(&connect_pc("ABC123", 1)).unwrap();
        assert_eq!(c["action"], "connectPC");
        assert_eq!(c["data"]["connectionCode"], "ABC123");
    }

    #[test]
    fn app_names_follow_devkit_rule() {
        assert!(valid_app_name("FreeTV PreProd"));
        assert!(valid_app_name("freetv_uat 2"));
        assert!(!valid_app_name("FreeTV-PreProd"));
        assert!(!valid_app_name("  "));
    }

    #[test]
    fn urlencode_matches_encode_uri_component() {
        assert_eq!(urlencode("a+b/c=="), "a%2Bb%2Fc%3D%3D");
        assert_eq!(urlencode("Az09-_.~"), "Az09-_.~");
    }

    #[test]
    fn close_page_decodes_to_a_self_closing_page() {
        let encoded = CLOSE_PAGE.strip_prefix("data:text/html;charset=utf-8,").unwrap();
        let mut bytes = Vec::new();
        let mut it = encoded.bytes();
        while let Some(b) = it.next() {
            if b == b'%' {
                let hex = [it.next().unwrap(), it.next().unwrap()];
                bytes.push(u8::from_str_radix(std::str::from_utf8(&hex).unwrap(), 16).unwrap());
            } else {
                bytes.push(b);
            }
        }
        let html = String::from_utf8(bytes).unwrap();
        assert!(html.contains("<script>window.close();"), "{html}");
        assert!(html.ends_with("</script>"), "{html}");
    }

    #[test]
    fn numbers_may_arrive_as_strings() {
        let f = json!({"typeCode": "8", "resultCode": 0});
        assert_eq!(number(&f, "typeCode"), Some(8));
        assert_eq!(number(&f, "resultCode"), Some(0));
    }
}

#[cfg(test)]
mod acl_tests {
    //! `vidaa` commands must appear in all three places, or they fail only at runtime with
    //! "not allowed by ACL" — see AGENTS.md → "Adding a Tauri Command — Three Places, Not One".

    fn registered() -> Vec<String> {
        let source = include_str!("vidaa.rs");
        let start = source.find("tauri::generate_handler![").expect("generate_handler! not found");
        let body = &source[start..];
        let end = body.find("])").expect("unterminated generate_handler!");
        body[..end]
            .lines()
            .skip(1)
            .map(|line| line.trim().trim_end_matches(',').to_owned())
            .filter(|name| !name.is_empty())
            .collect()
    }

    fn declared_in_build_rs() -> Vec<String> {
        let source = include_str!("../../build.rs");
        let start = source.find(r#""vidaa""#).expect("vidaa plugin not found in build.rs");
        let body = &source[start..];
        let end = body.find("]),").expect("unterminated commands list");
        body[..end]
            .split('"')
            .filter(|piece| piece.starts_with("vidaa_"))
            .map(str::to_owned)
            .collect()
    }

    fn allowed_by_default() -> Vec<String> {
        include_str!("../../permissions/vidaa/default.toml")
            .lines()
            .filter_map(|line| {
                let entry = line.trim().trim_end_matches(',').trim_matches('"');
                entry.strip_prefix("allow-").map(|name| name.replace('-', "_"))
            })
            .collect()
    }

    #[test]
    fn every_registered_command_is_declared_and_permitted() {
        let registered = registered();
        assert!(registered.len() >= 6, "parsed too few commands: {registered:?}");
        let declared = declared_in_build_rs();
        let allowed = allowed_by_default();
        for name in &registered {
            assert!(declared.contains(name), "{name} missing from build.rs");
            assert!(allowed.contains(name), "{name} missing from permissions/vidaa/default.toml");
        }
        for name in &declared {
            assert!(registered.contains(name), "{name} in build.rs but not registered");
        }
    }
}
