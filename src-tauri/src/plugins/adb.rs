use futures::future::join_all;
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
// Tizen helpers — use the `sdb` binary (Samsung Debug Bridge), NOT adb_client
// ---------------------------------------------------------------------------

fn sdb_binary() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
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
    "sdb".to_string() // fallback: assume it's in PATH
}

fn sdb_serial(serial: &str) -> String {
    if serial.contains(':') {
        serial.to_string()
    } else {
        format!("{serial}:26101")
    }
}

/// Run `sdb -s <serial> shell <command>` and return stdout.
fn tizen_run_shell(serial: &str, command: &str) -> Result<String, Error> {
    let s = sdb_serial(serial);
    let out = std::process::Command::new(sdb_binary())
        .args(["-s", &s, "shell", command])
        .output()
        .map_err(|e| Error::new(format!("Failed to run sdb: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if stdout.trim().is_empty() && !stderr.trim().is_empty() {
        return Err(Error::new(stderr.trim().to_owned()));
    }
    Ok(stdout)
}

/// Run `sdb -s <serial> capability` and return stdout (device info).
fn tizen_capability(serial: &str) -> Result<String, Error> {
    let s = sdb_serial(serial);
    let out = std::process::Command::new(sdb_binary())
        .args(["-s", &s, "capability"])
        .output()
        .map_err(|e| Error::new(format!("Failed to run sdb capability: {e}")))?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Exact port of TizenBrew device manager Apps.jsx parsing logic.
///
/// Original JS (Apps.jsx):
///   const list = data.split('\n').slice(2).join('\n')
///       .split('------...------').filter(a => a != '');
///   list[i] = list[i].replace(/--------------/g,'').replace(/-------------/g,'')
///       .replace(/\s+=/g,'=').replace(/[\r]/g,'');
///   list.pop();
///   const appData = app.split('\n').map(a => a.split('='));
///   Fields: app_title, app_version, app_tizen_id, app_id, app_index
fn parse_tizen_app_list(output: &str) -> Vec<TizenAppInfo> {
    const SEPARATOR: &str = "---------------------------------------------------------------------------------------------";

    // Step 1: skip first 2 header lines, rejoin
    let body: String = output.lines().skip(2).collect::<Vec<_>>().join("\n");

    // Step 2: split on the exact separator used by Samsung
    let mut blocks: Vec<String> = body
        .split(SEPARATOR)
        .map(|s| {
            // Clean each block exactly like TizenBrew:
            // remove partial dash lines, normalize whitespace before '=', strip \r
            s.replace("--------------", "")
             .replace("-------------", "")
             .replace('\r', "")
        })
        .map(|s| {
            // Normalize "key   =value" → "key=value"
            s.lines()
             .map(|line| {
                 if let Some(eq) = line.find('=') {
                     let key = line[..eq].trim();
                     let val = line[eq + 1..].trim();
                     format!("{key}={val}")
                 } else {
                     line.to_owned()
                 }
             })
             .collect::<Vec<_>>()
             .join("\n")
        })
        .filter(|s| !s.trim().is_empty())
        .collect();

    // Step 3: pop trailing empty block (TizenBrew does list.pop())
    if blocks.last().map(|s| s.trim().is_empty()).unwrap_or(false) {
        blocks.pop();
    }

    // Step 4: parse each block as key=value pairs
    let mut apps = Vec::new();
    for block in &blocks {
        let mut kv: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
        for line in block.lines() {
            if let Some(eq) = line.find('=') {
                kv.insert(line[..eq].trim(), line[eq + 1..].trim());
            }
        }

        let app_id    = kv.get("app_id").copied().unwrap_or("").trim();
        let title     = kv.get("app_title").copied().unwrap_or("").trim();
        let version   = kv.get("app_version").copied().unwrap_or("").trim();
        let tizen_id  = kv.get("app_tizen_id").copied().unwrap_or("").trim();

        if app_id.is_empty() && title.is_empty() {
            continue;
        }

        let name = if title.is_empty() { app_id.to_owned() } else { title.to_owned() };

        apps.push(TizenAppInfo {
            id: app_id.to_owned(),
            name,
            version_name: version.to_owned(),
            runtime_id: None,
            tizen_id: if !tizen_id.is_empty() { Some(tizen_id.to_owned()) } else { None },
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
    let s = sdb_serial(&serial);
    let out = std::process::Command::new(sdb_binary())
        .args(["connect", &s])
        .output()
        .map_err(|e| Error::new(format!("Failed to run sdb connect: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_owned();
    let combined = if !stdout.is_empty() { stdout } else { stderr };
    Ok(if combined.is_empty() {
        format!("Connected to {serial}")
    } else {
        combined
    })
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

/// Returns basic Samsung TV info from sdb capability + /etc/info.ini.
#[tauri::command]
async fn tizen_get_device_info(serial: String) -> Result<serde_json::Value, Error> {
    // Get Tizen platform_version from sdb capability
    let capability = tizen_capability(&serial).unwrap_or_default();
    let mut tizen_version = String::new();
    for line in capability.lines() {
        if let Some(v) = line.strip_prefix("platform_version:") {
            tizen_version = v.trim().to_owned();
            break;
        }
    }

    // Get model / manufacturer / firmware from /etc/info.ini
    let ini = tizen_run_shell(&serial, "0 cat /etc/info.ini").unwrap_or_default();
    let mut model = String::new();
    let mut manufacturer = String::new();
    let mut fw_version = String::new();
    for line in ini.lines() {
        let line = line.trim();
        let lower = line.to_lowercase();
        if lower.starts_with("model_name=") {
            model = line[11..].trim().to_owned();
        } else if lower.starts_with("manufacturer=") {
            manufacturer = line[13..].trim().to_owned();
        } else if lower.starts_with("sw_version=") {
            fw_version = line[11..].trim().to_owned();
        }
    }

    if manufacturer.is_empty() {
        manufacturer = "Samsung".to_owned();
    }
    let os_version = if !tizen_version.is_empty() { tizen_version } else { fw_version };

    Ok(serde_json::json!({
        "model": model,
        "manufacturer": manufacturer,
        "osVersion": os_version
    }))
}

#[tauri::command]
async fn tizen_list_apps(serial: String) -> Result<Vec<TizenAppInfo>, Error> {
    // Try primary command — propagate the raw output/error so UI can debug
    let out = tizen_run_shell(&serial, "0 vd_applist")?;
    let apps = parse_tizen_app_list(&out);
    if !apps.is_empty() {
        return Ok(apps);
    }
    // Return the raw output as an error so the user can see what the TV sent
    Err(Error::new(format!(
        "vd_applist returned no parseable apps.\nRaw output ({} bytes):\n{}",
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

    // Push the WGT via sdb push
    let s = sdb_serial(&serial);
    let push_out = std::process::Command::new(sdb_binary())
        .args(["-s", &s, "push", &file_path, &remote_path])
        .output()
        .map_err(|e| Error::new(format!("sdb push failed: {e}")))?;
    if !push_out.status.success() {
        let stderr = String::from_utf8_lossy(&push_out.stderr);
        return Err(Error::new(format!("sdb push failed: {stderr}")));
    }

    // Install via vd_appinstall
    tizen_run_shell(&serial, &format!("0 vd_appinstall {app_id} {remote_path}"))
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
    for cmd in &["0 duid", "0 /usr/bin/duid", "0 getprop _duid"] {
        if let Ok(out) = tizen_run_shell(&serial, cmd) {
            let t = out.trim().to_owned();
            if !t.is_empty() {
                return Ok(t);
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
    // Map a daemon-style command (e.g. "sysinfo: ") to a shell command
    let shell_cmd = format!(
        "0 {}",
        command.trim_end_matches(": ").trim_end_matches(':').trim()
    );
    tizen_run_shell(&serial, &shell_cmd)
}

#[tauri::command]
async fn tizen_install_tizen_brew(serial: String, file_path: String) -> Result<String, Error> {
    let pkg_name = std::path::Path::new(&file_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "package.wgt".to_string());
    let remote_path = format!("/tmp/{pkg_name}");

    // Push the file to the TV via sdb push
    let s = sdb_serial(&serial);
    let push_out = std::process::Command::new(sdb_binary())
        .args(["-s", &s, "push", &file_path, &remote_path])
        .output()
        .map_err(|e| Error::new(format!("sdb push failed: {e}")))?;
    if !push_out.status.success() {
        let stderr = String::from_utf8_lossy(&push_out.stderr);
        return Err(Error::new(format!("sdb push failed: {stderr}")));
    }

    // Try TizenBrew-style install, fall back to vd_appinstall
    let app_id = extract_tizen_app_id(&file_path).ok();
    let install_cmd = if let Some(ref id) = app_id {
        format!("0 vd_appinstall {id} {remote_path}")
    } else {
        format!("0 vd_appinstall {remote_path}")
    };

    tizen_run_shell(&serial, &install_cmd)
        .map_err(|e| Error::new(format!(
            "Install failed: {e}\nMake sure TizenBrew is installed on the TV."
        )))
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
    let mut daemon_error = String::new();

    // Primary: /etc/info.ini (model name, manufacturer, firmware)
    match tizen_run_shell(&serial, "0 cat /etc/info.ini") {
        Ok(ini) => {
            let ini_entries = parse_ini_entries(&ini);
            if ini_entries.is_empty() {
                daemon_error = format!(
                    "info.ini returned no entries. Raw ({} bytes): {:?}",
                    ini.len(),
                    &ini[..ini.len().min(300)]
                );
            } else {
                entries.extend(ini_entries);
            }
        }
        Err(e) => {
            daemon_error = format!("sdb shell 0 cat /etc/info.ini failed: {e}");
        }
    }

    // Secondary: sdb capability (platform_version = Tizen version, cpu_arch, etc.)
    match tizen_capability(&serial) {
        Ok(cap) => {
            for line in cap.lines() {
                if let Some(colon) = line.find(':') {
                    let raw_key = line[..colon].trim();
                    let value   = line[colon + 1..].trim().to_owned();
                    if raw_key.is_empty() || value.is_empty() {
                        continue;
                    }
                    let key = match raw_key {
                        "platform_version" => "TIZEN_VERSION".to_owned(),
                        "cpu_arch"         => "CPU_ARCH".to_owned(),
                        "profile_name"     => "PROFILE".to_owned(),
                        "sdk_version"      => "SDK_VERSION".to_owned(),
                        other              => other.replace('_', " ").to_uppercase(),
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

    Ok(TizenBrewDetails { system_info: entries, daemon_error })
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
