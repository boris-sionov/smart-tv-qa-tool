//! Android phones over a USB cable: which ones are plugged in, and the few apps QA tests on them.
//!
//! Phones share the ADB plumbing with Android TV (`adb.rs`) but not its assumptions: a phone is
//! found by plugging it in rather than by `adb connect <ip>`, its app list is a fixed set of
//! packages rather than whatever the launcher shows, and `am start -a MAIN -p <id>` does not start
//! a phone app — without the LAUNCHER category the intent does not resolve.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use futures::future::join_all;
use tauri::{AppHandle, Runtime};

use super::adb::{run_adb, AdbPackageInfo};
use crate::error::Error;

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct UsbDevice {
    pub serial: String,
    /// `device`, `unauthorized` (the phone shows "Allow USB debugging?") or `offline`.
    pub state: String,
    /// The `model:` field of `adb devices -l`, underscores back to spaces. An unauthorized phone
    /// has none.
    pub model: Option<String>,
}

/// The USB-attached entries of `adb devices -l`. TVs connected over TCP have no `usb:` field.
fn parse_usb_devices(out: &str) -> Vec<UsbDevice> {
    out.lines()
        .skip(1)
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let serial = fields.next()?.to_string();
            let state = fields.next()?.to_string();
            let rest: Vec<&str> = fields.collect();
            if !rest.iter().any(|f| f.starts_with("usb:")) {
                return None;
            }
            let model = rest
                .iter()
                .find_map(|f| f.strip_prefix("model:"))
                .map(|m| m.replace('_', " "));
            Some(UsbDevice { serial, state, model })
        })
        .collect()
}

/// Whether a package id matches a pattern: the exact id, or any id that starts with what precedes
/// a trailing `*`.
fn matches_pattern(id: &str, pattern: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => id.starts_with(prefix),
        None => id == pattern,
    }
}

fn package_ids(pm_out: &str) -> Vec<String> {
    pm_out
        .lines()
        .filter_map(|l| l.trim().strip_prefix("package:"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn version_name(dump: &str) -> String {
    dump.lines()
        .find_map(|l| l.trim().strip_prefix("versionName="))
        .unwrap_or_default()
        .trim()
        .to_string()
}

#[tauri::command]
pub(crate) async fn adb_list_usb_devices<R: Runtime>(app: AppHandle<R>) -> Result<Vec<UsbDevice>, Error> {
    Ok(parse_usb_devices(&run_adb(&app, &["devices", "-l"]).await?))
}

/// The installed packages that match `patterns`, with their version names. `name` is the id; the
/// frontend owns the display names.
#[tauri::command]
pub(crate) async fn adb_list_packages_matching<R: Runtime>(
    app: AppHandle<R>,
    serial: String,
    patterns: Vec<String>,
) -> Result<Vec<AdbPackageInfo>, Error> {
    let ids: Vec<String> = package_ids(&run_adb(&app, &["-s", &serial, "shell", "pm", "list", "packages"]).await?)
        .into_iter()
        .filter(|id| patterns.iter().any(|p| matches_pattern(id, p)))
        .collect();
    let versions = join_all(ids.iter().map(|id| {
        let app = app.clone();
        let serial = serial.clone();
        async move {
            run_adb(&app, &["-s", &serial, "shell", "dumpsys", "package", id])
                .await
                .map(|dump| version_name(&dump))
                .unwrap_or_default()
        }
    }))
    .await;
    Ok(ids
        .into_iter()
        .zip(versions)
        .map(|(id, version_name)| AdbPackageInfo { name: id.clone(), id, version_name })
        .collect())
}

/// Starts the app's launcher activity, as tapping its icon does. `monkey` resolves the activity
/// itself, so no activity name is needed.
#[tauri::command]
pub(crate) async fn adb_launch_launcher<R: Runtime>(
    app: AppHandle<R>,
    serial: String,
    package_id: String,
) -> Result<(), Error> {
    let out = run_adb(
        &app,
        &["-s", &serial, "shell", "monkey", "-p", &package_id, "-c", "android.intent.category.LAUNCHER", "1"],
    )
    .await?;
    if out.contains("No activities found") || out.contains("monkey aborted") {
        return Err(Error::new(format!("{package_id} has no launcher activity on this phone")));
    }
    Ok(())
}

/// Writes the phone's log buffers (`adb logcat -d`: what is there now, then stop) to `path`.
/// Returns the number of lines written.
#[tauri::command]
pub(crate) async fn adb_save_logcat<R: Runtime>(app: AppHandle<R>, serial: String, path: String) -> Result<usize, Error> {
    let log = run_adb(&app, &["-s", &serial, "logcat", "-d", "-v", "threadtime"]).await?;
    std::fs::write(&path, &log).map_err(|e| Error::new(format!("Cannot write {path}: {e}")))?;
    Ok(log.lines().count())
}

/// Where scrcpy is, if anywhere. A GUI app on macOS starts with a bare PATH that misses Homebrew,
/// and WinGet's shim folder is on the user PATH only for apps started after the install, so those
/// are searched as well.
fn find_scrcpy() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "scrcpy.exe" } else { "scrcpy" };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"].map(PathBuf::from));
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join(r"Microsoft\WinGet\Links"));
    }
    dirs.into_iter().map(|d| d.join(exe)).find(|p| p.is_file())
}

/// Mirrors the phone's screen in a scrcpy window. `Ok(false)` when scrcpy is not installed, so the
/// UI can say how to get it.
///
/// scrcpy is pointed at our bundled adb (`ADB`): its own adb, or Homebrew's, is usually another
/// version, and two adb versions take turns killing each other's server — dropping every TV the
/// app is connected to. A start that fails within the first moments (phone unplugged, not
/// allowed) is reported with scrcpy's own message.
#[tauri::command]
pub(crate) async fn scrcpy_open(serial: String, title: Option<String>) -> Result<bool, Error> {
    let Some(scrcpy) = find_scrcpy() else { return Ok(false) };
    let log_path = std::env::temp_dir().join(format!("scrcpy-{}.log", serial.replace(['/', '\\', ':'], "_")));
    let log = std::fs::File::create(&log_path).map_err(|e| Error::new(format!("Cannot write {}: {e}", log_path.display())))?;
    let mut cmd = std::process::Command::new(&scrcpy);
    cmd.args(["-s", &serial]).stdin(Stdio::null()).stdout(log.try_clone()?).stderr(log);
    if let Some(title) = title.filter(|t| !t.is_empty()) {
        cmd.args(["--window-title", &title]);
    }
    let adb = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join(if cfg!(windows) { "adb.exe" } else { "adb" })))
        .filter(|p| p.is_file());
    if let Some(adb) = adb {
        cmd.env("ADB", adb);
    }
    let mut child = cmd.spawn().map_err(|e| Error::new(format!("Failed to start {}: {e}", scrcpy.display())))?;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    if let Ok(Some(status)) = child.try_wait() {
        if !status.success() {
            let out = std::fs::read_to_string(&log_path).unwrap_or_default();
            let reason = out.lines().filter(|l| l.contains("ERROR")).collect::<Vec<_>>().join("\n");
            return Err(Error::new(if reason.is_empty() { format!("scrcpy exited with {status}") } else { reason }));
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_usb_devices_only() {
        let out = "List of devices attached\n\
            FA69L0311341           device usb:2-1 product:sailfish model:Pixel_7_Pro device:sailfish transport_id:12\n\
            192.168.50.180:5555    device product:atv model:SHIELD device:darcy transport_id:3\n\
            R58N123ABC             unauthorized usb:1-1 transport_id:13\n\n";
        assert_eq!(
            parse_usb_devices(out),
            vec![
                UsbDevice { serial: "FA69L0311341".into(), state: "device".into(), model: Some("Pixel 7 Pro".into()) },
                UsbDevice { serial: "R58N123ABC".into(), state: "unauthorized".into(), model: None },
            ]
        );
    }

    #[test]
    fn matches_exact_ids_and_prefixes() {
        assert!(matches_pattern("com.MizrahiTefahot.nh", "com.MizrahiTefahot.nh"));
        assert!(!matches_pattern("com.MizrahiTefahot.nh.beta", "com.MizrahiTefahot.nh"));
        assert!(matches_pattern("tv.freetv.mobile.android", "tv.freetv.mobile.android*"));
        assert!(matches_pattern("tv.freetv.mobile.android.uat", "tv.freetv.mobile.android*"));
        assert!(!matches_pattern("tv.freetv.androidtv", "tv.freetv.mobile.android*"));
    }

    #[test]
    fn reads_package_ids_and_version() {
        assert_eq!(package_ids("package:a.b\npackage:c.d\n\n"), vec!["a.b", "c.d"]);
        assert_eq!(version_name("  versionCode=152 minSdk=24\n    versionName=1.52.0\n"), "1.52.0");
        assert_eq!(version_name("nothing"), "");
    }
}
