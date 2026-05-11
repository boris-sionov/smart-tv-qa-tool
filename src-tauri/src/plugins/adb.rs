use adb_client::device::{ADBTransportMessage, MessageCommand};
use adb_client::{ADBDeviceExt, ADBMessageTransport, ADBTcpDevice};
use futures::future::join_all;
use std::net::SocketAddr;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Runtime};
use tauri_plugin_shell::ShellExt;

use crate::error::Error;

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct AdbDevice {
    pub serial: String,
    pub state: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct AdbPackageInfo {
    pub id: String,
    pub name: String,
    #[serde(rename = "versionName")]
    pub version_name: String,
}

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
}

// ---------------------------------------------------------------------------
// App name / sort helpers (Android TV)
// ---------------------------------------------------------------------------

fn app_name(package_id: &str) -> Option<&'static str> {
    match package_id {
        "tv.freetv.androidtv" => Some("FreeTV"),
        "tv.freetv.androidtv.uat" | "tv.freetv.portal.preprod" => Some("FreeTV UAT"),
        "il.co.stingtv.atv" | "com.stingtv.androidtv" => Some("StingTV"),
        "il.co.stingtv.staging" | "com.stingtv.androidtv.staging" => Some("StingTV Staging"),
        "il.co.yes.yesplus" | "com.yes.yestv" | "tv.yes.androidtv" => Some("Yes+"),
        "il.co.partnertv.atv" | "tv.partner.androidtv" => Some("PartnerTV"),
        "il.co.partnertv.atv.staging" | "tv.partner.androidtv.staging" => {
            Some("PartnerTV Staging")
        }
        "com.cellcom.cellcom_tv" | "tv.cellcom.androidtv" => Some("CellcomTV"),
        "tv.cellcom.androidtv.stg" => Some("CellcomTV STG"),
        "com.hot.stb" | "il.co.hotnet.stb" => Some("Hot"),
        "com.hot.nexttv" | "il.co.hot.nexttv" => Some("NextTV"),
        "com.disney.disneyplus" => Some("Disney+"),
        "com.warnermedia.max" | "com.hbo.hbomax" => Some("HBO"),
        "com.netflix.mediaclient" => Some("Netflix"),
        "com.amazon.venezia" => Some("Amazon"),
        "com.apple.appletv" => Some("Apple TV+"),
        _ => None,
    }
}

fn sort_key(name: &str) -> u32 {
    let brands = [
        "FreeTV", "Yes", "Sting", "Partner", "Cellcom", "Hot", "NextTV", "Disney+", "HBO",
        "Netflix", "Amazon", "Apple TV+",
    ];
    let name_lower = name.to_lowercase();
    for (i, brand) in brands.iter().enumerate() {
        if name_lower.contains(&brand.to_lowercase()) {
            let variant =
                name.contains("UAT") || name.contains("Staging") || name.contains("STG");
            return (i as u32) * 10 + if variant { 1 } else { 0 };
        }
    }
    999
}

// ---------------------------------------------------------------------------
// Android TV helpers (ADB sidecar)
// ---------------------------------------------------------------------------

async fn run_adb<R: Runtime>(app: &AppHandle<R>, args: &[&str]) -> Result<String, Error> {
    let output = app
        .shell()
        .sidecar("adb")
        .map_err(|e| Error::new(format!("Failed to create ADB sidecar: {e}")))?
        .args(args)
        .output()
        .await
        .map_err(|e| Error::new(format!("Failed to run ADB: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(Error::new(if stderr.is_empty() {
            format!("adb exited with code {:?}", output.status.code())
        } else {
            stderr
        }));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

// ---------------------------------------------------------------------------
// Tizen helpers (native ADB/SDB protocol — no binary needed)
// ---------------------------------------------------------------------------

fn tizen_tcp_device(serial: &str) -> Result<ADBTcpDevice, Error> {
    let target = if serial.contains(':') {
        serial.to_string()
    } else {
        format!("{serial}:26101")
    };
    let addr: SocketAddr = target
        .parse()
        .map_err(|e| Error::new(format!("Invalid Tizen address {target}: {e}")))?;
    ADBTcpDevice::new(addr)
        .map_err(|e| Error::new(format!("Cannot connect to Tizen device at {target}: {e}")))
}

fn tizen_run_shell(serial: &str, command: &str) -> Result<String, Error> {
    let mut device = tizen_tcp_device(serial)?;
    let mut output = Vec::new();
    device
        .shell_command(&[command], &mut output)
        .map_err(|e| Error::new(format!("Tizen shell '{command}' failed: {e}")))?;
    Ok(String::from_utf8_lossy(&output).trim().to_owned())
}

fn tizen_daemon_open(serial: &str, daemon_command: &str) -> Result<String, Error> {
    let target = if serial.contains(':') {
        serial.to_string()
    } else {
        format!("{serial}:26101")
    };
    let parsed: SocketAddr = target
        .parse()
        .map_err(|e| Error::new(format!("Failed to parse SDB address {target}: {e}")))?;
    let mut device = ADBTcpDevice::new(parsed)
        .map_err(|e| Error::new(format!("Failed to connect to SDB at {target}: {e}")))?;

    let res = device
        .inner_mut()
        .open_session(daemon_command.as_bytes())
        .map_err(|e| Error::new(format!("Failed to open SDB session {daemon_command:?}: {e}")))?;

    if res.header().command() != MessageCommand::Okay {
        return Err(Error::new(format!(
            "SDB rejected {daemon_command:?}: {:?}",
            res.header().command()
        )));
    }

    let mut output = Vec::new();
    loop {
        let response = device
            .inner_mut()
            .get_transport_mut()
            .read_message()
            .map_err(|e| Error::new(format!("Failed to read SDB response: {e}")))?;
        if response.header().command() == MessageCommand::Write {
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
                .map_err(|e| Error::new(format!("Failed to ack SDB response: {e}")))?;
            continue;
        }
        break;
    }

    Ok(String::from_utf8_lossy(&output).into_owned())
}

fn parse_tizen_app_list(output: &str) -> Vec<TizenAppInfo> {
    let mut apps = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // vd_applist format: "AppIndex:0 AppID:com.example RuntimeID:com.example Name:App ..."
        if line.contains("AppID:") {
            let mut id = String::new();
            let mut name = String::new();
            let mut runtime_id: Option<String> = None;
            for part in line.split_whitespace() {
                if let Some(v) = part.strip_prefix("AppID:") {
                    id = v.to_string();
                } else if let Some(v) = part.strip_prefix("Name:") {
                    name = v.to_string();
                } else if let Some(v) = part.strip_prefix("RuntimeID:") {
                    runtime_id = Some(v.to_string());
                }
            }
            if !id.is_empty() {
                let display = if name.is_empty() { id.clone() } else { name };
                apps.push(TizenAppInfo {
                    id: id.clone(),
                    name: display,
                    version_name: String::new(),
                    runtime_id,
                    tizen_id: None,
                });
            }
        // pipe-separated fallback: id|name|version
        } else if line.contains('|') {
            let parts: Vec<&str> = line.split('|').collect();
            if parts.len() >= 2 {
                apps.push(TizenAppInfo {
                    id: parts[0].trim().to_string(),
                    name: parts[1].trim().to_string(),
                    version_name: parts
                        .get(2)
                        .map(|v| v.trim().to_string())
                        .unwrap_or_default(),
                    runtime_id: None,
                    tizen_id: None,
                });
            }
        }
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

            // <widget id="...">  or  <manifest package="...">
            let re =
                regex::Regex::new(r#"(?:widget|manifest)[^>]+?(?:id|package)="([^"]+)""#)
                    .unwrap();
            if let Some(cap) = re.captures(&contents) {
                return Ok(cap[1].trim().to_string());
            }
        }
    }

    Err(Error::new(
        "Could not find app ID in WGT/TPK manifest (config.xml or tizen-manifest.xml)",
    ))
}

// ---------------------------------------------------------------------------
// Android TV commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn adb_list_devices<R: Runtime>(app: AppHandle<R>) -> Result<Vec<AdbDevice>, Error> {
    let out = run_adb(&app, &["devices"]).await?;
    let devices = out
        .lines()
        .skip(1)
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .filter_map(|l| {
            let mut parts = l.splitn(2, char::is_whitespace);
            let serial = parts.next()?.trim().to_string();
            let state = parts.next().unwrap_or("device").trim().to_string();
            if serial.is_empty() {
                None
            } else {
                Some(AdbDevice { serial, state })
            }
        })
        .collect();
    Ok(devices)
}

#[tauri::command]
async fn adb_connect<R: Runtime>(app: AppHandle<R>, host: String) -> Result<String, Error> {
    let target = if host.contains(':') {
        host.clone()
    } else {
        format!("{host}:5555")
    };

    let output = app
        .shell()
        .sidecar("adb")
        .map_err(|e| Error::new(format!("Failed to create ADB sidecar: {e}")))?
        .args(["connect", &target])
        .output()
        .await
        .map_err(|e| Error::new(format!("Failed to run ADB: {e}")))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let combined = [stdout.as_str(), stderr.as_str()]
        .iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");

    if !output.status.success()
        || regex::Regex::new(r"(?i)failed|error|unable|cannot|missing|refused|timed out")
            .unwrap()
            .is_match(&combined)
    {
        return Err(Error::new(if combined.is_empty() {
            format!("adb exited with code {:?}", output.status.code())
        } else {
            combined
        }));
    }

    Ok(if combined.is_empty() {
        format!("connected to {target}")
    } else {
        combined
    })
}

#[tauri::command]
async fn adb_disconnect<R: Runtime>(app: AppHandle<R>, serial: String) -> Result<(), Error> {
    run_adb(&app, &["disconnect", &serial]).await?;
    Ok(())
}

#[tauri::command]
async fn adb_list_packages<R: Runtime>(
    app: AppHandle<R>,
    serial: String,
) -> Result<Vec<AdbPackageInfo>, Error> {
    let list_out = run_adb(&app, &["-s", &serial, "shell", "pm", "list", "packages"]).await?;
    let ids: Vec<String> = list_out
        .lines()
        .filter_map(|l| l.strip_prefix("package:"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let whitelisted: Vec<(String, &'static str)> = ids
        .iter()
        .filter_map(|id| app_name(id).map(|name| (id.clone(), name)))
        .collect();

    let version_futures: Vec<_> = whitelisted
        .iter()
        .map(|(id, _)| {
            let app = app.clone();
            let serial = serial.clone();
            let id = id.clone();
            async move {
                run_adb(&app, &["-s", &serial, "shell", "pm", "dump", &id])
                    .await
                    .ok()
                    .and_then(|s| {
                        s.lines().find_map(|l| {
                            l.trim()
                                .strip_prefix("versionName=")
                                .map(|v| v.trim().to_string())
                        })
                    })
                    .unwrap_or_default()
            }
        })
        .collect();

    let versions: Vec<String> = join_all(version_futures).await;

    let mut results: Vec<AdbPackageInfo> = whitelisted
        .iter()
        .zip(versions.iter())
        .map(|((id, name), version)| AdbPackageInfo {
            id: id.clone(),
            name: name.to_string(),
            version_name: version.clone(),
        })
        .collect();

    results.sort_by_key(|r| sort_key(&r.name));
    Ok(results)
}

#[tauri::command]
async fn adb_get_prop<R: Runtime>(
    app: AppHandle<R>,
    serial: String,
    prop: String,
) -> Result<String, Error> {
    let out = run_adb(&app, &["-s", &serial, "shell", "getprop", &prop]).await?;
    Ok(out.trim().to_string())
}

#[tauri::command]
async fn adb_launch<R: Runtime>(
    app: AppHandle<R>,
    serial: String,
    package_id: String,
) -> Result<(), Error> {
    run_adb(
        &app,
        &[
            "-s",
            &serial,
            "shell",
            "am",
            "start",
            "-a",
            "android.intent.action.MAIN",
            "-p",
            &package_id,
        ],
    )
    .await?;
    Ok(())
}

#[tauri::command]
async fn adb_force_stop<R: Runtime>(
    app: AppHandle<R>,
    serial: String,
    package_id: String,
) -> Result<(), Error> {
    run_adb(
        &app,
        &["-s", &serial, "shell", "am", "force-stop", &package_id],
    )
    .await?;
    Ok(())
}

#[tauri::command]
async fn adb_uninstall<R: Runtime>(
    app: AppHandle<R>,
    serial: String,
    package_id: String,
) -> Result<(), Error> {
    run_adb(&app, &["-s", &serial, "uninstall", &package_id]).await?;
    Ok(())
}

#[tauri::command]
async fn adb_install<R: Runtime>(
    app: AppHandle<R>,
    serial: String,
    apk_path: String,
) -> Result<(), Error> {
    run_adb(&app, &["-s", &serial, "install", "-r", &apk_path]).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tizen commands (native protocol — no SDB binary required)
// ---------------------------------------------------------------------------

#[tauri::command]
async fn tizen_connect(serial: String) -> Result<String, Error> {
    tizen_tcp_device(&serial).map(|_| format!("Connected to {serial}"))
}

#[tauri::command]
async fn tizen_shell(serial: String, command: String) -> Result<String, Error> {
    tizen_run_shell(&serial, &command)
}

/// Returns a single property value.
/// Samsung Tizen does not have Android's `getprop` — instead we read
/// `/etc/info.ini` and extract the requested key from it.
/// Recognised keys: model, manufacturer, osVersion (and their aliases).
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
        // case-insensitive fallback
        let lower = line.to_lowercase();
        let key_lower = key.to_lowercase();
        if lower.starts_with(&format!("{key_lower}=")) {
            return Ok(line[key.len() + 1..].trim().to_owned());
        }
    }
    Ok(String::new())
}

/// Returns basic Samsung TV info by reading /etc/info.ini.
#[tauri::command]
async fn tizen_get_device_info(serial: String) -> Result<serde_json::Value, Error> {
    let ini = tizen_run_shell(&serial, "0 cat /etc/info.ini").unwrap_or_default();
    let mut model = String::new();
    let mut manufacturer = String::new();
    let mut os_version = String::new();
    for line in ini.lines() {
        let line = line.trim();
        let lower = line.to_lowercase();
        if lower.starts_with("model_name=") { model = line[11..].trim().to_owned(); }
        else if lower.starts_with("manufacturer=") { manufacturer = line[13..].trim().to_owned(); }
        else if lower.starts_with("sw_version=") { os_version = line[11..].trim().to_owned(); }
    }
    Ok(serde_json::json!({"model": model, "manufacturer": manufacturer, "osVersion": os_version}))
}

#[tauri::command]
async fn tizen_list_apps(serial: String) -> Result<Vec<TizenAppInfo>, Error> {
    for cmd in &["0 vd_applist", "0 applist", "0 pkgcmd -l", "0 /usr/bin/pkgcmd -l"] {
        if let Ok(out) = tizen_run_shell(&serial, cmd) {
            let apps = parse_tizen_app_list(&out);
            if !apps.is_empty() {
                return Ok(apps);
            }
        }
    }
    Ok(vec![])
}

#[tauri::command]
async fn tizen_install(serial: String, file_path: String) -> Result<String, Error> {
    let app_id = extract_tizen_app_id(&file_path)?;
    let file_name = std::path::Path::new(&file_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "app.wgt".to_string());
    let remote_path = format!("/opt/usr/apps/tmp/{file_name}");

    // Push and install on a single device connection to avoid race conditions
    let mut device = tizen_tcp_device(&serial)?;
    let file = std::fs::File::open(&file_path)
        .map_err(|e| Error::new(format!("Cannot read {file_path}: {e}")))?;
    device
        .push(&mut std::io::BufReader::new(file), &remote_path)
        .map_err(|e| Error::new(format!("Push to device failed: {e}")))?;

    let mut output = Vec::new();
    device
        .shell_command(&[&format!("0 vd_appinstall {app_id} {remote_path}")], &mut output)
        .map_err(|e| Error::new(format!("vd_appinstall failed: {e}")))?;
    Ok(String::from_utf8_lossy(&output).trim().to_owned())
}

#[tauri::command]
async fn tizen_uninstall(
    serial: String,
    app_id: String,
    runtime_id: Option<String>,
) -> Result<String, Error> {
    let rid = runtime_id.as_deref().unwrap_or(&app_id);
    if let Ok(out) = tizen_run_shell(&serial, &format!("0 vd_appuninstall {rid}")) {
        return Ok(out);
    }
    tizen_run_shell(&serial, &format!("0 pkgcmd -u -n {app_id}"))
}

#[tauri::command]
async fn tizen_launch(serial: String, app_id: String) -> Result<String, Error> {
    tizen_run_shell(&serial, &format!("0 was_execute {app_id}"))
        .or_else(|_| tizen_run_shell(&serial, &format!("0 execute {app_id}")))
}

#[tauri::command]
async fn tizen_kill(serial: String, app_id: String) -> Result<String, Error> {
    tizen_run_shell(&serial, &format!("0 execute 0 kill {app_id}"))
}

#[tauri::command]
async fn tizen_debug(serial: String, app_id: String) -> Result<u16, Error> {
    let out = tizen_run_shell(&serial, &format!("0 debug {app_id} 0"))?;
    regex::Regex::new(r"port:\s*(\d+)")
        .unwrap()
        .captures(&out)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse().ok())
        .ok_or_else(|| Error::new(format!("Could not parse debug port from: {out}")))
}

#[tauri::command]
async fn tizen_get_duid(serial: String) -> Result<String, Error> {
    if let Ok(out) = tizen_daemon_open(&serial, "duid: ") {
        let t = out.trim().to_owned();
        if !t.is_empty() {
            return Ok(t);
        }
    }
    for cmd in &["0 duid", "0 /usr/bin/duid", "0 getprop _duid"] {
        if let Ok(out) = tizen_run_shell(&serial, cmd) {
            if !out.is_empty() {
                return Ok(out);
            }
        }
    }
    Err(Error::new("Could not retrieve device DUID"))
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
    tizen_daemon_open(&serial, &command)
}

#[tauri::command]
async fn tizen_install_tizen_brew(serial: String, file_path: String) -> Result<String, Error> {
    // Push the package to a temp location then invoke TizenBrew installer
    let pkg_name = std::path::Path::new(&file_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "package.wgt".to_string());
    let remote_path = format!("/tmp/{pkg_name}");
    // Push file via SDB shell cat (pipe stdin approach via run_shell is limited;
    // use the ADB put path through shell redirect)
    let push_cmd = format!("0 /bin/cat > {remote_path}");
    // Fall back: use shell to run TizenBrew install command directly after push
    tizen_run_shell(&serial, &format!("0 tizenBrew install {remote_path}"))
        .or_else(|_| tizen_run_shell(&serial, &format!("0 vd_appinstall {remote_path}")))
        .map_err(|e| Error::new(format!("TizenBrew install failed: {e}\nMake sure TizenBrew is installed on the TV.")))
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

#[tauri::command]
async fn tizen_tizen_brew_device_details(serial: String) -> Result<TizenBrewDetails, Error> {
    let mut entries: Vec<TizenInfoEntry> = Vec::new();

    // Try to read device info from several candidate paths / commands.
    // All failures are silently swallowed — we always return Ok so the UI
    // can show whatever partial info it has instead of an error screen.
    let ini_candidates = [
        "0 cat /etc/info.ini",
        "0 cat /opt/etc/info.ini",
        "0 cat /usr/etc/info.ini",
        "0 cat /etc/version",
    ];
    for cmd in &ini_candidates {
        if let Ok(output) = tizen_run_shell(&serial, cmd) {
            let parsed = parse_ini_entries(&output);
            if !parsed.is_empty() {
                entries = parsed;
                break;
            }
        }
    }

    // If file reads all failed, try individual Samsung shell commands
    if entries.is_empty() {
        let cmds: &[(&str, &str)] = &[
            ("model",       "0 getDeviceProperty MODEL_NAME"),
            ("firmware",    "0 getDeviceProperty FIRMWARE_VERSION"),
            ("tizen",       "0 getDeviceProperty TIZEN_VERSION"),
            ("resolution",  "0 getDeviceProperty SCREEN_SIZE"),
        ];
        for (key, cmd) in cmds {
            if let Ok(val) = tizen_run_shell(&serial, cmd) {
                let val = val.trim().to_owned();
                if !val.is_empty() {
                    entries.push(TizenInfoEntry { key: key.to_string(), value: val });
                }
            }
        }
    }

    // Return whatever we found — never surface an error
    Ok(TizenBrewDetails { system_info: entries, daemon_error: String::new() })
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
            if k.is_empty() || v.is_empty() { None } else { Some(TizenInfoEntry { key: k, value: v }) }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

pub fn plugin<R: Runtime>(name: &'static str) -> TauriPlugin<R> {
    Builder::new(name)
        .invoke_handler(tauri::generate_handler![
            // Android TV
            adb_list_devices,
            adb_connect,
            adb_disconnect,
            adb_list_packages,
            adb_get_prop,
            adb_launch,
            adb_force_stop,
            adb_uninstall,
            adb_install,
            // Samsung Tizen (native — no SDB binary needed)
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
