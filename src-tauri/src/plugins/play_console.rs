//! The store build of an Android TV app: which version Google Play serves, and the APK for it.
//!
//! The APK comes from Play Console rather than the store because the store build is signed with
//! Google's app-signing key, not the upload key our CI signs with — a CI build of the same version
//! is a different package to Android. Play Console keeps a Google-signed universal APK for every
//! release it has generated, reachable through the Play Developer API with a service account.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use regex::Regex;
use rsa::pkcs1v15::SigningKey;
use rsa::pkcs8::DecodePrivateKey;
use rsa::signature::{SignatureEncoding, Signer};
use rsa::RsaPrivateKey;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use tauri::{AppHandle, Manager, Runtime};

use crate::error::Error;

const API: &str = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const SCOPE: &str = "https://www.googleapis.com/auth/androidpublisher";

/// The version name the public Play listing shows, e.g. `1.10.3`, or `None` when the page does
/// not state one ("Varies with device").
#[tauri::command]
pub(crate) async fn play_store_version(package_id: String) -> Result<Option<String>, Error> {
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
    Ok(parse_store_version(&html))
}

/// The listing carries no markup for the version; it sits in the page's embedded data as
/// `[[["1.10.3"]]` — the only triple-nested single string there.
fn parse_store_version(html: &str) -> Option<String> {
    Regex::new(r#"\[\[\["(\d+(?:\.\d+)+)"\]\]"#)
        .unwrap()
        .captures(html)
        .map(|c| c[1].to_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoreApk {
    path: String,
    version_code: i64,
    /// The release name in Play Console, usually the version name.
    release_name: String,
    track: String,
}

#[derive(Deserialize)]
struct ServiceAccount {
    client_email: String,
    private_key: String,
    token_uri: Option<String>,
}

/// Downloads the Google-signed universal APK of the release Play currently serves on the
/// production track. Downloads are cached per version code, so a second install is immediate.
#[tauri::command]
pub(crate) async fn play_download_store_apk<R: Runtime>(
    app: AppHandle<R>,
    key_path: String,
    package_id: String,
) -> Result<StoreApk, Error> {
    let key = std::fs::read_to_string(&key_path)
        .map_err(|e| Error::new(format!("Could not read the Play Console key {key_path}: {e}")))?;
    let account: ServiceAccount = serde_json::from_str(&key)
        .map_err(|e| Error::new(format!("{key_path} is not a service-account JSON key: {e}")))?;
    let client = reqwest::Client::new();
    let token = access_token(&client, &account).await?;

    let (track, release_name, version_code) = live_release(&client, &token, &package_id).await?;

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| Error::new(format!("No cache directory: {e}")))?
        .join("store-apks");
    std::fs::create_dir_all(&dir)?;
    let path: PathBuf = dir.join(format!("{package_id}-{version_code}.apk"));

    if !path.exists() {
        let generated: Value =
            get_json(&client, &token, &format!("{API}/{package_id}/generatedApks/{version_code}")).await?;
        let download_id = generated["generatedApks"]
            .as_array()
            .into_iter()
            .flatten()
            .find_map(|apk| apk["generatedUniversalApk"]["downloadId"].as_str())
            .ok_or_else(|| {
                Error::new(format!(
                    "Play Console has no universal APK for version code {version_code} of {package_id}"
                ))
            })?;
        let bytes = send(
            client
                .get(format!(
                    "{API}/{package_id}/generatedApks/{version_code}/downloads/{download_id}:download"
                ))
                .query(&[("alt", "media")])
                .bearer_auth(&token),
        )
        .await?
        .bytes()
        .await
        .map_err(|e| Error::new(format!("Download of the store APK broke off: {e}")))?;
        // Written under a temporary name so an interrupted download is never mistaken for a
        // cached one.
        let partial = path.with_extension("apk.part");
        std::fs::write(&partial, &bytes)?;
        std::fs::rename(&partial, &path)?;
    }
    log::info!("[Store build] {package_id} {release_name} ({version_code}) from {track}: {}", path.display());

    Ok(StoreApk { path: path.to_string_lossy().into_owned(), version_code, release_name, track })
}

/// The track, release name and version code of the newest release Play is serving — completed,
/// or rolling out. Reading tracks needs an edit; it is deleted again, nothing is committed.
async fn live_release(
    client: &reqwest::Client,
    token: &str,
    package_id: &str,
) -> Result<(String, String, i64), Error> {
    let edit = send(client.post(format!("{API}/{package_id}/edits")).bearer_auth(token).json(&json!({})))
        .await?
        .json::<Value>()
        .await
        .map_err(|e| Error::new(format!("Unexpected Play Console reply: {e}")))?;
    let edit_id = edit["id"].as_str().ok_or_else(|| Error::new("Play Console opened no edit"))?.to_owned();

    let mut found = None;
    // A TV-only app lists its releases on `production`; an app with a dedicated TV form-factor
    // track lists them on `tv:production`.
    for track in ["production", "tv:production"] {
        let Ok(body) = get_json(client, token, &format!("{API}/{package_id}/edits/{edit_id}/tracks/{track}")).await
        else {
            continue;
        };
        found = body["releases"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|r| matches!(r["status"].as_str(), Some("completed" | "inProgress")))
            .flat_map(|r| {
                let name = r["name"].as_str().unwrap_or_default().to_owned();
                r["versionCodes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str().and_then(|s| s.parse::<i64>().ok()).or_else(|| v.as_i64()))
                    .map(move |code| (name.clone(), code))
                    .collect::<Vec<_>>()
            })
            .max_by_key(|(_, code)| *code)
            .map(|(name, code)| (track.to_owned(), name, code));
        if found.is_some() {
            break;
        }
    }

    let _ = client.delete(format!("{API}/{package_id}/edits/{edit_id}")).bearer_auth(token).send().await;
    found.ok_or_else(|| Error::new(format!("{package_id} has no live production release in Play Console")))
}

/// Exchanges a JWT signed with the service account's key for an OAuth access token.
async fn access_token(client: &reqwest::Client, account: &ServiceAccount) -> Result<String, Error> {
    let token_uri = account.token_uri.as_deref().unwrap_or("https://oauth2.googleapis.com/token");
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"RS256","typ":"JWT"}"#);
    let claims = URL_SAFE_NO_PAD.encode(
        json!({"iss": account.client_email, "scope": SCOPE, "aud": token_uri, "iat": now, "exp": now + 3600})
            .to_string(),
    );
    let key = RsaPrivateKey::from_pkcs8_pem(&account.private_key)
        .map_err(|e| Error::new(format!("The Play Console key's private_key is unreadable: {e}")))?;
    let signature = SigningKey::<Sha256>::new(key).sign(format!("{header}.{claims}").as_bytes());
    let jwt = format!("{header}.{claims}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()));

    let body: Value = send(client.post(token_uri).form(&[
        ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
        ("assertion", jwt.as_str()),
    ]))
    .await?
    .json()
    .await
    .map_err(|e| Error::new(format!("Unexpected token reply: {e}")))?;
    body["access_token"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| Error::new("Google returned no access token"))
}

async fn get_json(client: &reqwest::Client, token: &str, url: &str) -> Result<Value, Error> {
    send(client.get(url).bearer_auth(token))
        .await?
        .json()
        .await
        .map_err(|e| Error::new(format!("Unexpected Play Console reply: {e}")))
}

/// Sends a request and turns a non-2xx reply into Google's own error message, which says what
/// is wrong (missing permission, unknown package) far better than the status code does.
async fn send(request: reqwest::RequestBuilder) -> Result<reqwest::Response, Error> {
    let response = request.send().await.map_err(|e| Error::new(format!("Could not reach Google: {e}")))?;
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let body: Value = response.json().await.unwrap_or_default();
    let message = body["error"]["message"]
        .as_str()
        .or_else(|| body["error_description"].as_str())
        .unwrap_or_default();
    Err(Error::new(format!("Google Play API error {status}: {message}")))
}

#[cfg(test)]
mod tests {
    use super::parse_store_version;

    #[test]
    fn reads_the_version_from_the_listing_data() {
        let html = r#"...,null,[[["1.10.3"]],[[[26,"8.0"]]],...[[["Everyone"]]"#;
        assert_eq!(parse_store_version(html).as_deref(), Some("1.10.3"));
        assert_eq!(parse_store_version(r#"[[["Varies with device"]]"#), None);
    }
}
