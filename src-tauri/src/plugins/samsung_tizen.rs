use adb_client::device::{ADBTransportMessage, MessageCommand};
use adb_client::{ADBMessageTransport, ADBTcpDevice};
use std::collections::HashMap;
use std::io::Read;
use std::net::SocketAddr;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

use crate::error::Error;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct TizenAppInfo {
    pub id: String,
    pub name: String,
    #[serde(rename = "versionName")]
    pub version_name: String,
    #[serde(rename = "runtimeId")]
    pub runtime_id: Option<String>,
    #[serde(rename = "tizenId")]
    pub tizen_id: Option<String>,
    #[serde(rename = "appIndex")]
    pub app_index: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TizenBrewDetails {
    system_info: Vec<TizenInfoEntry>,
    daemon_error: String,
}

#[derive(serde::Serialize)]
struct TizenInfoEntry {
    key: String,
    value: String,
}

static TIZEN_ADB_DEVICES: OnceLock<Mutex<HashMap<String, ADBTcpDevice>>> = OnceLock::new();
static TIZEN_ADB_LOCAL_ID: AtomicU32 = AtomicU32::new(1);

fn sdb_binary() -> String {
    // On Windows use USERPROFILE; on Unix use HOME
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();

    #[cfg(target_os = "windows")]
    let candidates = [
        format!("{home}\\tizen-studio\\tools\\sdb.exe"),
        format!("{home}\\tizen-studio-data\\tools\\sdb.exe"),
        "C:\\tizen-studio\\tools\\sdb.exe".to_string(),
    ];

    #[cfg(not(target_os = "windows"))]
    let candidates = [
        format!("{home}/tizen-studio/tools/sdb"),
        format!("{home}/tizen-studio-data/tools/sdb"),
        "/opt/tizen-studio/tools/sdb".to_string(),
    ];

    for path in &candidates {
        if std::path::Path::new(path).exists() {
            return path.clone();
        }
    }

    // Fall back to PATH lookup — "sdb" on Unix, "sdb.exe" on Windows
    #[cfg(target_os = "windows")]
    return "sdb.exe".to_string();
    #[cfg(not(target_os = "windows"))]
    "sdb".to_string()
}

fn sdb_serial(serial: &str) -> String {
    if serial.contains(':') {
        serial.to_string()
    } else {
        format!("{serial}:26101")
    }
}

fn ensure_sdb_connected(serial: &str) {
    let s = sdb_serial(serial);
    let _ = std::process::Command::new(sdb_binary())
        .args(["connect", &s])
        .output();
}

fn tizen_adb_device(serial: &str) -> Result<ADBTcpDevice, Error> {
    let addr: SocketAddr = sdb_serial(serial)
        .parse()
        .map_err(|e| Error::new(format!("Invalid Samsung TV address {serial}: {e}")))?;
    ADBTcpDevice::new(addr).map_err(|e| {
        Error::new(format!(
            "Failed to connect to Samsung TV via TizenBrew protocol: {e}"
        ))
    })
}

fn with_tizen_adb_device<T>(
    serial: &str,
    mut action: impl FnMut(&mut ADBTcpDevice) -> Result<T, Error>,
) -> Result<T, Error> {
    let serial = sdb_serial(serial);
    let devices = TIZEN_ADB_DEVICES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut last_error = None;

    for _ in 0..2 {
        let mut devices = devices
            .lock()
            .map_err(|_| Error::new("Samsung Tizen connection lock is poisoned"))?;
        if !devices.contains_key(&serial) {
            devices.insert(serial.clone(), tizen_adb_device(&serial)?);
        }

        let result = action(
            devices
                .get_mut(&serial)
                .expect("Samsung device was just inserted"),
        );
        match result {
            Ok(value) => return Ok(value),
            Err(e) => {
                last_error = Some(e);
                devices.remove(&serial);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| Error::new("Samsung Tizen command failed")))
}

fn tizen_run_shell(serial: &str, command: &str) -> Result<String, Error> {
    with_tizen_adb_device(serial, |device| {
        tizen_run_adb_service(device, &format!("shell:{command}\0")).map_err(|e| {
            Error::new(format!(
                "Samsung Tizen shell command failed ({command}): {e}"
            ))
        })
    })
}

fn tizen_run_daemon_command(serial: &str, command: &str) -> Result<String, Error> {
    with_tizen_adb_device(serial, |device| {
        tizen_run_adb_service(device, command)
            .map_err(|e| Error::new(format!("Samsung daemon command failed ({command}): {e}")))
    })
}

fn tizen_run_adb_service(device: &mut ADBTcpDevice, service: &str) -> Result<String, Error> {
    let local_id = TIZEN_ADB_LOCAL_ID.fetch_add(1, Ordering::Relaxed);
    device
        .inner_mut()
        .get_transport_mut()
        .write_message(ADBTransportMessage::new(
            MessageCommand::Open,
            local_id,
            0,
            service.as_bytes(),
        ))
        .map_err(|e| {
            Error::new(format!(
                "Failed to open Samsung ADB service {service:?}: {e}"
            ))
        })?;

    let response = device
        .inner_mut()
        .get_transport_mut()
        .read_message_with_timeout(Duration::from_secs(10))
        .map_err(|e| {
            Error::new(format!(
                "Failed to read Samsung ADB service open response: {e}"
            ))
        })?;
    if response.header().command() != MessageCommand::Okay {
        return Err(Error::new(format!(
            "ADB request failed - wrong command {}",
            response.header().command()
        )));
    }

    let mut output = Vec::new();
    loop {
        let response = device
            .inner_mut()
            .get_transport_mut()
            .read_message_with_timeout(Duration::from_secs(30))
            .map_err(|e| Error::new(format!("Failed to read Samsung ADB service response: {e}")))?;
        if response.header().command() != MessageCommand::Write {
            return Ok(String::from_utf8_lossy(&output).into_owned());
        }
        output.extend_from_slice(response.payload());
        device
            .inner_mut()
            .get_transport_mut()
            .write_message(ADBTransportMessage::new(
                MessageCommand::Okay,
                response.header().arg1(),
                response.header().arg0(),
                &[],
            ))
            .map_err(|e| {
                Error::new(format!(
                    "Failed to acknowledge Samsung ADB service response: {e}"
                ))
            })?;
    }
}

fn tizen_capability(serial: &str) -> Result<String, Error> {
    ensure_sdb_connected(serial);
    let s = sdb_serial(serial);
    let out = std::process::Command::new(sdb_binary())
        .args(["-s", &s, "capability"])
        .output()
        .map_err(|e| Error::new(format!("Failed to run sdb capability: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        return Err(Error::new(format!("sdb capability failed: {stderr}")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn tizen_run_sdb_shell(serial: &str, args: &[&str]) -> Result<String, Error> {
    ensure_sdb_connected(serial);
    let s = sdb_serial(serial);
    let out = std::process::Command::new(sdb_binary())
        .arg("-s")
        .arg(&s)
        .arg("shell")
        .args(args)
        .output()
        .map_err(|e| Error::new(format!("Failed to run sdb shell {}: {e}", args.join(" "))))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(Error::new(format!(
            "sdb shell {} failed: {detail}",
            args.join(" ")
        )));
    }

    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn tizen_run_sdb_shell_strings(serial: &str, args: &[String]) -> Result<String, Error> {
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    tizen_run_sdb_shell(serial, &arg_refs)
}

fn tizen_run_sdb_shell_for(
    serial: &str,
    args: &[String],
    timeout: Duration,
) -> Result<String, Error> {
    ensure_sdb_connected(serial);
    let s = sdb_serial(serial);
    let mut child = Command::new(sdb_binary())
        .arg("-s")
        .arg(&s)
        .arg("shell")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Error::new(format!("Failed to run sdb shell {}: {e}", args.join(" "))))?;

    let mut stdout = child.stdout.take().expect("stdout is piped");
    let mut stderr = child.stderr.take().expect("stderr is piped");
    let stdout_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| {
            Error::new(format!(
                "Failed to wait for sdb shell {}: {e}",
                args.join(" ")
            ))
        })? {
            break Some(status);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(100));
    };

    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    let stdout = String::from_utf8_lossy(&stdout).into_owned();
    let stderr = String::from_utf8_lossy(&stderr).trim().to_owned();

    if let Some(status) = status {
        if !status.success() {
            let detail = if stderr.is_empty() {
                stdout.trim().to_owned()
            } else {
                stderr
            };
            return Err(Error::new(format!(
                "sdb shell {} failed: {detail}",
                args.join(" ")
            )));
        }
    }

    Ok(stdout)
}

/// Read model name from `sdb devices` — the 3rd tab-separated column for the matching serial.
/// Example line: `192.168.50.180:26101\tdevice    \tUE43BU8000UXSQ`
fn tizen_model_from_devices(serial: &str) -> Option<String> {
    ensure_sdb_connected(serial);
    let s = sdb_serial(serial);
    let out = std::process::Command::new(sdb_binary())
        .args(["devices"])
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    for line in stdout.lines() {
        let cols: Vec<&str> = line.splitn(3, '\t').collect();
        if cols.len() >= 3 && cols[0].trim() == s {
            let model = cols[2].trim().to_owned();
            if !model.is_empty() {
                return Some(model);
            }
        }
    }
    None
}

fn parse_tizen_app_list(output: &str) -> Vec<TizenAppInfo> {
    const SEPARATOR: &str = "---------------------------------------------------------------------------------------------";
    let body: String = output.lines().skip(2).collect::<Vec<_>>().join("\n");
    let mut blocks: Vec<String> = body
        .split(SEPARATOR)
        .map(|s| {
            s.replace("--------------", "")
                .replace("-------------", "")
                .replace('\r', "")
        })
        .filter(|s| !s.trim().is_empty())
        .collect();
    blocks.pop();

    let mut apps = Vec::new();
    for block in &blocks {
        if block.trim() == "\n" || block.trim().is_empty() {
            continue;
        }
        let mut kv: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for line in block.lines() {
            if let Some(eq) = line.find('=') {
                let key = line[..eq].trim().to_owned();
                let value = line[eq + 1..].trim().to_owned();
                if !key.is_empty() {
                    kv.insert(key, value);
                }
            }
        }

        let app_id = kv.get("app_id").map(String::as_str).unwrap_or("").trim();
        let title = kv.get("app_title").map(String::as_str).unwrap_or("").trim();
        let version = kv
            .get("app_version")
            .map(String::as_str)
            .unwrap_or("")
            .trim();
        let tizen_id = kv
            .get("app_tizen_id")
            .map(String::as_str)
            .unwrap_or("")
            .trim();
        let app_index = kv.get("app_index").map(String::as_str).unwrap_or("").trim();

        if app_id.is_empty() && title.is_empty() {
            continue;
        }

        apps.push(TizenAppInfo {
            id: if !tizen_id.is_empty() {
                tizen_id.to_owned()
            } else {
                app_id.to_owned()
            },
            name: if title.is_empty() {
                app_id.to_owned()
            } else {
                title.to_owned()
            },
            version_name: version.to_owned(),
            runtime_id: if !app_id.is_empty() {
                Some(app_id.to_owned())
            } else {
                None
            },
            tizen_id: if !tizen_id.is_empty() {
                Some(tizen_id.to_owned())
            } else {
                None
            },
            app_index: if !app_index.is_empty() {
                Some(app_index.to_owned())
            } else {
                None
            },
        });
    }
    apps
}

fn extract_tizen_app_id(file_path: &str) -> Result<String, Error> {
    let file = std::fs::File::open(file_path)
        .map_err(|e| Error::new(format!("Cannot open {file_path}: {e}")))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| Error::new(format!("Not a valid ZIP/WGT/TPK file: {e}")))?;

    for manifest_name in &["config.xml", "tizen-manifest.xml"] {
        if let Ok(mut entry) = archive.by_name(manifest_name) {
            use std::io::Read;
            let mut contents = String::new();
            entry
                .read_to_string(&mut contents)
                .map_err(|e| Error::new(format!("Cannot read {manifest_name}: {e}")))?;
            let re =
                regex::Regex::new(r#"(?:widget|manifest)[^>]+?(?:id|package)="([^"]+)""#).unwrap();
            if let Some(cap) = re.captures(&contents) {
                return Ok(cap[1].trim().to_string());
            }
        }
    }

    Err(Error::new(
        "Could not find app ID in WGT/TPK manifest (config.xml or tizen-manifest.xml)",
    ))
}

fn parse_ini_entries(text: &str) -> Vec<TizenInfoEntry> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('[') || line.starts_with('#') {
                return None;
            }
            let (k, v) = line.split_once('=')?;
            let k = k.trim().to_owned();
            let v = v.trim().to_owned();
            if k.is_empty() || v.is_empty() {
                None
            } else {
                Some(TizenInfoEntry { key: k, value: v })
            }
        })
        .collect()
}

#[tauri::command]
async fn tizen_connect(serial: String) -> Result<String, Error> {
    let serial = sdb_serial(&serial);
    let devices = TIZEN_ADB_DEVICES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut devices = devices
        .lock()
        .map_err(|_| Error::new("Samsung Tizen connection lock is poisoned"))?;
    devices.insert(serial.clone(), tizen_adb_device(&serial)?);
    Ok(format!("Connected to {serial}"))
}

#[tauri::command]
async fn tizen_shell(serial: String, command: String) -> Result<String, Error> {
    tizen_run_shell(&serial, &command)
}

#[tauri::command]
async fn tizen_get_prop(serial: String, prop: String) -> Result<String, Error> {
    let ini = tizen_run_shell(&serial, "0 cat /etc/info.ini").unwrap_or_default();
    let key = match prop.as_str() {
        "ro.product.model" | "model" => "model_name",
        "ro.product.manufacturer" | "manufacturer" => "manufacturer",
        "ro.build.version.release" | "version" => "sw_version",
        other => other,
    };
    for line in ini.lines() {
        let line = line.trim();
        if let Some(val) = line.strip_prefix(&format!("{key}=")) {
            return Ok(val.trim().to_owned());
        }
        let lower = line.to_lowercase();
        let key_lower = key.to_lowercase();
        if lower.starts_with(&format!("{key_lower}=")) {
            return Ok(line[key.len() + 1..].trim().to_owned());
        }
    }
    Ok(String::new())
}

#[tauri::command]
async fn tizen_get_device_info(serial: String) -> Result<serde_json::Value, Error> {
    let capability = tizen_capability(&serial).unwrap_or_default();
    let mut tizen_version = String::new();
    let mut vendor = String::new();
    for line in capability.lines() {
        if let Some(v) = line.strip_prefix("platform_version:") {
            tizen_version = v.trim().to_owned();
        } else if let Some(v) = line.strip_prefix("vendor_name:") {
            vendor = v.trim().to_owned();
        }
    }

    // Primary model source: sdb devices (3rd column). Always works, even when shell is restricted.
    let model = tizen_model_from_devices(&serial).unwrap_or_default();

    // Try /etc/info.ini as supplemental source (may be empty on restricted TVs)
    let ini = tizen_run_shell(&serial, "0 cat /etc/info.ini").unwrap_or_default();
    let mut manufacturer = String::new();
    let mut fw_version = String::new();
    for line in ini.lines() {
        let line = line.trim();
        let lower = line.to_lowercase();
        if lower.starts_with("manufacturer=") {
            manufacturer = line[13..].trim().to_owned();
        } else if lower.starts_with("sw_version=") {
            fw_version = line[11..].trim().to_owned();
        }
    }

    if manufacturer.is_empty() {
        manufacturer = if !vendor.is_empty() {
            vendor
        } else {
            "Samsung".to_owned()
        };
    }
    let os_version = if !tizen_version.is_empty() {
        tizen_version
    } else {
        fw_version
    };

    Ok(serde_json::json!({
        "model": model,
        "manufacturer": manufacturer,
        "osVersion": os_version
    }))
}

#[tauri::command]
async fn tizen_list_apps(serial: String) -> Result<Vec<TizenAppInfo>, Error> {
    let out = tizen_run_sdb_shell(&serial, &["0", "vd_applist"])?;
    let apps = parse_tizen_app_list(&out);
    if !apps.is_empty() {
        return Ok(apps);
    }
    Err(Error::new(format!(
        "Samsung app list returned no parseable apps.\nRaw output ({} bytes):\n{}",
        out.len(),
        &out[..out.len().min(1000)]
    )))
}

#[tauri::command]
async fn tizen_install(serial: String, file_path: String) -> Result<String, Error> {
    let app_id = extract_tizen_app_id(&file_path)?;
    let file_name = std::path::Path::new(&file_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "app.wgt".to_string());
    let remote_path = format!("/opt/usr/apps/tmp/{file_name}");

    let s = sdb_serial(&serial);
    let push_out = std::process::Command::new(sdb_binary())
        .args(["-s", &s, "push", &file_path, &remote_path])
        .output()
        .map_err(|e| Error::new(format!("sdb push failed: {e}")))?;
    if !push_out.status.success() {
        let stderr = String::from_utf8_lossy(&push_out.stderr);
        return Err(Error::new(format!("sdb push failed: {stderr}")));
    }

    tizen_run_shell(&serial, &format!("0 vd_appinstall {app_id} {remote_path}"))
}

#[tauri::command]
async fn tizen_uninstall(
    serial: String,
    app_id: String,
    runtime_id: Option<String>,
) -> Result<String, Error> {
    let mut commands = Vec::new();
    if let Some(runtime_id) = runtime_id.as_deref() {
        commands.push(vec![
            "0".to_owned(),
            "vd_appuninstall".to_owned(),
            runtime_id.to_owned(),
        ]);
    }
    commands.push(vec![
        "0".to_owned(),
        "vd_appuninstall".to_owned(),
        app_id.clone(),
    ]);

    let mut pkg_ids = Vec::new();
    if let Some(prefix) = app_id.split('.').next() {
        if !prefix.is_empty() && prefix != app_id {
            pkg_ids.push(prefix.to_owned());
        }
    }
    if let Some(runtime_id) = runtime_id.as_deref() {
        pkg_ids.push(runtime_id.to_owned());
    }
    pkg_ids.push(app_id.clone());
    pkg_ids.sort();
    pkg_ids.dedup();

    for pkg_id in pkg_ids {
        commands.push(vec![
            "0".to_owned(),
            "pkgcmd".to_owned(),
            "-u".to_owned(),
            "-n".to_owned(),
            pkg_id,
        ]);
    }

    let mut errors = Vec::new();
    for command in commands {
        let serial_for_uninstall = serial.clone();
        let command_for_uninstall = command.clone();
        let command_label = command.join(" ");
        let task = tokio::task::spawn_blocking(move || {
            tizen_run_sdb_shell_strings(&serial_for_uninstall, &command_for_uninstall)
        });
        match tokio::time::timeout(Duration::from_secs(20), task).await {
            Ok(Ok(Ok(out))) => return Ok(out),
            Ok(Ok(Err(e))) if e.to_string().contains("closed") => return Ok("closed".to_owned()),
            Ok(Ok(Err(e))) => errors.push(format!("{command_label}: {e}")),
            Ok(Err(e)) => errors.push(format!("{command_label}: task failed: {e}")),
            Err(_) => errors.push(format!("{command_label}: timed out")),
        }
    }

    Err(Error::new(format!(
        "Failed to uninstall {app_id}.\n{}",
        errors.join("\n")
    )))
}

#[tauri::command]
async fn tizen_launch(serial: String, app_id: String) -> Result<String, Error> {
    tizen_run_sdb_shell(&serial, &["0", "execute", &app_id])
        .or_else(|_| tizen_run_sdb_shell(&serial, &["0", "was_execute", &app_id]))
}

#[tauri::command]
async fn tizen_kill(serial: String, app_id: String) -> Result<String, Error> {
    let mut errors = Vec::new();
    for args in [
        vec!["0", "was_kill", &app_id],
        vec!["0", "execute", "0", "kill", &app_id],
        vec!["0", "kill", &app_id],
    ] {
        let serial_for_kill = serial.clone();
        let command_for_kill: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
        let command_label = args.join(" ");
        let task = tokio::task::spawn_blocking(move || {
            tizen_run_sdb_shell_strings(&serial_for_kill, &command_for_kill)
        });
        match tokio::time::timeout(Duration::from_secs(8), task).await {
            Ok(Ok(Ok(out))) => return Ok(out),
            Ok(Ok(Err(e))) if e.to_string().contains("closed") => return Ok("closed".to_owned()),
            Ok(Ok(Err(e))) => errors.push(format!("{command_label}: {e}")),
            Ok(Err(e)) => errors.push(format!("{command_label}: task failed: {e}")),
            Err(_) => errors.push(format!("{command_label}: timed out")),
        }
    }

    Err(Error::new(format!(
        "Failed to kill {app_id}.\n{}",
        errors.join("\n")
    )))
}

#[tauri::command]
async fn tizen_debug(
    serial: String,
    app_id: String,
    #[allow(non_snake_case)] runtimeId: Option<String>,
) -> Result<u16, Error> {
    let launch_id = runtimeId.as_deref().unwrap_or(&app_id).to_owned();
    let _ = tizen_kill(serial.clone(), launch_id).await;
    tokio::time::sleep(Duration::from_millis(500)).await;

    let mut commands = vec![
        vec!["0".to_owned(), "debug".to_owned(), app_id.clone()],
        vec![
            "0".to_owned(),
            "debug".to_owned(),
            app_id.clone(),
            "1".to_owned(),
        ],
        vec!["0".to_owned(), "was_debug".to_owned(), app_id.clone()],
        vec![
            "0".to_owned(),
            "was_debug".to_owned(),
            app_id.clone(),
            "1".to_owned(),
        ],
    ];
    if let Some(runtime_id) = runtimeId.as_deref() {
        if runtime_id != app_id {
            commands.push(vec![
                "0".to_owned(),
                "debug".to_owned(),
                runtime_id.to_owned(),
            ]);
            commands.push(vec![
                "0".to_owned(),
                "debug".to_owned(),
                runtime_id.to_owned(),
                "1".to_owned(),
            ]);
            commands.push(vec![
                "0".to_owned(),
                "was_debug".to_owned(),
                runtime_id.to_owned(),
            ]);
            commands.push(vec![
                "0".to_owned(),
                "was_debug".to_owned(),
                runtime_id.to_owned(),
                "1".to_owned(),
            ]);
        }
    }
    commands.push(vec![
        "0".to_owned(),
        "debug".to_owned(),
        app_id.clone(),
        "0".to_owned(),
    ]);
    commands.push(vec![
        "0".to_owned(),
        "was_debug".to_owned(),
        app_id.clone(),
        "0".to_owned(),
    ]);
    if let Some(runtime_id) = runtimeId.as_deref() {
        if runtime_id != app_id {
            commands.push(vec![
                "0".to_owned(),
                "debug".to_owned(),
                runtime_id.to_owned(),
                "0".to_owned(),
            ]);
            commands.push(vec![
                "0".to_owned(),
                "was_debug".to_owned(),
                runtime_id.to_owned(),
                "0".to_owned(),
            ]);
        }
    }

    let mut errors = Vec::new();
    let mut out = String::new();
    for command in commands {
        let serial_for_debug = serial.clone();
        let command_for_debug = command.clone();
        let task = tokio::task::spawn_blocking(move || {
            tizen_run_sdb_shell_for(
                &serial_for_debug,
                &command_for_debug,
                Duration::from_secs(6),
            )
        });
        let command_label = command.join(" ");
        match tokio::time::timeout(Duration::from_secs(8), task).await {
            Ok(Ok(Ok(output))) => {
                out = output;
                if !out.trim().is_empty() {
                    break;
                }
                errors.push(format!("{command_label}: no output"));
            }
            Ok(Ok(Err(e))) => errors.push(format!("{command_label}: {e}")),
            Ok(Err(e)) => errors.push(format!("{command_label}: task failed: {e}")),
            Err(_) => errors.push(format!("{command_label}: timed out")),
        }
    }

    if out.trim().is_empty() {
        return Err(Error::new(format!(
            "Samsung debug did not return a port for {app_id}.\n{}",
            errors.join("\n")
        )));
    }

    let re = regex::Regex::new(r"(?i)(?:debug|port|debug_port)[:\s=]+(\d{4,5})").unwrap();
    if let Some(port) = re
        .captures(&out)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<u16>().ok())
    {
        return Ok(port);
    }

    let fallback = regex::Regex::new(r"\b(\d{4,5})\b").unwrap();
    fallback
        .captures(&out)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<u16>().ok())
        .ok_or_else(|| {
            Error::new(format!(
                "Could not parse debug port.\nRaw output:\n{out}\nAttempts:\n{}",
                errors.join("\n")
            ))
        })
}

#[tauri::command]
async fn tizen_get_duid(serial: String) -> Result<String, Error> {
    for cmd in &["0 duid", "0 /usr/bin/duid", "0 getprop _duid"] {
        if let Ok(out) = tizen_run_shell(&serial, cmd) {
            let t = out.trim().to_owned();
            if !t.is_empty() {
                return Ok(t);
            }
        }
    }
    Err(Error::new("Could not retrieve Samsung TV DUID"))
}

#[tauri::command]
async fn tizen_get_app_version(serial: String, app_id: String) -> Result<String, Error> {
    let out = tizen_run_shell(&serial, &format!("0 pkginfo --pkg {app_id}"))?;
    regex::Regex::new(r"(?mi)^Version:\s*(.+)")
        .unwrap()
        .captures(&out)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_owned())
        .ok_or_else(|| Error::new(format!("Could not parse version from: {out}")))
}

#[tauri::command]
async fn tizen_daemon_command(serial: String, command: String) -> Result<String, Error> {
    tizen_run_daemon_command(&serial, &command)
}

#[tauri::command]
async fn tizen_install_tizen_brew(serial: String, file_path: String) -> Result<String, Error> {
    let pkg_name = std::path::Path::new(&file_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "package.wgt".to_string());
    let remote_path = format!("/tmp/{pkg_name}");

    let s = sdb_serial(&serial);
    let push_out = std::process::Command::new(sdb_binary())
        .args(["-s", &s, "push", &file_path, &remote_path])
        .output()
        .map_err(|e| Error::new(format!("sdb push failed: {e}")))?;
    if !push_out.status.success() {
        let stderr = String::from_utf8_lossy(&push_out.stderr);
        return Err(Error::new(format!("sdb push failed: {stderr}")));
    }

    let app_id = extract_tizen_app_id(&file_path).ok();
    let install_cmd = if let Some(ref id) = app_id {
        format!("0 vd_appinstall {id} {remote_path}")
    } else {
        format!("0 vd_appinstall {remote_path}")
    };

    tizen_run_shell(&serial, &install_cmd).map_err(|e| {
        Error::new(format!(
            "Install failed: {e}\nMake sure TizenBrew is installed on the TV."
        ))
    })
}

#[tauri::command]
async fn tizen_tizen_brew_device_details(serial: String) -> Result<TizenBrewDetails, Error> {
    let mut entries: Vec<TizenInfoEntry> = Vec::new();
    let mut daemon_error = String::new();

    // Model name from sdb devices is the most reliable source (works even on restricted shells)
    if let Some(model) = tizen_model_from_devices(&serial) {
        entries.push(TizenInfoEntry {
            key: "model_name".to_owned(),
            value: model,
        });
    }

    match tizen_run_shell(&serial, "0 cat /etc/info.ini") {
        Ok(ini) => {
            let ini_entries = parse_ini_entries(&ini);
            // Merge ini entries, but don't overwrite model_name if already set from sdb devices
            let has_model = entries
                .iter()
                .any(|e| e.key.eq_ignore_ascii_case("model_name"));
            for entry in ini_entries {
                if has_model && entry.key.eq_ignore_ascii_case("model_name") {
                    continue;
                }
                entries.push(entry);
            }
        }
        Err(e) => {
            daemon_error = format!("sdb shell 0 cat /etc/info.ini failed: {e}");
        }
    }

    match tizen_capability(&serial) {
        Ok(cap) => {
            for line in cap.lines() {
                if let Some(colon) = line.find(':') {
                    let raw_key = line[..colon].trim();
                    let value = line[colon + 1..].trim().to_owned();
                    if raw_key.is_empty() || value.is_empty() {
                        continue;
                    }
                    let key = match raw_key {
                        "platform_version" => "TIZEN_VERSION".to_owned(),
                        "cpu_arch" => "CPU_ARCH".to_owned(),
                        "profile_name" => "PROFILE".to_owned(),
                        "sdk_version" => "SDK_VERSION".to_owned(),
                        other => other.replace('_', " ").to_uppercase(),
                    };
                    entries.push(TizenInfoEntry { key, value });
                }
            }
        }
        Err(e) => {
            let cap_err = format!("sdb capability failed: {e}");
            if daemon_error.is_empty() {
                daemon_error = cap_err;
            } else {
                daemon_error.push_str(&format!(" | {cap_err}"));
            }
        }
    }

    Ok(TizenBrewDetails {
        system_info: entries,
        daemon_error,
    })
}

pub fn plugin<R: Runtime>(name: &'static str) -> TauriPlugin<R> {
    Builder::new(name)
        .invoke_handler(tauri::generate_handler![
            tizen_connect,
            tizen_shell,
            tizen_get_prop,
            tizen_get_device_info,
            tizen_list_apps,
            tizen_install,
            tizen_uninstall,
            tizen_launch,
            tizen_kill,
            tizen_debug,
            tizen_get_duid,
            tizen_get_app_version,
            tizen_daemon_command,
            tizen_install_tizen_brew,
            tizen_tizen_brew_device_details,
        ])
        .build()
}
