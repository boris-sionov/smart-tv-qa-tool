//! The release pages on Redge's Confluence — "Releases Android TV" and "Releases Smart TV" in the
//! KRS space — where every UAT, PROD/PREPROD and debug build is published as one table row per
//! version. The tool reads the newest row and installs from it.
//!
//! Confluence Data Center wants a Personal Access Token. It lives in the OS keychain (macOS
//! Keychain, Windows Credential Manager) and never in a file or `localStorage`; the frontend can
//! save, check and forget it, never read it back.

use regex::Regex;
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::error::Error;

const BASE: &str = "https://confluence.redge.com";
const SPACE: &str = "KRS";
const KEYCHAIN_SERVICE: &str = "com.smarttv.qa-tool";
const KEYCHAIN_ACCOUNT: &str = "confluence-token";

fn keychain() -> Result<keyring::Entry, Error> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| Error::new(format!("Keychain is not available: {e}")))
}

fn token() -> Result<String, Error> {
    keychain()?
        .get_password()
        .map_err(|_| Error::new("No Confluence token saved — add one in the library dialog"))
}

#[tauri::command]
pub(crate) async fn confluence_token_saved() -> Result<bool, Error> {
    Ok(keychain()?.get_password().is_ok())
}

/// Checks the token against Confluence and, when it works, saves it in the keychain. Returns the
/// name of the account it belongs to.
#[tauri::command]
pub(crate) async fn confluence_save_token(token: String) -> Result<String, Error> {
    let token = token.trim().to_owned();
    if token.is_empty() {
        return Err(Error::new("The token is empty"));
    }
    let user: serde_json::Value = get(&token, &format!("{BASE}/rest/api/user/current"))
        .await?
        .json()
        .await
        .map_err(|e| Error::new(format!("Unexpected Confluence reply: {e}")))?;
    if user["type"].as_str() == Some("anonymous") {
        // Confluence answers an unknown token as an anonymous visitor rather than with a 401.
        return Err(Error::new(
            "Confluence did not accept this token. It has to be made in Confluence itself — a Jira token \
             does not work here: confluence.redge.com → your avatar → Profile → Personal Access Tokens.",
        ));
    }
    keychain()?
        .set_password(&token)
        .map_err(|e| Error::new(format!("Could not save the token in the keychain: {e}")))?;
    Ok(user["displayName"].as_str().or(user["username"].as_str()).unwrap_or("you").to_owned())
}

#[tauri::command]
pub(crate) async fn confluence_forget_token() -> Result<(), Error> {
    let _ = keychain()?.delete_credential();
    Ok(())
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReleaseFile {
    name: String,
    url: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Release {
    version: String,
    date: String,
    files: Vec<ReleaseFile>,
}

/// Every release row of a page, newest version first: version, release day and the files linked
/// in it. Not just the top row — a release does not always carry a build for every TV (1.28.2 on
/// "Releases Smart TV" has Samsung but no LG), so the caller takes the newest row that has one.
#[tauri::command]
pub(crate) async fn confluence_releases(title: String) -> Result<Vec<Release>, Error> {
    let token = token()?;
    let response = authed(&token, reqwest::Client::new().get(format!("{BASE}/rest/api/content")).query(&[
        ("spaceKey", SPACE),
        ("title", title.as_str()),
        ("expand", "body.storage"),
    ]))
    .await?;
    let body: serde_json::Value =
        response.json().await.map_err(|e| Error::new(format!("Unexpected Confluence reply: {e}")))?;
    let result = &body["results"][0];
    let page_id = result["id"].as_str().ok_or_else(|| Error::new(format!("No Confluence page \"{title}\" in {SPACE}")))?;
    let storage = result["body"]["storage"]["value"].as_str().unwrap_or_default();
    let releases = release_rows(storage, page_id);
    if releases.is_empty() {
        return Err(Error::new(format!("\"{title}\" has no release table")));
    }
    Ok(releases)
}

/// Downloads a file from Confluence into the app cache and returns its path. Release files carry
/// their version in the name, so one already downloaded is reused.
#[tauri::command]
pub(crate) async fn confluence_fetch<R: Runtime>(app: AppHandle<R>, url: String, name: String) -> Result<String, Error> {
    if name.contains('/') || name.contains('\\') || name.starts_with('.') {
        return Err(Error::new(format!("Bad file name {name}")));
    }
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| Error::new(format!("No cache directory: {e}")))?
        .join("confluence");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(&name);
    if !path.exists() {
        let bytes = get(&token()?, &url)
            .await?
            .bytes()
            .await
            .map_err(|e| Error::new(format!("Download of {name} broke off: {e}")))?;
        let partial = dir.join(format!("{name}.part"));
        std::fs::write(&partial, &bytes)?;
        std::fs::rename(&partial, &path)?;
        log::info!("[Confluence] Downloaded {name}");
    }
    Ok(path.to_string_lossy().into_owned())
}

async fn get(token: &str, url: &str) -> Result<reqwest::Response, Error> {
    authed(token, reqwest::Client::new().get(url)).await
}

async fn authed(token: &str, request: reqwest::RequestBuilder) -> Result<reqwest::Response, Error> {
    let response = request
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| Error::new(format!("Could not reach Confluence: {e}")))?;
    match response.status().as_u16() {
        200..=299 => Ok(response),
        401 | 403 => Err(Error::new("Confluence refused the token — it may have expired; save a new one")),
        status => Err(Error::new(format!("Confluence answered HTTP {status}"))),
    }
}

/// The release rows, highest version first. A row's first cell is the version and its second the
/// release day; files are attachments (`<ri:attachment ri:filename>`) or plain links to a build.
fn release_rows(storage: &str, page_id: &str) -> Vec<Release> {
    let row = Regex::new(r"(?s)<tr[^>]*>(.*?)</tr>").unwrap();
    let cell = Regex::new(r"(?s)<t[dh][^>]*>(.*?)</t[dh]>").unwrap();
    let version = Regex::new(r"^\d+(?:\.\d+)+").unwrap();
    let attachment = Regex::new(r#"ri:filename="([^"]+)""#).unwrap();
    let link = Regex::new(r#"(?i)href="([^"]+\.(?:apk|wgt|tpk|ipk|zip|rar)(?:\?[^"]*)?)""#).unwrap();
    let datetime = Regex::new(r#"datetime="([^"]+)""#).unwrap();

    let mut releases: Vec<Release> = row
        .captures_iter(storage)
        .filter_map(|r| {
            let cells: Vec<&str> = cell.captures_iter(&r[1]).map(|c| c.get(1).unwrap().as_str()).collect();
            let ver = version.find(&text(cells.first()?))?.as_str().to_owned();
            let date_cell = cells.get(1).copied().unwrap_or_default();
            let date = datetime
                .captures(date_cell)
                .map(|c| c[1].to_owned())
                .unwrap_or_else(|| text(date_cell));
            let mut files: Vec<ReleaseFile> = attachment
                .captures_iter(&r[1])
                .map(|c| {
                    let name = unescape(&c[1]);
                    let url = format!("{BASE}/download/attachments/{page_id}/{}?api=v2", encode(&name));
                    ReleaseFile { name, url }
                })
                .collect();
            for c in link.captures_iter(&r[1]) {
                let href = unescape(&c[1]);
                let url = if href.starts_with('/') { format!("{BASE}{href}") } else { href };
                let name = url.rsplit('/').next().unwrap_or_default().split('?').next().unwrap_or_default();
                let name = percent_decode(name);
                if !files.iter().any(|f| f.name == name) {
                    files.push(ReleaseFile { name, url });
                }
            }
            Some(Release { version: ver, date, files })
        })
        .collect();
    releases.sort_by(|a, b| compare_versions(&b.version, &a.version));
    releases
}

fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let parts = |v: &str| v.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    parts(a).cmp(&parts(b))
}

/// A cell's text, tags removed.
fn text(html: &str) -> String {
    let tags = Regex::new(r"<[^>]+>").unwrap();
    unescape(tags.replace_all(html, " ").split_whitespace().collect::<Vec<_>>().join(" ").as_str())
}

fn unescape(s: &str) -> String {
    s.replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">")
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16) {
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

    const ANDROID_PAGE: &str = r#"<table><tbody>
<tr><th><p>Version</p></th><th><p>Release day</p></th><th><p>UAT File</p></th><th><p>PROD Files</p></th><th><p>Notes</p></th></tr>
<tr><td><p>2.0.0</p></td><td><p><time datetime="2026-09-28" /></p></td>
  <td><p><ac:link><ri:attachment ri:filename="redge-media-portal-atv-nodebugTesting-FreeTVUat-local_build-2.0.0_26020000-release_26020000.apk" /></ac:link></p></td>
  <td><p><ac:link><ri:attachment ri:filename="app-keshet-prod-release(26020000).aab" /></ac:link></p></td><td></td></tr>
<tr><td><p>2.1.1</p></td><td><p>2026-10-09</p></td>
  <td><p><ac:link><ri:attachment ri:filename="redge-media-portal-atv-nodebugTesting-FreeTVUat-local_build-2.1.1_26020101-release_26020101.apk" /></ac:link></p>
      <p><ac:link><ri:attachment ri:filename="redge-media-portal-atv-debugTesting-FreeTVUat-local_build-2.1.1_26020101-release_26020101.apk" /></ac:link></p></td>
  <td><p><a href="/download/attachments/123/redge-media-portal-atv-release-FreeTVProd-local_build-2.1.1_26020101-release_26020101.apk?api=v2">x</a></p></td><td></td></tr>
<tr><td><p>1.15.0</p></td><td><p>2026-09-18</p></td><td></td><td></td><td></td></tr>
</tbody></table>"#;

    #[test]
    fn reads_the_newest_row() {
        let rows = release_rows(ANDROID_PAGE, "555");
        assert_eq!(rows.iter().map(|r| r.version.as_str()).collect::<Vec<_>>(), ["2.1.1", "2.0.0", "1.15.0"]);
        let release = &rows[0];
        assert_eq!(release.version, "2.1.1");
        assert_eq!(release.date, "2026-10-09");
        assert_eq!(release.files.len(), 3);
        assert_eq!(
            release.files[0].url,
            "https://confluence.redge.com/download/attachments/555/redge-media-portal-atv-nodebugTesting-FreeTVUat-local_build-2.1.1_26020101-release_26020101.apk?api=v2"
        );
        assert_eq!(release.files[2].name, "redge-media-portal-atv-release-FreeTVProd-local_build-2.1.1_26020101-release_26020101.apk");
        assert!(release.files[2].url.starts_with("https://confluence.redge.com/download/attachments/123/"));
    }

    #[test]
    fn reads_a_time_macro_date() {
        let page = ANDROID_PAGE.replace("<tr><td><p>2.1.1</p>", "<tr><td><p>1.0.0</p>");
        let release = &release_rows(&page, "555")[0];
        assert_eq!(release.version, "2.0.0");
        assert_eq!(release.date, "2026-09-28");
    }

    #[test]
    fn encodes_attachment_names() {
        assert_eq!(encode("app-keshet-prod-release(26020000).aab"), "app-keshet-prod-release%2826020000%29.aab");
    }
}
