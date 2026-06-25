// Minimal SDB/ADB wire protocol implementation.
// Samsung SDB (port 26101) uses the same protocol as ADB but without RSA auth.
// We implement just enough to open a shell service and read the response.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

use crate::error::Error;

// ── Data types ───────────────────────────────────────────────────────────────

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


// ── Signed install helpers ───────────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub step: String,
    pub message: String,
    pub percent: u8,
}

/// Re-packs a double-packaged WGT by extracting only `.buildResult/` content to root.
/// Returns (path_to_use, was_repacked). Caller must delete the temp file when done.
fn repack_wgt(file_path: &str) -> Result<(std::path::PathBuf, bool), Error> {
    use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions, CompressionMethod};

    let file = std::fs::File::open(file_path)
        .map_err(|e| Error::new(format!("Cannot open {file_path}: {e}")))?;
    let mut probe = ZipArchive::new(file)
        .map_err(|e| Error::new(format!("Not a valid ZIP/WGT: {e}")))?;

    let names: Vec<String> = (0..probe.len())
        .filter_map(|i| probe.by_index(i).ok().map(|e| e.name().to_owned()))
        .collect();

    let has_buildresult = names.iter().any(|n| n == ".buildResult/config.xml");
    let has_root_dupe   = names.iter().any(|n| n == "config.xml");

    if !has_buildresult || !has_root_dupe {
        return Ok((std::path::PathBuf::from(file_path), false));
    }

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    let temp_path = std::env::temp_dir().join(format!("wgt-repack-{ts}.wgt"));

    let out_file = std::fs::File::create(&temp_path)
        .map_err(|e| Error::new(format!("Cannot create temp file: {e}")))?;
    let mut writer = ZipWriter::new(out_file);
    let opts = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated);

    let src_file = std::fs::File::open(file_path)
        .map_err(|e| Error::new(format!("Cannot re-open source: {e}")))?;
    let mut src = ZipArchive::new(src_file)
        .map_err(|e| Error::new(format!("Cannot re-read ZIP: {e}")))?;

    for i in 0..src.len() {
        let mut entry = src.by_index(i)
            .map_err(|e| Error::new(format!("ZIP entry {i}: {e}")))?;
        let raw = entry.name().replace('\\', "/");
        let Some(stripped) = raw.strip_prefix(".buildResult/") else { continue };
        if stripped.is_empty() { continue }
        if stripped == "author-signature.xml" || stripped == "signature1.xml" { continue }
        if raw.ends_with('/') {
            writer.add_directory(stripped, opts)
                .map_err(|e| Error::new(format!("Cannot add dir {stripped}: {e}")))?;
        } else {
            writer.start_file(stripped, opts)
                .map_err(|e| Error::new(format!("Cannot start file {stripped}: {e}")))?;
            std::io::copy(&mut entry, &mut writer)
                .map_err(|e| Error::new(format!("Cannot copy {stripped}: {e}")))?;
        }
    }

    writer.finish()
        .map_err(|e| Error::new(format!("Cannot finish ZIP: {e}")))?;

    Ok((temp_path, true))
}

/// Signs a WGT in-place using the Tizen CLI `package` command.
fn sign_wgt(file_path: &str, profile: &str, tizen_studio_path: &str) -> Result<(), Error> {
    #[cfg(target_os = "windows")]
    let tizen_bin = format!(r"{tizen_studio_path}\tools\ide\bin\tizen.bat");
    #[cfg(not(target_os = "windows"))]
    let tizen_bin = format!("{tizen_studio_path}/tools/ide/bin/tizen");

    if !std::path::Path::new(&tizen_bin).exists() {
        return Err(Error::new(format!(
            "Tizen Studio CLI not found at {tizen_bin}. Check your certificate configuration."
        )));
    }

    let out = Command::new(&tizen_bin)
        .args(["package", "-t", "wgt", "-s", profile, "--", file_path])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| Error::new(format!("Failed to run tizen package: {e}")))?;

    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();

    if !out.status.success() || !stdout.contains("is created successfully") {
        return Err(Error::new(format!(
            "Signing failed (profile: {profile}):\n{stdout}\n{stderr}"
        )));
    }
    Ok(())
}

/// Installs a signed WGT using the Tizen CLI.
/// Connects SDB, installs, then disconnects — clean state every time.
fn cli_install(serial: &str, file_path: &str, tizen_studio_path: &str) -> Result<String, Error> {
    #[cfg(target_os = "windows")]
    let sdb_bin   = format!(r"{tizen_studio_path}\tools\sdb.exe");
    #[cfg(target_os = "windows")]
    let tizen_bin = format!(r"{tizen_studio_path}\tools\ide\bin\tizen.bat");
    #[cfg(not(target_os = "windows"))]
    let sdb_bin   = format!("{tizen_studio_path}/tools/sdb");
    #[cfg(not(target_os = "windows"))]
    let tizen_bin = format!("{tizen_studio_path}/tools/ide/bin/tizen");

    if !std::path::Path::new(&tizen_bin).exists() {
        return Err(Error::new(format!("Tizen CLI not found at {tizen_bin}")));
    }

    // 1. Kill SDB server to drop any existing TizenBrew reverse connection
    //    that would block a fresh sdb connect on port 26101
    let _ = Command::new(&sdb_bin).args(["kill-server"]).output();
    std::thread::sleep(Duration::from_millis(800));

    // 2. Connect fresh
    let conn = Command::new(&sdb_bin)
        .args(["connect", serial])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| Error::new(format!("sdb connect failed: {e}")))?;
    let conn_out = String::from_utf8_lossy(&conn.stdout).into_owned();
    if !conn_out.contains("connected") {
        return Err(Error::new(format!("Could not connect to {serial}: {conn_out}")));
    }

    // 3. Install
    let result = Command::new(&tizen_bin)
        .args(["install", "-n", file_path, "-s", serial])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();

    // 4. Disconnect regardless of install outcome
    let _ = Command::new(&sdb_bin).args(["disconnect", serial]).output();

    let out = result.map_err(|e| Error::new(format!("tizen install failed: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    let combined = format!("{stdout}{stderr}");

    if combined.contains("install completed") || combined.contains("successfully installed") {
        Ok(combined)
    } else {
        Err(Error::new(combined))
    }
}

// ── Certificate profile detection ────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TizenCertProfile {
    pub name: String,
    pub active: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TizenStudioInfo {
    pub path: String,
    pub version: String,
    pub profiles: Vec<TizenCertProfile>,
}

fn parse_cert_profiles(xml_path: &str) -> Vec<TizenCertProfile> {
    let Ok(content) = std::fs::read_to_string(xml_path) else { return vec![] };
    let active = regex::Regex::new(r#"<profiles[^>]+active="([^"]+)""#)
        .unwrap()
        .captures(&content)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_owned())
        .unwrap_or_default();
    regex::Regex::new(r#"<profile\s+name="([^"]+)""#)
        .unwrap()
        .captures_iter(&content)
        .map(|c| {
            let name = c[1].to_owned();
            let is_active = name == active;
            TizenCertProfile { active: is_active, name }
        })
        .collect()
}

fn sdb_serial(serial: &str) -> String {
    if serial.contains(':') {
        serial.to_string()
    } else {
        format!("{serial}:26101")
    }
}

// ── ADB/SDB message constants ────────────────────────────────────────────────
const CMD_CNXN: u32 = 0x4e584e43;
const CMD_OPEN: u32 = 0x4e45504f;
const CMD_OKAY: u32 = 0x59414b4f;
const CMD_WRTE: u32 = 0x45545257;
const CMD_CLSE: u32 = 0x45534c43;
const ADB_VERSION: u32 = 0x01000000;
const MAX_PAYLOAD: u32 = 4096;

fn adb_crc32(data: &[u8]) -> u32 {
    data.iter().fold(0u32, |acc, &b| acc.wrapping_add(b as u32))
}

fn adb_write_msg(stream: &mut TcpStream, cmd: u32, arg0: u32, arg1: u32, data: &[u8]) -> std::io::Result<()> {
    let len = data.len() as u32;
    let crc = adb_crc32(data);
    let magic = cmd ^ 0xFFFFFFFF;
    let mut header = [0u8; 24];
    header[0..4].copy_from_slice(&cmd.to_le_bytes());
    header[4..8].copy_from_slice(&arg0.to_le_bytes());
    header[8..12].copy_from_slice(&arg1.to_le_bytes());
    header[12..16].copy_from_slice(&len.to_le_bytes());
    header[16..20].copy_from_slice(&crc.to_le_bytes());
    header[20..24].copy_from_slice(&magic.to_le_bytes());
    stream.write_all(&header)?;
    if !data.is_empty() {
        stream.write_all(data)?;
    }
    Ok(())
}

fn adb_read_msg(stream: &mut TcpStream) -> std::io::Result<(u32, u32, u32, Vec<u8>)> {
    let mut header = [0u8; 24];
    stream.read_exact(&mut header)?;
    let cmd  = u32::from_le_bytes(header[0..4].try_into().unwrap());
    let arg0 = u32::from_le_bytes(header[4..8].try_into().unwrap());
    let arg1 = u32::from_le_bytes(header[8..12].try_into().unwrap());
    let len  = u32::from_le_bytes(header[12..16].try_into().unwrap());
    let mut payload = vec![0u8; len as usize];
    if len > 0 {
        stream.read_exact(&mut payload)?;
    }
    Ok((cmd, arg0, arg1, payload))
}

/// Open a fresh TCP connection to the TV and perform the ADB CNXN handshake.
fn sdb_connect(addr: &str) -> Result<TcpStream, Error> {
    let addr: SocketAddr = addr.parse()
        .map_err(|e| Error::new(format!("Invalid Samsung TV address: {e}")))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5))
        .map_err(|e| Error::new(format!("Cannot connect to Samsung TV {addr}: {e}")))?;
    stream.set_read_timeout(Some(Duration::from_secs(15))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(10))).ok();

    // Send CNXN
    let banner = b"host::Samsung\0";
    adb_write_msg(&mut stream, CMD_CNXN, ADB_VERSION, MAX_PAYLOAD, banner)
        .map_err(|e| Error::new(format!("Failed to send CNXN: {e}")))?;

    // Expect CNXN back
    let (cmd, _, _, _) = adb_read_msg(&mut stream)
        .map_err(|e| Error::new(format!("Failed to read CNXN response: {e}")))?;
    if cmd != CMD_CNXN {
        return Err(Error::new(format!("Expected CNXN, got 0x{cmd:08X}")));
    }

    Ok(stream)
}

/// Run a shell command on the TV and return all output.
/// Keeps the connection alive for the lifetime of the call.
fn tizen_run_shell(serial: &str, command: &str) -> Result<String, Error> {
    let addr = sdb_serial(serial);
    let mut stream = sdb_connect(&addr)?;

    let service = format!("shell:{command}\0");
    let local_id: u32 = 1;

    adb_write_msg(&mut stream, CMD_OPEN, local_id, 0, service.as_bytes())
        .map_err(|e| Error::new(format!("OPEN failed: {e}")))?;

    // Wait for OKAY (stream accepted)
    let (cmd, remote_id, _, _) = adb_read_msg(&mut stream)
        .map_err(|e| Error::new(format!("Failed to read OPEN response: {e}")))?;
    if cmd != CMD_OKAY {
        return Err(Error::new(format!("Shell open rejected (got 0x{cmd:08X})")));
    }

    // Read WRTE packets until CLSE
    let mut output = Vec::new();
    loop {
        let (cmd, _, _, payload) = adb_read_msg(&mut stream)
            .map_err(|e| Error::new(format!("Failed to read shell data: {e}")))?;
        match cmd {
            CMD_WRTE => {
                output.extend_from_slice(&payload);
                // Acknowledge each WRTE
                adb_write_msg(&mut stream, CMD_OKAY, local_id, remote_id, &[])
                    .map_err(|e| Error::new(format!("OKAY ack failed: {e}")))?;
            }
            CMD_CLSE | _ => break,
        }
    }

    Ok(String::from_utf8_lossy(&output).into_owned())
}

fn tizen_run_daemon_command(serial: &str, command: &str) -> Result<String, Error> {
    tizen_run_shell(serial, command)
}

/// Push a local file to the TV using ADB sync protocol over the SDB connection.
/// The sync byte-stream is fragmented into ≤4096 byte WRTE packets as required by the protocol.
fn tizen_push_file(serial: &str, local_path: &str, remote_path: &str) -> Result<(), Error> {
    use std::io::Read as _;
    const FRAG: usize = MAX_PAYLOAD as usize; // 4096 — max WRTE payload
    const DATA_CHUNK: usize = 32768;           // sync DATA payload size

    let addr = sdb_serial(serial);
    let mut stream = sdb_connect(&addr)?;

    // Open sync: service
    adb_write_msg(&mut stream, CMD_OPEN, 1, 0, b"sync:\0")
        .map_err(|e| Error::new(format!("sync OPEN failed: {e}")))?;
    let (cmd, remote_id, _, _) = adb_read_msg(&mut stream)
        .map_err(|e| Error::new(format!("sync OPEN response: {e}")))?;
    if cmd != CMD_OKAY {
        return Err(Error::new("sync service rejected".to_owned()));
    }

    /// Send raw bytes as WRTE packets, fragmenting to FRAG-sized pieces.
    /// Reads one OKAY ack per WRTE sent.
    fn send_bytes(stream: &mut TcpStream, local_id: u32, remote_id: u32, data: &[u8]) -> std::io::Result<()> {
        let mut offset = 0;
        while offset < data.len() {
            let end = (offset + FRAG).min(data.len());
            adb_write_msg(stream, CMD_WRTE, local_id, remote_id, &data[offset..end])?;
            let _ = adb_read_msg(stream); // consume OKAY ack
            offset = end;
        }
        Ok(())
    }

    // SEND,<remote_path>,<mode>
    let send_arg = format!("{remote_path},33188"); // 33188 = 0o100644
    let mut send_hdr = Vec::with_capacity(8 + send_arg.len());
    send_hdr.extend_from_slice(b"SEND");
    send_hdr.extend_from_slice(&(send_arg.len() as u32).to_le_bytes());
    send_hdr.extend_from_slice(send_arg.as_bytes());
    send_bytes(&mut stream, 1, remote_id, &send_hdr)
        .map_err(|e| Error::new(format!("sync SEND failed: {e}")))?;

    // Stream file in DATA chunks
    let mut file = std::fs::File::open(local_path)
        .map_err(|e| Error::new(format!("Cannot open {local_path}: {e}")))?;
    let mut raw = vec![0u8; DATA_CHUNK];
    loop {
        let n = file.read(&mut raw)
            .map_err(|e| Error::new(format!("File read error: {e}")))?;
        if n == 0 { break; }
        let mut data_pkt = Vec::with_capacity(8 + n);
        data_pkt.extend_from_slice(b"DATA");
        data_pkt.extend_from_slice(&(n as u32).to_le_bytes());
        data_pkt.extend_from_slice(&raw[..n]);
        send_bytes(&mut stream, 1, remote_id, &data_pkt)
            .map_err(|e| Error::new(format!("DATA send failed: {e}")))?;
    }

    // DONE + timestamp
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as u32;
    let mut done_pkt = [0u8; 8];
    done_pkt[0..4].copy_from_slice(b"DONE");
    done_pkt[4..8].copy_from_slice(&ts.to_le_bytes());
    send_bytes(&mut stream, 1, remote_id, &done_pkt)
        .map_err(|e| Error::new(format!("sync DONE failed: {e}")))?;

    // Read final OKAY/FAIL from the TV
    let _ = adb_read_msg(&mut stream);
    Ok(())
}

/// Run a shell command with a timeout — used for debug port detection.
fn tizen_run_shell_for(serial: &str, command: &str, timeout: Duration) -> Result<String, Error> {
    let addr = sdb_serial(serial);
    let mut stream = sdb_connect(&addr)?;
    stream.set_read_timeout(Some(timeout)).ok();

    let service = format!("shell:{command}\0");
    let local_id: u32 = 1;
    adb_write_msg(&mut stream, CMD_OPEN, local_id, 0, service.as_bytes())
        .map_err(|e| Error::new(format!("OPEN failed: {e}")))?;

    let (cmd, remote_id, _, _) = adb_read_msg(&mut stream)
        .map_err(|e| Error::new(format!("Failed to read OPEN response: {e}")))?;
    if cmd != CMD_OKAY {
        return Err(Error::new(format!("Shell open rejected (got 0x{cmd:08X})")));
    }

    let mut output = Vec::new();
    let deadline = Instant::now() + timeout;
    loop {
        if Instant::now() >= deadline { break; }
        match adb_read_msg(&mut stream) {
            Ok((CMD_WRTE, _, _, payload)) => {
                output.extend_from_slice(&payload);
                let _ = adb_write_msg(&mut stream, CMD_OKAY, local_id, remote_id, &[]);
            }
            Ok((CMD_CLSE, _, _, _)) | Err(_) => break,
            Ok(_) => {}
        }
    }

    Ok(String::from_utf8_lossy(&output).into_owned())
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


#[tauri::command]
pub(crate) async fn tizen_connect(serial: String) -> Result<String, Error> {
    let addr = sdb_serial(&serial);
    // Test connection by performing the CNXN handshake
    sdb_connect(&addr)?;
    Ok(format!("Connected to {addr}"))
}

#[tauri::command]
pub(crate) async fn tizen_shell(serial: String, command: String) -> Result<String, Error> {
    tizen_run_shell(&serial, &command)
}

#[tauri::command]
pub(crate) async fn tizen_get_prop(serial: String, prop: String) -> Result<String, Error> {
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
pub(crate) async fn tizen_get_device_info(serial: String) -> Result<serde_json::Value, Error> {
    let ini = tizen_run_shell(&serial, "0 cat /etc/info.ini").unwrap_or_default();
    let mut model = String::new();
    let mut manufacturer = String::new();
    let mut fw_version = String::new();
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
    let os_version = fw_version;

    Ok(serde_json::json!({
        "model": model,
        "manufacturer": manufacturer,
        "osVersion": os_version
    }))
}

#[tauri::command]
pub(crate) async fn tizen_list_apps(serial: String) -> Result<Vec<TizenAppInfo>, Error> {
    let out = tizen_run_shell(&serial, "0 vd_applist")?;
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
pub(crate) async fn tizen_install(serial: String, file_path: String) -> Result<String, Error> {
    let lower = file_path.to_lowercase();
    let is_tpk = lower.ends_with(".tpk");
    let is_tmg = lower.ends_with(".tmg");

    let file_name = std::path::Path::new(&file_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "app.wgt".to_string());

    // All packages land in the same temp dir so widget.license is a sibling
    let remote_dir  = "/opt/usr/apps/tmp";
    let remote_path = format!("{remote_dir}/{file_name}");

    tizen_push_file(&serial, &file_path, &remote_path)?;

    if is_tmg {
        // Push widget.license from the same local directory if it exists
        let local_dir   = std::path::Path::new(&file_path).parent().unwrap_or(std::path::Path::new("."));
        let license_path = local_dir.join("widget.license");
        if license_path.exists() {
            let remote_license = format!("{remote_dir}/widget.license");
            tizen_push_file(&serial, license_path.to_string_lossy().as_ref(), &remote_license)?;
        }
        let app_id = extract_tizen_app_id(&file_path)
            .unwrap_or_else(|_| file_name.trim_end_matches(".tmg").to_owned());
        tizen_run_shell(&serial, &format!("0 vd_appinstall {app_id} {remote_path}"))
    } else if is_tpk {
        tizen_run_shell(&serial, &format!("0 pkgcmd -i -t tpk -p {remote_path}"))
    } else {
        // .wgt — standard web app
        let app_id = extract_tizen_app_id(&file_path)?;
        tizen_run_shell(&serial, &format!("0 vd_appinstall {app_id} {remote_path}"))
    }
}

#[tauri::command]
pub(crate) async fn tizen_uninstall(
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
        let cmd_str = command.join(" ");
        let serial2 = serial.clone();
        let task = tokio::task::spawn_blocking(move || tizen_run_shell(&serial2, &cmd_str));
        match tokio::time::timeout(Duration::from_secs(20), task).await {
            Ok(Ok(Ok(out))) => return Ok(out),
            Ok(Ok(Err(e))) => errors.push(e.to_string()),
            Ok(Err(e)) => errors.push(format!("task failed: {e}")),
            Err(_) => errors.push("timed out".to_owned()),
        }
    }

    Err(Error::new(format!(
        "Failed to uninstall {app_id}.\n{}",
        errors.join("\n")
    )))
}

#[tauri::command]
pub(crate) async fn tizen_launch(serial: String, app_id: String) -> Result<String, Error> {
    tizen_run_shell(&serial, &format!("0 execute {app_id}"))
        .or_else(|_| tizen_run_shell(&serial, &format!("0 was_execute {app_id}")))
}

#[tauri::command]
pub(crate) async fn tizen_kill(serial: String, app_id: String) -> Result<String, Error> {
    for cmd in [
        format!("0 was_kill {app_id}"),
        format!("0 execute 0 kill {app_id}"),
    ] {
        // tizen_run_shell opens a fresh TCP connection per call.
        // Killing an app sends CLSE which breaks the read loop and returns Ok.
        if let Ok(out) = tizen_run_shell(&serial, &cmd) {
            return Ok(out);
        }
    }
    Err(Error::new(format!("Failed to kill {app_id}")))
}

#[tauri::command]
pub(crate) async fn tizen_debug(
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
        let cmd_str = command.join(" ");
        let serial2 = serial.clone();
        let cmd_str2 = cmd_str.clone();
        let task = tokio::task::spawn_blocking(move || {
            tizen_run_shell_for(&serial2, &cmd_str2, Duration::from_secs(6))
        });
        match tokio::time::timeout(Duration::from_secs(8), task).await {
            Ok(Ok(Ok(output))) => {
                out = output;
                if !out.trim().is_empty() {
                    break;
                }
                errors.push(format!("{cmd_str}: no output"));
            }
            Ok(Ok(Err(e))) => errors.push(format!("{cmd_str}: {e}")),
            Ok(Err(e)) => errors.push(format!("{cmd_str}: task failed: {e}")),
            Err(_) => errors.push(format!("{cmd_str}: timed out")),
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
pub(crate) async fn tizen_get_duid(serial: String) -> Result<String, Error> {
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
pub(crate) async fn tizen_get_app_version(serial: String, app_id: String) -> Result<String, Error> {
    let out = tizen_run_shell(&serial, &format!("0 pkginfo --pkg {app_id}"))?;
    regex::Regex::new(r"(?mi)^Version:\s*(.+)")
        .unwrap()
        .captures(&out)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_owned())
        .ok_or_else(|| Error::new(format!("Could not parse version from: {out}")))
}

#[tauri::command]
pub(crate) async fn tizen_daemon_command(serial: String, command: String) -> Result<String, Error> {
    tizen_run_daemon_command(&serial, &command)
}


#[tauri::command]
pub(crate) async fn tizen_install_signed(
    serial: String,
    file_path: String,
    cert_profile: String,
    tizen_studio_path: String,
    on_progress: tauri::ipc::Channel<InstallProgress>,
) -> Result<String, Error> {
    macro_rules! emit {
        ($step:expr, $msg:expr, $pct:expr) => {
            let _ = on_progress.send(InstallProgress {
                step: $step.to_owned(),
                message: $msg.to_owned(),
                percent: $pct,
            });
        };
    }

    #[cfg(target_os = "windows")]
    let sdb_bin   = format!(r"{tizen_studio_path}\tools\sdb.exe");
    #[cfg(target_os = "windows")]
    let tizen_bin = format!(r"{tizen_studio_path}\tools\ide\bin\tizen.bat");
    #[cfg(not(target_os = "windows"))]
    let sdb_bin   = format!("{tizen_studio_path}/tools/sdb");
    #[cfg(not(target_os = "windows"))]
    let tizen_bin = format!("{tizen_studio_path}/tools/ide/bin/tizen");

    if !std::path::Path::new(&tizen_bin).exists() {
        return Err(Error::new(format!("Tizen CLI not found at {tizen_bin}")));
    }

    // Step 1 — Graceful disconnect so the TV's SDB daemon cleans up immediately,
    //           then kill the local server to drop any lingering TizenBrew tunnel.
    emit!("disconnecting", "Disconnecting from TizenBrew…", 5);
    let sdb1 = sdb_bin.clone();
    let ser1 = serial.clone();
    let _ = tokio::task::spawn_blocking(move || {
        // Graceful disconnect tells the TV daemon to release the session now.
        let _ = Command::new(&sdb1).args(["disconnect", &ser1]).output();
        // Kill local server so it starts fresh on the next connect call.
        let _ = Command::new(&sdb1).args(["kill-server"]).output();
    }).await;

    // Step 2 — Short wait for the TV daemon to finish cleanup
    emit!("waiting", "Waiting for port to release…", 15);
    tokio::time::sleep(Duration::from_millis(1000)).await;

    // Step 3 — Connect fresh via SDB (retry up to 4 times, 1.5 s apart)
    emit!("connecting", "Connecting with SDB…", 25);
    const MAX_ATTEMPTS: u8 = 4;
    let mut last_err = String::new();
    let mut connected = false;
    for attempt in 1..=MAX_ATTEMPTS {
        if attempt > 1 {
            let msg = format!("Connecting with SDB… (attempt {attempt}/{MAX_ATTEMPTS})");
            emit!("connecting", &msg, 25);
            tokio::time::sleep(Duration::from_millis(1500)).await;
        }
        let sdb_c = sdb_bin.clone();
        let ser_c = serial.clone();
        let out = tokio::task::spawn_blocking(move || {
            Command::new(&sdb_c)
                .args(["connect", &ser_c])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
        }).await.map_err(|e| Error::new(format!("sdb connect task: {e}")))?
          .map_err(|e| Error::new(format!("sdb connect failed: {e}")))?;

        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        let combined = format!("{stdout}{stderr}");
        if combined.contains("connected") {
            connected = true;
            break;
        }
        last_err = combined;
    }
    if !connected {
        return Err(Error::new(format!("Could not connect to {serial}: {last_err}")));
    }
    emit!("connected", "Connection established", 35);

    // Step 4 — Repack + Sign (building)
    emit!("building", "Checking package structure…", 42);
    let (work_path, was_repacked) = tokio::task::spawn_blocking({
        let fp = file_path.clone();
        move || repack_wgt(&fp)
    }).await.map_err(|e| Error::new(format!("repack task: {e}")))??;

    let work_str = work_path.to_string_lossy().into_owned();
    emit!("building", "Signing package…", 55);

    let sign_result = tokio::task::spawn_blocking({
        let wp = work_str.clone();
        let profile = cert_profile.clone();
        let studio = tizen_studio_path.clone();
        move || sign_wgt(&wp, &profile, &studio)
    }).await.map_err(|e| Error::new(format!("sign task: {e}")));

    let sign_ok = match sign_result {
        Err(ref e) => {
            if was_repacked { let _ = std::fs::remove_file(&work_path); }
            return Err(Error::new(e.to_string()));
        }
        Ok(Err(ref e)) => {
            if was_repacked { let _ = std::fs::remove_file(&work_path); }
            return Err(Error::new(e.to_string()));
        }
        Ok(Ok(v)) => v,
    };
    drop(sign_ok);

    // Step 5 — Install via tizen CLI
    emit!("installing", "Installing on device…", 68);
    let sdb_disc = sdb_bin.clone();
    let serial_d = serial.clone();
    let install_result = tokio::task::spawn_blocking({
        let tb = tizen_bin.clone();
        let wp = work_str.clone();
        let s  = serial.clone();
        move || {
            let out = Command::new(&tb)
                .args(["install", "-n", &wp, "-s", &s])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output();
            // Disconnect regardless of outcome
            let _ = Command::new(&sdb_disc).args(["disconnect", &serial_d]).output();
            out
        }
    }).await.map_err(|e| Error::new(format!("install task: {e}")));

    if was_repacked {
        let _ = std::fs::remove_file(&work_path);
    }

    let raw = install_result?
        .map_err(|e| Error::new(format!("tizen install failed: {e}")))?;
    let stdout = String::from_utf8_lossy(&raw.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&raw.stderr).into_owned();
    let combined = format!("{stdout}{stderr}");

    if combined.contains("install completed") || combined.contains("successfully installed") {
        emit!("done", "Installation complete", 100);
        Ok(combined)
    } else {
        Err(Error::new(combined))
    }
}

#[tauri::command]
pub(crate) async fn tizen_detect_studio(home_dir: String) -> Result<TizenStudioInfo, Error> {
    let home = if home_dir.is_empty() {
        std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default()
    } else {
        home_dir.clone()
    };

    let candidates = vec![
        format!("{home}/tizen-studio"),
        format!("{home}/.local/share/tizen-studio"),
        "/opt/tizen-studio".to_owned(),
    ];

    for path in &candidates {
        #[cfg(target_os = "windows")]
        let tizen_bin = format!(r"{path}\tools\ide\bin\tizen.bat");
        #[cfg(not(target_os = "windows"))]
        let tizen_bin = format!("{path}/tools/ide/bin/tizen");

        if !std::path::Path::new(&tizen_bin).exists() {
            continue;
        }

        let version = std::fs::read_to_string(format!("{path}/sdk.version"))
            .unwrap_or_default()
            .lines()
            .find_map(|l| l.strip_prefix("TIZEN_SDK_VERSION=").map(str::to_owned))
            .unwrap_or_else(|| "unknown".to_owned());

        let profiles_path = format!("{home}/tizen-studio-data/profile/profiles.xml");
        let profiles = parse_cert_profiles(&profiles_path);

        return Ok(TizenStudioInfo { path: path.clone(), version, profiles });
    }

    Err(Error::new(
        "Tizen Studio not found. Install it from developer.samsung.com/tizenstudio",
    ))
}

// ── Samsung SmartTV Remote Control (WebSocket, port 8001) ────────────────────

fn b64_encode(input: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = chunk.get(1).copied().unwrap_or(0) as usize;
        let b2 = chunk.get(2).copied().unwrap_or(0) as usize;
        out.push(T[b0 >> 2] as char);
        out.push(T[((b0 & 3) << 4) | (b1 >> 4)] as char);
        out.push(if chunk.len() > 1 { T[((b1 & 0xf) << 2) | (b2 >> 6)] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[b2 & 0x3f] as char } else { '=' });
    }
    out
}

#[derive(serde::Deserialize)]
struct TizenPressKeyArgs {
    ip: String,
    key: String,
    token: Option<String>,
}

#[derive(serde::Serialize)]
struct TizenPressKeyResult {
    token: Option<String>,
}

#[tauri::command]
async fn tizen_press_key(args: TizenPressKeyArgs) -> Result<TizenPressKeyResult, Error> {
    use futures_util::{SinkExt, StreamExt};
    use tokio::time::timeout;
    use tokio_tungstenite::{connect_async, tungstenite::Message};

    let url = format!(
        "ws://{}:8001/api/v2/channels/samsung.remote.control",
        args.ip
    );

    let (mut ws, _) = timeout(
        std::time::Duration::from_secs(5),
        connect_async(&url),
    )
    .await
    .map_err(|_| Error::new("timeout connecting to TV remote (port 8001)"))?
    .map_err(|e| Error::new(format!("ws connect: {e}")))?;

    // Samsung requires the app name base64-encoded and token "0" when unknown
    let name_b64 = b64_encode(b"SmartTVQATool");
    let token = args.token.as_deref().unwrap_or("0");
    let connect_msg = serde_json::json!({
        "method": "ms.channel.connect",
        "params": {
            "name": name_b64,
            "token": token
        }
    });
    ws.send(Message::Text(connect_msg.to_string()))
        .await
        .map_err(|e| Error::new(format!("send connect: {e}")))?;

    // Wait for connect acknowledgement.
    // Some TV models: keep WebSocket open while showing the pairing dialog, then confirm.
    // Other models: send ms.channel.unauthorized, close, and wait for a reconnect after user approves.
    let mut got_unauthorized = false;
    let mut new_token: Option<String> = None;
    loop {
        let msg = timeout(std::time::Duration::from_secs(60), ws.next())
            .await
            .map_err(|_| Error::new(
                "Timed out waiting for TV authorization (60s).\n\nCheck the TV screen — a pairing dialog may have appeared. Approve it, then press the button again."
            ))?;

        let msg = match msg {
            Some(m) => m,
            None => {
                // TV closed the connection — this is normal after ms.channel.unauthorized.
                // Samsung's flow: send unauthorized, close, wait for user to accept on TV, then reconnect.
                return if got_unauthorized {
                    Err(Error::new(
                        "A pairing request was sent to the TV.\n\nIf a dialog appeared on screen, approve it and press the button again. The key will be sent after authorization."
                    ))
                } else {
                    Err(Error::new("TV closed the connection unexpectedly."))
                };
            }
        };

        let text = match msg.map_err(|e| Error::new(format!("ws read: {e}")))? {
            Message::Text(t) => t,
            _ => continue,
        };
        let v: serde_json::Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let event = v.get("event").and_then(|e| e.as_str()).unwrap_or("");
        if method == "ms.channel.connect" || event == "ms.channel.connect" {
            new_token = v.pointer("/params/token")
                .or_else(|| v.pointer("/data/token"))
                .and_then(|t| t.as_str())
                .filter(|t| !t.is_empty() && *t != "0")
                .map(String::from);
            break;
        }
        if event == "ms.channel.unauthorized" {
            got_unauthorized = true;
            continue;
        }
        if method == "ms.error" {
            return Err(Error::new(format!("TV returned error: {text}")));
        }
    }

    let key_msg = serde_json::json!({
        "method": "ms.remote.control",
        "params": {
            "Cmd": "Click",
            "DataOfCmd": args.key,
            "Option": "false",
            "TypeOfRemote": "SendRemoteKey"
        }
    });
    ws.send(Message::Text(key_msg.to_string()))
        .await
        .map_err(|e| Error::new(format!("send key: {e}")))?;

    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    let _ = ws.close(None).await;

    Ok(TizenPressKeyResult {
        token: new_token.or(args.token),
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
            tizen_detect_studio,
            tizen_install_signed,
            tizen_press_key,
            super::adb::adb_list_devices,
            super::adb::adb_connect,
            super::adb::adb_disconnect,
            super::adb::adb_list_packages,
            super::adb::adb_get_prop,
            super::adb::adb_launch,
            super::adb::adb_force_stop,
            super::adb::adb_uninstall,
            super::adb::adb_install,
        ])
        .build()
}
