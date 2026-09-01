// Minimal SDB/ADB wire protocol implementation.
// Samsung SDB (port 26101) uses the same protocol as ADB but without RSA auth.
// We implement just enough to open a shell service and read the response.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, plugin::{Builder, TauriPlugin}, Runtime};
use tauri_plugin_shell::ShellExt;
extern crate native_tls;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;

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


/// What `config.xml` says about a WGT, so the UI can pick the environment icon for it
/// before the install starts.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TizenWgtInfo {
    pub id: String,
    pub name: String,
    /// Entry the package calls its icon, `icon.png` when `config.xml` does not say.
    pub icon: String,
}

// ── Signed install helpers ───────────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub step: String,
    pub message: String,
    pub percent: u8,
}

/// The `config.xml` that describes a WGT — the `.buildResult/` one when the package is
/// double-packaged, since that is the copy the install flow keeps.
fn wgt_config_xml(file_path: &str) -> Result<String, Error> {
    use zip::ZipArchive;

    let file = std::fs::File::open(file_path)
        .map_err(|e| Error::new(format!("Cannot open {file_path}: {e}")))?;
    let mut zip = ZipArchive::new(file)
        .map_err(|e| Error::new(format!("Not a valid ZIP/WGT: {e}")))?;

    for name in [".buildResult/config.xml", "config.xml"] {
        if let Ok(mut entry) = zip.by_name(name) {
            let mut xml = String::new();
            entry
                .read_to_string(&mut xml)
                .map_err(|e| Error::new(format!("Cannot read {name}: {e}")))?;
            return Ok(xml);
        }
    }
    Err(Error::new(format!("{file_path} has no config.xml")))
}

/// Stages a WGT for signing under the temp dir, never touching the source — signing rewrites
/// the file in place and the source is the user's download. The caller deletes the temp file.
///
/// Two things happen on the way through:
///
/// - A double-packaged WGT (the CI build ships the app at the root *and* inside `.buildResult/`)
///   is rebuilt from `.buildResult/` alone. Old signatures are dropped; `tizen package` writes
///   fresh ones.
/// - `icon`, when given, replaces the named entry's bytes. It is how a sideloaded FreeTV build
///   gets its environment badge: the icon has to be inside the package, because a retail Samsung
///   TV will not let sdb write to the icon directory after the install.
///
/// A package that needs neither is copied rather than rebuilt.
fn stage_wgt(file_path: &str, icon: Option<(&str, &[u8])>) -> Result<std::path::PathBuf, Error> {
    use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions, CompressionMethod};

    let file = std::fs::File::open(file_path)
        .map_err(|e| Error::new(format!("Cannot open {file_path}: {e}")))?;
    let mut probe = ZipArchive::new(file)
        .map_err(|e| Error::new(format!("Not a valid ZIP/WGT: {e}")))?;

    let names: Vec<String> = (0..probe.len())
        .filter_map(|i| probe.by_index(i).ok().map(|e| e.name().to_owned()))
        .collect();

    let double_packed = names.iter().any(|n| n == ".buildResult/config.xml")
        && names.iter().any(|n| n == "config.xml");

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp_path = std::env::temp_dir().join(format!("wgt-repack-{ts}.wgt"));

    if !double_packed && icon.is_none() {
        std::fs::copy(file_path, &temp_path)
            .map_err(|e| Error::new(format!("Cannot stage {file_path}: {e}")))?;
        return Ok(temp_path);
    }

    let out_file = std::fs::File::create(&temp_path)
        .map_err(|e| Error::new(format!("Cannot create temp file: {e}")))?;
    let mut writer = ZipWriter::new(out_file);
    let opts = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated);

    let src_file = std::fs::File::open(file_path)
        .map_err(|e| Error::new(format!("Cannot re-open source: {e}")))?;
    let mut src = ZipArchive::new(src_file)
        .map_err(|e| Error::new(format!("Cannot re-read ZIP: {e}")))?;

    let mut icon_written = false;
    for i in 0..src.len() {
        let mut entry = src.by_index(i)
            .map_err(|e| Error::new(format!("ZIP entry {i}: {e}")))?;
        let raw = entry.name().replace('\\', "/");
        let name = if double_packed {
            let Some(stripped) = raw.strip_prefix(".buildResult/") else { continue };
            stripped.to_owned()
        } else {
            raw.clone()
        };
        if name.is_empty() { continue }
        if name == "author-signature.xml" || name == "signature1.xml" { continue }
        if raw.ends_with('/') {
            writer.add_directory(&name, opts)
                .map_err(|e| Error::new(format!("Cannot add dir {name}: {e}")))?;
            continue;
        }
        writer.start_file(&name, opts)
            .map_err(|e| Error::new(format!("Cannot start file {name}: {e}")))?;
        match icon {
            Some((icon_name, bytes)) if name == icon_name => {
                writer.write_all(bytes)
                    .map_err(|e| Error::new(format!("Cannot write {name}: {e}")))?;
                icon_written = true;
            }
            _ => {
                std::io::copy(&mut entry, &mut writer)
                    .map_err(|e| Error::new(format!("Cannot copy {name}: {e}")))?;
            }
        }
    }

    // `config.xml` can name an icon the package does not actually carry.
    if let Some((icon_name, bytes)) = icon {
        if !icon_written {
            writer.start_file(icon_name, opts)
                .map_err(|e| Error::new(format!("Cannot start file {icon_name}: {e}")))?;
            writer.write_all(bytes)
                .map_err(|e| Error::new(format!("Cannot write {icon_name}: {e}")))?;
        }
    }

    writer.finish()
        .map_err(|e| Error::new(format!("Cannot finish ZIP: {e}")))?;

    Ok(temp_path)
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
    /// DUIDs of the TVs this profile's distributor certificate was issued for.
    /// Empty when `device-profile.xml` is missing next to the distributor key.
    pub duids: Vec<String>,
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
    let distributor_key = regex::Regex::new(
        r#"<profileitem[^>]*\bdistributor="1"[^>]*\bkey="([^"]*)""#,
    )
    .unwrap();
    regex::Regex::new(r#"(?s)<profile\s+name="([^"]+)"(.*?)</profile>"#)
        .unwrap()
        .captures_iter(&content)
        .map(|c| {
            let name = c[1].to_owned();
            let is_active = name == active;
            let duids = distributor_key
                .captures(&c[2])
                .and_then(|k| k.get(1))
                .map(|m| m.as_str())
                .filter(|path| !path.is_empty())
                .map(read_profile_duids)
                .unwrap_or_default();
            TizenCertProfile { active: is_active, name, duids }
        })
        .collect()
}

/// Reads the TV DUIDs a distributor certificate was issued for. Samsung writes them
/// into `device-profile.xml`, which the Certificate Manager drops next to the key.
fn read_profile_duids(distributor_key_path: &str) -> Vec<String> {
    let Some(dir) = std::path::Path::new(distributor_key_path).parent() else { return vec![] };
    let Ok(xml) = std::fs::read_to_string(dir.join("device-profile.xml")) else { return vec![] };
    regex::Regex::new(r"<TestDevice>([^<]*)</TestDevice>")
        .unwrap()
        .captures_iter(&xml)
        .map(|c| c[1].trim().to_owned())
        .filter(|d| !d.is_empty())
        .collect()
}

/// Picks the certificate profile to sign with, and the line to show while doing it.
///
/// A Samsung distributor certificate is issued for a fixed list of TV DUIDs. Signing with
/// a profile that does not cover the target TV yields a correctly signed package that the
/// TV still rejects with `install failed[118, -12] … Unsigned file error` — the same code
/// an actually unsigned package gets, which is why it reads as a packaging problem.
///
/// The saved profile wins when it covers the TV; otherwise the first profile that does is
/// used. Without a DUID — or without any profile declaring one — there is nothing to match
/// on, so the saved profile stands.
fn pick_cert_profile(
    saved: String,
    duid: Option<&str>,
    profiles: &[TizenCertProfile],
) -> Result<(String, String), Error> {
    let Some(duid) = duid.filter(|_| profiles.iter().any(|p| !p.duids.is_empty())) else {
        return Ok((saved, "Using selected certificate".to_owned()));
    };
    // `getduid` can echo more than the bare id, so test by containment.
    let haystack = duid.to_ascii_uppercase();
    let covers =
        |p: &TizenCertProfile| p.duids.iter().any(|d| haystack.contains(&d.to_ascii_uppercase()));

    if profiles.iter().any(|p| p.name == saved && covers(p)) {
        return Ok((saved, "Certificate matches this TV".to_owned()));
    }
    if let Some(matched) = profiles.iter().find(|p| covers(p)) {
        let note = format!("Using certificate '{}' — registered for this TV", matched.name);
        return Ok((matched.name.clone(), note));
    }

    let known = profiles
        .iter()
        .filter(|p| !p.duids.is_empty())
        .map(|p| format!("{} → {}", p.name, p.duids.join(", ")))
        .collect::<Vec<_>>()
        .join("\n");
    Err(Error::new(format!(
        "This TV is not covered by any Samsung certificate.\n\
         TV DUID: {duid}\n\
         Certificates on this machine:\n{known}\n\n\
         Open Certificate Manager and add this TV's DUID to a distributor certificate, or \
         create a profile for it. Installing with another TV's certificate fails with \
         'Unsigned file error'."
    )))
}

/// `profiles.xml` lives in `tizen-studio-data`, a sibling of the Tizen Studio
/// install dir, falling back to the one under $HOME.
fn cert_profiles_path(tizen_studio_path: &str) -> String {
    if let Some(parent) = std::path::Path::new(tizen_studio_path).parent() {
        let candidate = parent.join("tizen-studio-data/profile/profiles.xml");
        if candidate.exists() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    format!("{home}/tizen-studio-data/profile/profiles.xml")
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

/// `0 getduid` is the one that answers on current Tizen TVs — the others are
/// kept for older firmware, where they return the id and `getduid` is absent.
fn read_duid(serial: &str) -> Result<String, Error> {
    for cmd in &["0 getduid", "0 duid", "0 /usr/bin/duid", "0 getprop _duid"] {
        if let Ok(out) = tizen_run_shell(serial, cmd) {
            let t = out.trim().to_owned();
            if !t.is_empty() {
                return Ok(t);
            }
        }
    }
    Err(Error::new("Could not retrieve Samsung TV DUID"))
}

#[tauri::command]
pub(crate) async fn tizen_get_duid(serial: String) -> Result<String, Error> {
    read_duid(&serial)
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


/// Repacks, signs and installs a WGT.
///
/// `icon_png_base64` and `icon_entry` are the environment badge to bake into the package before
/// signing, and the entry it replaces. Both absent for a build we ship no badge for.
#[tauri::command]
pub(crate) async fn tizen_install_signed<R: Runtime>(
    app: AppHandle<R>,
    serial: String,
    file_path: String,
    cert_profile: String,
    tizen_studio_path: String,
    icon_png_base64: Option<String>,
    icon_entry: Option<String>,
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
    let tizen_bin = format!(r"{tizen_studio_path}\tools\ide\bin\tizen.bat");
    #[cfg(not(target_os = "windows"))]
    let tizen_bin = format!("{tizen_studio_path}/tools/ide/bin/tizen");

    if !std::path::Path::new(&tizen_bin).exists() {
        return Err(Error::new(format!("Tizen CLI not found at {tizen_bin}")));
    }

    // Step 1 — Graceful disconnect so the TV's SDB daemon cleans up immediately,
    //           then kill the local server to drop any lingering TizenBrew tunnel.
    emit!("disconnecting", "Disconnecting from TizenBrew…", 5);
    if let Ok(cmd) = app.shell().sidecar("sdb") {
        let _ = cmd.args(["disconnect", &serial]).output().await;
    }
    if let Ok(cmd) = app.shell().sidecar("sdb") {
        let _ = cmd.args(["kill-server"]).output().await;
    }

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
        let out = app.shell().sidecar("sdb")
            .map_err(|e| Error::new(format!("sdb sidecar: {e}")))?
            .args(["connect", &serial])
            .output()
            .await
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

    // Step 3b — Match the certificate profile to this TV (see `pick_cert_profile`).
    emit!("certificate", "Matching certificate to TV…", 38);
    let profiles = parse_cert_profiles(&cert_profiles_path(&tizen_studio_path));
    let duid = {
        let s = serial.clone();
        tokio::task::spawn_blocking(move || read_duid(&s))
            .await
            .ok()
            .and_then(Result::ok)
    };
    let (cert_profile, note) = pick_cert_profile(cert_profile, duid.as_deref(), &profiles)?;
    emit!("certificate", &note, 40);

    // Step 4 — Stage (repack, badge the icon) + Sign (building)
    let icon_png = match icon_png_base64.as_deref() {
        Some(encoded) => Some(
            BASE64
                .decode(encoded)
                .map_err(|e| Error::new(format!("Environment icon is not valid base64: {e}")))?,
        ),
        None => None,
    };
    emit!("building", "Checking package structure…", 42);
    let work_path = tokio::task::spawn_blocking({
        let fp = file_path.clone();
        let entry = icon_entry.unwrap_or_else(|| "icon.png".to_owned());
        move || stage_wgt(&fp, icon_png.as_deref().map(|bytes| (entry.as_str(), bytes)))
    }).await.map_err(|e| Error::new(format!("stage task: {e}")))??;

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
            let _ = std::fs::remove_file(&work_path);
            return Err(Error::new(e.to_string()));
        }
        Ok(Err(ref e)) => {
            let _ = std::fs::remove_file(&work_path);
            return Err(Error::new(e.to_string()));
        }
        Ok(Ok(v)) => v,
    };
    drop(sign_ok);

    // Step 5 — Install via tizen CLI
    emit!("installing", "Installing on device…", 68);
    let serial_d = serial.clone();
    let install_result = tokio::task::spawn_blocking({
        let tb = tizen_bin.clone();
        let wp = work_str.clone();
        let s  = serial.clone();
        move || {
            Command::new(&tb)
                .args(["install", "-n", &wp, "-s", &s])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
        }
    }).await.map_err(|e| Error::new(format!("install task: {e}")));
    // Disconnect regardless of install outcome
    if let Ok(cmd) = app.shell().sidecar("sdb") {
        let _ = cmd.args(["disconnect", &serial_d]).output().await;
    }

    let _ = std::fs::remove_file(&work_path);

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
pub(crate) async fn tizen_read_wgt_info(file_path: String) -> Result<TizenWgtInfo, Error> {
    let xml = wgt_config_xml(&file_path)?;
    let first = |pattern: &str| {
        regex::Regex::new(pattern)
            .unwrap()
            .captures(&xml)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    Ok(TizenWgtInfo {
        id: first(r#"<tizen:application[^>]*\bid="([^"]+)""#).unwrap_or_default(),
        name: first(r"(?s)<name[^>]*>(.*?)</name>").unwrap_or_default(),
        icon: first(r#"<icon[^>]*\bsrc="([^"]+)""#).unwrap_or_else(|| "icon.png".to_owned()),
    })
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

#[tauri::command]
pub(crate) async fn tizen_open_certificate_manager(studio_path: String) -> Result<(), Error> {
    #[cfg(target_os = "windows")]
    let bin = format!(r"{studio_path}\tools\certificate-manager\certificate-manager.exe");
    #[cfg(not(target_os = "windows"))]
    let bin = format!("{studio_path}/tools/certificate-manager/certificate-manager");
    std::process::Command::new(&bin)
        .spawn()
        .map_err(|e| Error::new(format!("Failed to open Certificate Manager: {e}")))?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn tizen_open_device_manager(studio_path: String) -> Result<(), Error> {
    #[cfg(target_os = "windows")]
    let bin = format!(r"{studio_path}\tools\device-manager\bin\device-manager.exe");
    #[cfg(not(target_os = "windows"))]
    let bin = format!("{studio_path}/tools/device-manager/bin/device-manager");
    std::process::Command::new(&bin)
        .spawn()
        .map_err(|e| Error::new(format!("Failed to open Device Manager: {e}")))?;
    Ok(())
}

// ── Samsung SmartTV Remote Control (WebSocket, port 8002 wss) ────────────────

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
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::{connect_async_tls_with_config, Connector};

    // Name must be a URL query param, NOT in a JSON body. Token too, when available.
    let name_b64 = b64_encode(b"SmartTVQATool");
    let url = match args.token.as_deref().filter(|t| !t.is_empty()) {
        Some(token) => format!(
            "wss://{}:8002/api/v2/channels/samsung.remote.control?name={}&token={}",
            args.ip, name_b64, token
        ),
        None => format!(
            "wss://{}:8002/api/v2/channels/samsung.remote.control?name={}",
            args.ip, name_b64
        ),
    };

    let tls = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()
        .map_err(|e| Error::new(format!("tls build: {e}")))?;
    let connector = Connector::NativeTls(tls);

    let request = url
        .into_client_request()
        .map_err(|e| Error::new(format!("bad url: {e}")))?;

    let (mut ws, _) = timeout(
        std::time::Duration::from_secs(5),
        connect_async_tls_with_config(request, None, false, Some(connector)),
    )
    .await
    .map_err(|_| Error::new("timeout connecting to TV remote (port 8002)"))?
    .map_err(|e| Error::new(format!("ws connect: {e}")))?;

    // No connect message to send — the URL query params carry everything.
    // Wait for ms.channel.connect (sent immediately with valid token, or after user approves pairing).
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
        let event = v.get("event").and_then(|e| e.as_str()).unwrap_or("");
        if event == "ms.channel.connect" {
            // Token is in data.token (some models) or data.clients[0].attributes.token
            new_token = v.pointer("/data/token")
                .or_else(|| v.pointer("/data/clients/0/attributes/token"))
                .and_then(|t| t.as_str())
                .filter(|t| !t.is_empty() && *t != "0")
                .map(String::from);
            break;
        }
        if event == "ms.channel.unauthorized" {
            got_unauthorized = true;
            continue;
        }
        if event == "ms.error" || v.get("method").and_then(|m| m.as_str()) == Some("ms.error") {
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
            tizen_read_wgt_info,
            tizen_get_app_version,
            tizen_daemon_command,
            tizen_detect_studio,
            tizen_install_signed,
            tizen_press_key,
            tizen_open_certificate_manager,
            tizen_open_device_manager,
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

#[cfg(test)]
mod cert_profile_tests {
    use super::*;

    fn write(dir: &std::path::Path, name: &str, body: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
        path
    }

    /// A distributor certificate is issued for a fixed set of TV DUIDs; the install
    /// flow needs those to pick the profile that actually covers the target TV.
    #[test]
    fn parses_duids_per_profile() {
        let dir = std::env::temp_dir().join(format!("tz-certs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        write(&dir, "office/device-profile.xml",
            "<Profile><TestDeviceInfo><TestDevice>H3CDAJCBERASC</TestDevice>\
             <TestDevice>XTCAX3YHRKE2K</TestDevice></TestDeviceInfo></Profile>");
        write(&dir, "home/device-profile.xml",
            "<Profile><TestDeviceInfo><TestDevice>MTCEZJ2H55GWC</TestDevice></TestDeviceInfo></Profile>");
        // No device-profile.xml next to this one.
        std::fs::create_dir_all(dir.join("bare")).unwrap();

        let xml = format!(
            r#"<?xml version="1.0"?>
<profiles active="home" version="3.1">
<profile name="office">
<profileitem ca="" distributor="0" key="{d}/author.p12" password="" rootca=""/>
<profileitem ca="" distributor="1" key="{d}/office/distributor.p12" password="" rootca=""/>
</profile>
<profile name="home">
<profileitem ca="" distributor="1" key="{d}/home/distributor.p12" password="" rootca=""/>
</profile>
<profile name="bare">
<profileitem ca="" distributor="1" key="{d}/bare/distributor.p12" password="" rootca=""/>
</profile>
</profiles>"#,
            d = dir.display()
        );
        let profiles_path = write(&dir, "profiles.xml", &xml);

        let profiles = parse_cert_profiles(&profiles_path.to_string_lossy());
        let by_name = |n: &str| profiles.iter().find(|p| p.name == n).unwrap();

        assert_eq!(profiles.len(), 3);
        assert_eq!(by_name("office").duids, ["H3CDAJCBERASC", "XTCAX3YHRKE2K"]);
        assert_eq!(by_name("home").duids, ["MTCEZJ2H55GWC"]);
        assert!(by_name("bare").duids.is_empty());
        assert!(by_name("home").active);
        assert!(!by_name("office").active);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_profiles_file_yields_no_profiles() {
        assert!(parse_cert_profiles("/nonexistent/profiles.xml").is_empty());
    }

    fn profile(name: &str, duids: &[&str]) -> TizenCertProfile {
        TizenCertProfile {
            name: name.to_owned(),
            active: false,
            duids: duids.iter().map(|d| (*d).to_owned()).collect(),
        }
    }

    #[test]
    fn keeps_saved_profile_when_it_covers_the_tv() {
        let profiles = [profile("office-2024", &["H3CDAJCBERASC"]), profile("home", &["MTCEZJ2H55GWC"])];
        let (name, _) =
            pick_cert_profile("office-2024".into(), Some("H3CDAJCBERASC"), &profiles).unwrap();
        assert_eq!(name, "office-2024");
    }

    /// The regression: one saved profile is shared by every device, so switching TVs in the
    /// picker used to sign with the previous TV's certificate and fail with `[118, -12]`.
    #[test]
    fn switches_to_the_profile_registered_for_the_tv() {
        let profiles = [profile("office-2024", &["H3CDAJCBERASC"]), profile("Yaakov-2022", &["MTCEZJ2H55GWC"])];
        let (name, note) =
            pick_cert_profile("Yaakov-2022".into(), Some("H3CDAJCBERASC"), &profiles).unwrap();
        assert_eq!(name, "office-2024");
        assert!(note.contains("office-2024"), "{note}");
    }

    /// `getduid` can echo more than the bare id.
    #[test]
    fn matches_duid_within_noisier_output() {
        let profiles = [profile("office-2024", &["h3cdajcberasc"])];
        let (name, _) =
            pick_cert_profile("office-2024".into(), Some("duid: H3CDAJCBERASC\n"), &profiles).unwrap();
        assert_eq!(name, "office-2024");
    }

    #[test]
    fn errors_with_the_duid_when_no_profile_covers_the_tv() {
        let profiles = [profile("office-2024", &["H3CDAJCBERASC"])];
        let err = pick_cert_profile("office-2024".into(), Some("UNKNOWNDUID42"), &profiles)
            .expect_err("should refuse to sign with a certificate that cannot work");
        let msg = err.to_string();
        assert!(msg.contains("UNKNOWNDUID42"), "{msg}");
        assert!(msg.contains("H3CDAJCBERASC"), "{msg}");
    }

    #[test]
    fn falls_back_to_the_saved_profile_without_matchable_data() {
        let with_duids = [profile("office-2024", &["H3CDAJCBERASC"])];
        // DUID read failed.
        assert_eq!(
            pick_cert_profile("Yaakov-2022".into(), None, &with_duids).unwrap().0,
            "Yaakov-2022"
        );
        // No profile declares a DUID (device-profile.xml missing).
        let bare = [profile("Yaakov-2022", &[]), profile("office-2024", &[])];
        assert_eq!(
            pick_cert_profile("Yaakov-2022".into(), Some("H3CDAJCBERASC"), &bare).unwrap().0,
            "Yaakov-2022"
        );
    }
}

#[cfg(test)]
mod wgt_tests {
    use super::*;
    use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions, CompressionMethod};

    const CONFIG: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<widget xmlns:tizen="http://tizen.org/ns/widgets" version="1.26.0">
    <tizen:application id="kY6012WvBv.FreeTVpreprod" package="kY6012WvBv" required_version="2.3"/>
    <icon src="icon.png"/>
    <name>Free TV preprod</name>
</widget>"#;

    /// Writes a WGT holding `entries`, plus the signatures every CI build carries.
    fn wgt(dir: &std::path::Path, file: &str, entries: &[(&str, &[u8])]) -> String {
        let path = dir.join(file);
        std::fs::create_dir_all(dir).unwrap();
        let mut writer = ZipWriter::new(std::fs::File::create(&path).unwrap());
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, body) in entries {
            writer.start_file(*name, opts).unwrap();
            writer.write_all(body).unwrap();
        }
        writer.finish().unwrap();
        path.to_string_lossy().into_owned()
    }

    fn read(path: &str, name: &str) -> Option<Vec<u8>> {
        let mut zip = ZipArchive::new(std::fs::File::open(path).unwrap()).ok()?;
        let mut entry = zip.by_name(name).ok()?;
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).ok()?;
        Some(buf)
    }

    fn names(path: &str) -> Vec<String> {
        let file = std::fs::File::open(path).unwrap();
        let mut zip = ZipArchive::new(file).unwrap();
        (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_owned()).collect()
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tz-wgt-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The CI build ships the app twice: unsigned at the root, signed under `.buildResult/`.
    fn double_packed(dir: &std::path::Path, icon: &[u8]) -> String {
        wgt(dir, "ci.wgt", &[
            ("config.xml", b"<widget>stale root copy</widget>"),
            ("icon.png", b"root icon"),
            ("index.html", b"root html"),
            ("signature1.xml", b"<sig/>"),
            (".buildResult/config.xml", CONFIG.as_bytes()),
            (".buildResult/icon.png", icon),
            (".buildResult/index.html", b"<html>real</html>"),
            (".buildResult/js/app.js", b"code"),
            (".buildResult/author-signature.xml", b"<sig/>"),
            (".buildResult/signature1.xml", b"<sig/>"),
        ])
    }

    #[test]
    fn strips_the_root_copy_and_old_signatures() {
        let dir = scratch("strip");
        let src = double_packed(&dir, b"packaged icon");
        let staged = stage_wgt(&src, None).unwrap();
        let staged = staged.to_string_lossy().into_owned();

        assert_eq!(
            names(&staged),
            ["config.xml", "icon.png", "index.html", "js/app.js"],
            "keeps .buildResult/ content at the root, drops the signatures"
        );
        assert_eq!(read(&staged, "config.xml").unwrap(), CONFIG.as_bytes());
        assert_eq!(read(&staged, "index.html").unwrap(), b"<html>real</html>");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bakes_the_environment_icon_into_a_double_packaged_wgt() {
        let dir = scratch("badge");
        let src = double_packed(&dir, b"packaged icon");
        let staged = stage_wgt(&src, Some(("icon.png", b"badged icon"))).unwrap();
        let staged = staged.to_string_lossy().into_owned();

        assert_eq!(read(&staged, "icon.png").unwrap(), b"badged icon");
        // Substituting the icon must not disturb anything else.
        assert_eq!(read(&staged, "index.html").unwrap(), b"<html>real</html>");
        assert_eq!(names(&staged).iter().filter(|n| *n == "icon.png").count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bakes_the_icon_into_a_plain_wgt_too() {
        let dir = scratch("plain");
        let src = wgt(&dir, "plain.wgt", &[
            ("config.xml", CONFIG.as_bytes()),
            ("icon.png", b"packaged icon"),
            ("index.html", b"<html/>"),
        ]);
        let staged = stage_wgt(&src, Some(("icon.png", b"badged icon"))).unwrap();
        let staged = staged.to_string_lossy().into_owned();

        assert_eq!(read(&staged, "icon.png").unwrap(), b"badged icon");
        assert_eq!(read(&staged, "config.xml").unwrap(), CONFIG.as_bytes());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `config.xml` can name an icon the package does not carry.
    #[test]
    fn adds_the_icon_when_the_package_has_none() {
        let dir = scratch("missing");
        let src = wgt(&dir, "noicon.wgt", &[("config.xml", CONFIG.as_bytes())]);
        let staged = stage_wgt(&src, Some(("icon.png", b"badged icon"))).unwrap();
        let staged = staged.to_string_lossy().into_owned();

        assert_eq!(read(&staged, "icon.png").unwrap(), b"badged icon");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_plain_wgt_with_no_icon_to_apply_is_left_alone() {
        let dir = scratch("copy");
        let src = wgt(&dir, "plain.wgt", &[
            ("config.xml", CONFIG.as_bytes()),
            ("signature1.xml", b"<sig/>"),
        ]);
        let staged = stage_wgt(&src, None).unwrap();
        let staged = staged.to_string_lossy().into_owned();

        assert_ne!(staged, src, "staged under the temp dir, never the source");
        assert_eq!(std::fs::read(&staged).unwrap(), std::fs::read(&src).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The id and name feed the environment lookup that picks the badge.
    #[test]
    fn reads_the_buildresult_config_not_the_stale_root_one() {
        let dir = scratch("info");
        let src = double_packed(&dir, b"packaged icon");
        let xml = wgt_config_xml(&src).unwrap();

        assert!(xml.contains("kY6012WvBv.FreeTVpreprod"), "{xml}");
        assert!(!xml.contains("stale root copy"), "{xml}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

