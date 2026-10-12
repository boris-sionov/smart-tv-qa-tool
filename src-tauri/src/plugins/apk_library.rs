//! A shared library of APKs QA installs from — store builds saved per version, older releases to
//! downgrade to — kept either in a folder on this Mac (a Google Drive folder synced by Drive for
//! Desktop works) or on a web server that lists its files (nginx `autoindex`, `python3 -m
//! http.server`, Apache).

use std::time::UNIX_EPOCH;

use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_http::reqwest::Url;

use crate::error::Error;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryApk {
    name: String,
    /// A path for a folder library, a URL for a server one — what `apk_library_fetch` takes.
    location: String,
    size: Option<u64>,
    /// As the source states it: a timestamp in ms for a folder, the listing's own text for a server.
    modified: Option<String>,
}

#[tauri::command]
pub(crate) async fn apk_library_list(source: String) -> Result<Vec<LibraryApk>, Error> {
    list_apks(source.trim()).await
}

/// A directory URL without its trailing slash resolves links against its parent.
fn library_url(source: &str) -> Result<Url, Error> {
    Url::parse(&if source.ends_with('/') { source.to_owned() } else { format!("{source}/") })
        .map_err(|e| Error::new(format!("{source} is not a valid URL: {e}")))
}

async fn list_apks(source: &str) -> Result<Vec<LibraryApk>, Error> {
    if is_url(source) {
        let base = library_url(source)?;
        let listing = reqwest::get(base.as_str())
            .await
            .map_err(|e| Error::new(format!("Could not reach {base}: {e}")))?
            .error_for_status()
            .map_err(|e| Error::new(format!("{base} did not return a file list: {e}")))?
            .text()
            .await
            .map_err(|e| Error::new(format!("Could not read the file list at {base}: {e}")))?;
        return Ok(parse_json_listing(&base, &listing).unwrap_or_else(|| parse_listing(&base, &listing)));
    }

    let entries = std::fs::read_dir(source)
        .map_err(|e| Error::new(format!("Could not open the folder {source}: {e}")))?;
    Ok(entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().to_lowercase().ends_with(".apk"))
        .map(|e| {
            let meta = e.metadata().ok();
            LibraryApk {
                name: e.file_name().to_string_lossy().into_owned(),
                location: e.path().to_string_lossy().into_owned(),
                size: meta.as_ref().map(|m| m.len()),
                modified: meta
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis().to_string()),
            }
        })
        .collect())
}

/// The local path of a library APK, downloading it first when it lives on a server.
#[tauri::command]
pub(crate) async fn apk_library_fetch<R: Runtime>(app: AppHandle<R>, location: String) -> Result<String, Error> {
    if !is_url(&location) {
        return Ok(location);
    }
    let url = Url::parse(&location).map_err(|e| Error::new(format!("{location} is not a valid URL: {e}")))?;
    let name = url
        .path_segments()
        .and_then(|mut s| s.next_back())
        .map(percent_decode)
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "library.apk".to_owned());
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| Error::new(format!("No cache directory: {e}")))?
        .join("apk-library");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(&name);

    let bytes = reqwest::get(url.as_str())
        .await
        .map_err(|e| Error::new(format!("Could not download {name}: {e}")))?
        .error_for_status()
        .map_err(|e| Error::new(format!("Could not download {name}: {e}")))?
        .bytes()
        .await
        .map_err(|e| Error::new(format!("Download of {name} broke off: {e}")))?;
    std::fs::write(&path, &bytes)?;
    log::info!("[APK library] Downloaded {url} → {}", path.display());
    Ok(path.to_string_lossy().into_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApkManifest {
    package_id: String,
    version_name: Option<String>,
}

/// The package id and version an APK declares — the id so a refused downgrade knows which app to
/// uninstall, the version to name an upload by.
#[tauri::command]
pub(crate) async fn apk_manifest(path: String) -> Result<ApkManifest, Error> {
    let file = std::fs::File::open(&path)?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| Error::new(format!("{path} is not an APK: {e}")))?;
    let mut manifest = Vec::new();
    std::io::Read::read_to_end(
        &mut zip
            .by_name("AndroidManifest.xml")
            .map_err(|e| Error::new(format!("{path} has no manifest: {e}")))?,
        &mut manifest,
    )?;
    let attrs = manifest_attributes(&manifest);
    let attr = |name: &str| attrs.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone());
    Ok(ApkManifest {
        package_id: attr("package").ok_or_else(|| Error::new(format!("Could not read the package id of {path}")))?,
        version_name: attr("versionName"),
    })
}

/// The string attributes of `<manifest>` in a compiled (binary XML) manifest: the string pool
/// first, then the first start-element chunk, which is `<manifest>`. An attribute set from a
/// resource rather than a literal (`@string/…`) has no raw string and is left out.
fn manifest_attributes(axml: &[u8]) -> Vec<(String, String)> {
    manifest_attributes_opt(axml).unwrap_or_default()
}

fn manifest_attributes_opt(axml: &[u8]) -> Option<Vec<(String, String)>> {
    let u16_at = |o: usize| axml.get(o..o + 2).map(|b| u16::from_le_bytes([b[0], b[1]]));
    let u32_at = |o: usize| axml.get(o..o + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));

    let mut strings: Vec<String> = Vec::new();
    let mut chunk = u16_at(2)? as usize; // past the file header
    while chunk + 8 <= axml.len() {
        let (kind, header, size) = (u16_at(chunk)?, u16_at(chunk + 2)? as usize, u32_at(chunk + 4)? as usize);
        match kind {
            0x0001 => {
                let count = u32_at(chunk + 8)? as usize;
                let utf8 = u32_at(chunk + 16)? & (1 << 8) != 0;
                let data = chunk + u32_at(chunk + 20)? as usize;
                for i in 0..count {
                    let mut o = data + u32_at(chunk + header + i * 4)? as usize;
                    let text = if utf8 {
                        // UTF-16 length, then UTF-8 length; each one or two bytes.
                        for _ in 0..2 {
                            o += if *axml.get(o)? & 0x80 != 0 { 2 } else { 1 };
                        }
                        let end = axml[o..].iter().position(|&b| b == 0)? + o;
                        String::from_utf8_lossy(&axml[o..end]).into_owned()
                    } else {
                        let mut len = u16_at(o)? as usize;
                        o += 2;
                        if len & 0x8000 != 0 {
                            len = ((len & 0x7fff) << 16) | u16_at(o)? as usize;
                            o += 2;
                        }
                        let units: Vec<u16> = (0..len).filter_map(|k| u16_at(o + k * 2)).collect();
                        String::from_utf16_lossy(&units)
                    };
                    strings.push(text);
                }
            }
            0x0102 => {
                let attrs = chunk + header + u16_at(chunk + header + 8)? as usize;
                let attr_size = u16_at(chunk + header + 10)? as usize;
                let mut found = Vec::new();
                for k in 0..u16_at(chunk + header + 12)? as usize {
                    let a = attrs + k * attr_size;
                    let name = strings.get(u32_at(a + 4)? as usize);
                    let value = strings.get(u32_at(a + 8)? as usize);
                    if let (Some(name), Some(value)) = (name, value) {
                        found.push((name.clone(), value.clone()));
                    }
                }
                return Some(found);
            }
            _ => {}
        }
        if size == 0 {
            return None;
        }
        chunk += size;
    }
    None
}

/// Adds an APK on this Mac to the library under `name`. A name already there is refused with
/// "already in the library" unless `overwrite`.
#[tauri::command]
pub(crate) async fn apk_library_upload(source: String, path: String, name: String, overwrite: bool) -> Result<(), Error> {
    let source = source.trim();
    let bytes = std::fs::read(&path).map_err(|e| Error::new(format!("Could not read {path}: {e}")))?;
    if !is_url(source) {
        let target = std::path::Path::new(source).join(&name);
        if target.exists() && !overwrite {
            return Err(Error::new(format!("{name} is already in the library")));
        }
        std::fs::write(&target, &bytes)?;
        return Ok(());
    }
    let url = library_url(source)?.join(&name).map_err(|e| Error::new(format!("Bad file name {name}: {e}")))?;
    let response = reqwest::Client::new()
        .put(url.as_str())
        .query(&[("overwrite", if overwrite { "1" } else { "0" })])
        .body(bytes)
        .send()
        .await
        .map_err(|e| Error::new(format!("Could not upload {name}: {e}")))?;
    match response.status().as_u16() {
        200..=299 => Ok(()),
        409 => Err(Error::new(format!("{name} is already in the library"))),
        405 | 501 => Err(Error::new("This library server does not take uploads")),
        status => Err(Error::new(format!("Upload of {name} failed: HTTP {status}"))),
    }
}

/// What the public Play listing shows now: the version and its "Updated on" date.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlayListing {
    version: Option<String>,
    updated: Option<i64>,
}

#[tauri::command]
pub(crate) async fn play_store_listing(package_id: String) -> Result<PlayListing, Error> {
    let url = format!("https://play.google.com/store/apps/details?id={package_id}&hl=en&gl=IL");
    let html = reqwest::Client::new()
        .get(url)
        .header("User-Agent", "Mozilla/5.0")
        .send()
        .await
        .map_err(|e| Error::new(format!("Could not reach Google Play: {e}")))?
        .error_for_status()
        .map_err(|e| Error::new(format!("Google Play did not return the listing: {e}")))?
        .text()
        .await
        .map_err(|e| Error::new(format!("Could not read the Google Play listing: {e}")))?;
    Ok(parse_play_listing(&html))
}

/// Neither value has markup on the listing; both sit in its embedded data — the version as
/// `[[["1.10.3"]]`, the update date as `[["Jul 27, 2026",[1785141668,…` with the unix time
/// beside the display text.
fn parse_play_listing(html: &str) -> PlayListing {
    let version = Regex::new(r#"\[\[\["(\d+(?:\.\d+)+)"\]\]"#).unwrap().captures(html).map(|c| c[1].to_owned());
    let updated = Regex::new(r#"\[\["[A-Z][a-z]{2} \d{1,2}, \d{4}",\[(\d{9,11}),"#)
        .unwrap()
        .captures_iter(html)
        .filter_map(|c| c[1].parse::<i64>().ok())
        .max();
    PlayListing { version, updated }
}

/// nginx's `autoindex_format json` — also what our own library server returns:
/// `[{"name", "type", "mtime", "size"}]`. `None` when the page is not JSON.
fn parse_json_listing(base: &Url, body: &str) -> Option<Vec<LibraryApk>> {
    let entries: Vec<serde_json::Value> = serde_json::from_str(body).ok()?;
    Some(
        entries
            .iter()
            .filter(|e| e["type"].as_str() != Some("directory"))
            .filter_map(|e| {
                let name = e["name"].as_str()?;
                if !name.to_lowercase().ends_with(".apk") {
                    return None;
                }
                Some(LibraryApk {
                    name: name.to_owned(),
                    location: base.join(name).ok()?.to_string(),
                    size: e["size"].as_u64(),
                    modified: e["mtime"].as_str().map(str::to_owned),
                })
            })
            .collect(),
    )
}

/// Whether Tailscale is up on this Mac — `freetv-server` is reached through it, so a library
/// that does not answer is most often just Tailscale being off. `missing` when there is no CLI.
#[tauri::command]
pub(crate) async fn tailscale_state() -> Result<String, Error> {
    let cli = [
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
        "/usr/bin/tailscale",
        "C:\\Program Files\\Tailscale\\tailscale.exe",
    ]
    .into_iter()
    .find(|p| std::path::Path::new(p).exists());
    let Some(cli) = cli else { return Ok("missing".into()) };
    let output = std::process::Command::new(cli)
        .args(["status", "--json"])
        .output()
        .map_err(|e| Error::new(format!("Could not run Tailscale: {e}")))?;
    let status: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap_or_default();
    Ok(match status["BackendState"].as_str() {
        Some("Running") => "running",
        Some("NeedsLogin") => "needs-login",
        _ => "stopped",
    }
    .into())
}

/// Opens the Tailscale app so it can be switched on.
#[tauri::command]
pub(crate) async fn tailscale_open() -> Result<(), Error> {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").args(["-a", "Tailscale"]).status();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd").args(["/C", "start", "", "tailscale-ipn"]).status();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result: std::io::Result<std::process::ExitStatus> =
        Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "run `tailscale up`"));
    result.map(|_| ()).map_err(|e| Error::new(format!("Could not open Tailscale: {e}")))
}

fn is_url(source: &str) -> bool {
    source.starts_with("http://") || source.starts_with("https://")
}

/// The `.apk` links on a server's directory page. nginx's and Apache's pages print the date and
/// size after each link, and those are picked up when present; `python3 -m http.server` prints
/// neither.
fn parse_listing(base: &Url, html: &str) -> Vec<LibraryApk> {
    let link = Regex::new(r#"(?i)href="([^"?#]+\.apk)"[^>]*>[^<]*</a>([^<\n]*)"#).unwrap();
    let details = Regex::new(r"^\s*(\S+\s+\S+)\s+(\d+)\s*$").unwrap();
    let mut seen = std::collections::HashSet::new();
    link.captures_iter(html)
        .filter_map(|c| {
            let url = base.join(&c[1]).ok()?;
            let name = url.path_segments()?.next_back().map(percent_decode)?;
            if !seen.insert(url.to_string()) {
                return None;
            }
            let after = details.captures(&c[2]);
            Some(LibraryApk {
                name,
                location: url.to_string(),
                size: after.as_ref().and_then(|d| d[2].parse().ok()),
                modified: after.map(|d| d[1].to_owned()),
            })
        })
        .collect()
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(b) = u8::from_str_radix(hex, 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run against a real APK: `APK=/path/to/app.apk cargo test -p devman reads_a_real_manifest -- --ignored`
    #[test]
    #[ignore]
    fn reads_a_real_manifest() {
        let path = std::env::var("APK").unwrap();
        let m = tauri::async_runtime::block_on(apk_manifest(path)).unwrap();
        println!("package = {} version = {:?}", m.package_id, m.version_name);
        assert!(m.package_id.contains('.'));
    }

    #[test]
    fn reads_an_nginx_autoindex_page() {
        let base = Url::parse("http://10.0.0.5/freetv/").unwrap();
        let html = r#"<pre><a href="../">../</a>
<a href="FreeTV-1.10.3.apk">FreeTV-1.10.3.apk</a>                                  12-Oct-2026 09:14            26703206
<a href="FreeTV%201.9.0.apk">FreeTV 1.9.0.apk</a>                                   01-Sep-2026 17:02            25110000
<a href="notes.txt">notes.txt</a>                                          01-Sep-2026 17:02                 12
</pre>"#;
        let apks = parse_listing(&base, html);
        assert_eq!(apks.len(), 2);
        assert_eq!(apks[0].name, "FreeTV-1.10.3.apk");
        assert_eq!(apks[0].location, "http://10.0.0.5/freetv/FreeTV-1.10.3.apk");
        assert_eq!(apks[0].size, Some(26703206));
        assert_eq!(apks[0].modified.as_deref(), Some("12-Oct-2026 09:14"));
        assert_eq!(apks[1].name, "FreeTV 1.9.0.apk");
    }

    #[test]
    fn reads_the_play_listing_data() {
        let html = r#"…,[[["1.10.3"]],…app faster. "]],[["Jul 27, 2026",[1785141668,115000000]]…"#;
        let listing = parse_play_listing(html);
        assert_eq!(listing.version.as_deref(), Some("1.10.3"));
        assert_eq!(listing.updated, Some(1785141668));
    }

    #[test]
    fn reads_a_json_listing() {
        let base = Url::parse("http://freetv-server:8090/").unwrap();
        let body = r#"[{"name":"tv.freetv.androidtv-1.10.3.apk","type":"file","size":26703206,"mtime":"Mon, 12 Oct 2026 09:14:00 GMT"},
                      {"name":"notes.txt","type":"file","size":10,"mtime":""}]"#;
        let apks = parse_json_listing(&base, body).unwrap();
        assert_eq!(apks.len(), 1);
        assert_eq!(apks[0].location, "http://freetv-server:8090/tv.freetv.androidtv-1.10.3.apk");
        assert_eq!(apks[0].size, Some(26703206));
        assert!(parse_json_listing(&base, "<html>").is_none());
    }

    #[test]
    fn reads_a_python_http_server_page() {
        let base = Url::parse("http://10.0.0.5:8000/").unwrap();
        let html = r#"<ul>
<li><a href="FreeTV-2.1.1.apk">FreeTV-2.1.1.apk</a></li>
</ul>"#;
        let apks = parse_listing(&base, html);
        assert_eq!(apks.len(), 1);
        assert_eq!(apks[0].location, "http://10.0.0.5:8000/FreeTV-2.1.1.apk");
        assert_eq!(apks[0].size, None);
    }
}
