use futures::future::join_all;
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
        // Ids seen on our test sets whose brand the derived name would miss.
        "com.netflix.ninja" => Some("Netflix"),
        "com.disneyplus.mea" => Some("Disney+ MEA"),
        "com.wbd.stream" => Some("HBO Max"),
        "com.amazon.amazonvideo.livingroom" => Some("Prime Video"),
        "il.net.hot.nexttv" => Some("NextTV"),
        "com.google.android.youtube.tv" => Some("YouTube"),
        "com.google.android.youtube.tvmusic" => Some("YouTube Music"),
        "com.google.android.play.games" => Some("Play Games"),
        "com.android.vending" => Some("Play Store"),
        "com.plexapp.android" => Some("Plex"),
        "com.spotify.tv.android" => Some("Spotify"),
        "com.esaba.downloader" => Some("Downloader"),
        "com.nousguide.android.rbtv" => Some("Red Bull TV"),
        "com.applicaster.il.ch1" => Some("Kan 11"),
        _ => None,
    }
}

/// Name for a package the whitelist above does not know: the longest segment of its id
/// that is not a prefix every id carries, title-cased — the brand, more often than not
/// (`com.netflix.ninja` ⇒ Netflix, `com.google.android.youtube.tv` ⇒ Youtube). A guess:
/// the row shows the full id next to it, and a name worth getting right belongs in
/// `app_name()` above.
fn derived_name(package_id: &str) -> String {
    const GENERIC: [&str; 12] = [
        "com", "org", "net", "il", "co", "tv", "android", "atv", "app", "apps", "mobile", "client",
    ];
    let segment = package_id
        .split('.')
        .filter(|s| !s.is_empty() && !GENERIC.contains(&s.to_lowercase().as_str()))
        .max_by_key(|s| s.len())
        .unwrap_or(package_id);
    let mut chars = segment.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => package_id.to_owned(),
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
// Android TV commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) async fn adb_list_devices<R: Runtime>(app: AppHandle<R>) -> Result<Vec<AdbDevice>, Error> {
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
            if serial.is_empty() { None } else { Some(AdbDevice { serial, state }) }
        })
        .collect();
    Ok(devices)
}

#[tauri::command]
pub(crate) async fn adb_connect<R: Runtime>(app: AppHandle<R>, host: String) -> Result<String, Error> {
    let target = if host.contains(':') { host.clone() } else { format!("{host}:5555") };
    let output = app.shell().sidecar("adb")
        .map_err(|e| Error::new(format!("Failed to create ADB sidecar: {e}")))?
        .args(["connect", &target]).output().await
        .map_err(|e| Error::new(format!("Failed to run ADB: {e}")))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let combined = [stdout.as_str(), stderr.as_str()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("\n");
    if !output.status.success() || regex::Regex::new(r"(?i)failed|error|unable|cannot|missing|refused|timed out").unwrap().is_match(&combined) {
        return Err(Error::new(if combined.is_empty() { format!("adb exited with code {:?}", output.status.code()) } else { combined }));
    }
    Ok(if combined.is_empty() { format!("connected to {target}") } else { combined })
}

#[tauri::command]
pub(crate) async fn adb_disconnect<R: Runtime>(app: AppHandle<R>, serial: String) -> Result<(), Error> {
    run_adb(&app, &["disconnect", &serial]).await?;
    Ok(())
}

/// Package ids the TV itself shows on a home screen — every app with a MAIN launcher
/// activity, leanback or phone-style. Empty when `cmd package` is unavailable (older
/// firmware), which makes the caller fall back to the full package list.
async fn launchable_package_ids<R: Runtime>(app: &AppHandle<R>, serial: &str) -> Vec<String> {
    let mut ids: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for category in [
        "android.intent.category.LEANBACK_LAUNCHER",
        "android.intent.category.LAUNCHER",
    ] {
        let Ok(out) = run_adb(
            app,
            &[
                "-s", serial, "shell", "cmd", "package", "query-activities", "--brief",
                "-a", "android.intent.action.MAIN", "-c", category,
            ],
        )
        .await
        else {
            continue;
        };
        for line in out.lines() {
            // `--brief` prints one `<package>/<activity>` per match, plus plain header lines.
            let Some((pkg, _)) = line.trim().split_once('/') else { continue };
            let looks_like_id = pkg.contains('.')
                && pkg
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_');
            if looks_like_id {
                ids.insert(pkg.to_owned());
            }
        }
    }
    ids.into_iter().collect()
}

#[tauri::command]
pub(crate) async fn adb_list_packages<R: Runtime>(app: AppHandle<R>, serial: String) -> Result<Vec<AdbPackageInfo>, Error> {
    let mut ids = launchable_package_ids(&app, &serial).await;
    if ids.is_empty() {
        let list_out = run_adb(&app, &["-s", &serial, "shell", "pm", "list", "packages"]).await?;
        ids = list_out.lines().filter_map(|l| l.strip_prefix("package:")).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    }
    // Known brands in their usual order first; everything else alphabetically after them.
    // `sort_key` only speaks for whitelisted names — it matches brands as substrings, and
    // a derived name like "Photos" would otherwise sort with "Hot".
    let mut named: Vec<(String, String)> = ids.iter().map(|id| {
        match app_name(id) {
            Some(name) => (id.clone(), name.to_owned()),
            None => (id.clone(), derived_name(id)),
        }
    }).collect();
    named.sort_by_key(|(id, name)| {
        let key = if app_name(id).is_some() { sort_key(name) } else { u32::MAX };
        (key, name.to_lowercase())
    });
    let version_futures: Vec<_> = named.iter().map(|(id, _)| {
        let app = app.clone(); let serial = serial.clone(); let id = id.clone();
        async move {
            run_adb(&app, &["-s", &serial, "shell", "pm", "dump", &id]).await.ok()
                .and_then(|s| s.lines().find_map(|l| l.trim().strip_prefix("versionName=").map(|v| v.trim().to_string())))
                .unwrap_or_default()
        }
    }).collect();
    let versions: Vec<String> = join_all(version_futures).await;
    let results: Vec<AdbPackageInfo> = named.iter().zip(versions.iter()).map(|((id, name), version)| AdbPackageInfo { id: id.clone(), name: name.clone(), version_name: version.clone() }).collect();
    Ok(results)
}

#[tauri::command]
pub(crate) async fn adb_get_prop<R: Runtime>(app: AppHandle<R>, serial: String, prop: String) -> Result<String, Error> {
    let out = run_adb(&app, &["-s", &serial, "shell", "getprop", &prop]).await?;
    Ok(out.trim().to_string())
}

#[tauri::command]
pub(crate) async fn adb_launch<R: Runtime>(app: AppHandle<R>, serial: String, package_id: String) -> Result<(), Error> {
    run_adb(&app, &["-s", &serial, "shell", "am", "start", "-a", "android.intent.action.MAIN", "-p", &package_id]).await?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn adb_force_stop<R: Runtime>(app: AppHandle<R>, serial: String, package_id: String) -> Result<(), Error> {
    run_adb(&app, &["-s", &serial, "shell", "am", "force-stop", &package_id]).await?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn adb_uninstall<R: Runtime>(app: AppHandle<R>, serial: String, package_id: String) -> Result<(), Error> {
    run_adb(&app, &["-s", &serial, "uninstall", &package_id]).await?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn adb_install<R: Runtime>(
    app: AppHandle<R>,
    serial: String,
    apk_path: String,
    downgrade: Option<bool>,
) -> Result<(), Error> {
    // `-d` lets an older version replace a newer one. A retail TV honours it only for a
    // debuggable app; for a release build pm still answers INSTALL_FAILED_VERSION_DOWNGRADE.
    let mut args = vec!["-s", serial.as_str(), "install", "-r"];
    if downgrade.unwrap_or(false) {
        args.push("-d");
    }
    args.push(&apk_path);
    run_adb(&app, &args).await?;
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::derived_name;

    #[test]
    fn derived_name_picks_the_brand() {
        assert_eq!(derived_name("com.netflix.ninja"), "Netflix");
        assert_eq!(derived_name("com.google.android.youtube.tv"), "Youtube");
        assert_eq!(derived_name("com.nordvpn.android"), "Nordvpn");
        assert_eq!(derived_name("il.co.stingtv.atv"), "Stingtv");
        // Nothing but generic segments: the id itself, rather than an empty row.
        assert_eq!(derived_name("tv.android"), "Tv.android");
    }
}
