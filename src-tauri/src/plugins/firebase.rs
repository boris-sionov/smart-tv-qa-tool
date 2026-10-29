//! Firebase App Distribution — the FreeTV Android TV builds published to the Firebase console. The
//! tool lists an app's releases and downloads one to install, as the library's other tabs do.
//!
//! Sign-in is Google's OAuth flow for installed apps: the system browser opens Google's sign-in
//! page, which redirects to a one-shot listener on `127.0.0.1` with a code that is traded for
//! tokens (PKCE). Google refuses sign-in inside an embedded webview, so it cannot be a popup in
//! the app. The refresh token lives in the OS keychain, next to the Confluence token; the
//! frontend can sign in, check and sign out, never read it back.
//!
//! The OAuth client is a "Desktop app" client in the FreeTV Firebase project, compiled in from
//! `FIREBASE_OAUTH_CLIENT_ID` / `FIREBASE_OAUTH_CLIENT_SECRET`. A build without them says so.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_shell::ShellExt;

use crate::error::Error;

const KEYCHAIN_SERVICE: &str = "com.smarttv.qa-tool";
const KEYCHAIN_ACCOUNT: &str = "firebase-refresh-token";
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const SCOPES: &str = "https://www.googleapis.com/auth/cloud-platform openid email";
const DISTRIBUTION: &str = "https://firebaseappdistribution.googleapis.com/v1";
const MANAGEMENT: &str = "https://firebase.googleapis.com/v1beta1";
/// How long the browser sign-in may take before the listener gives up.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(180);

/// The access token of this run and when it expires; the refresh token stays in the keychain.
static ACCESS: Mutex<Option<(String, Instant)>> = Mutex::new(None);

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    refresh_token: String,
    email: String,
}

fn client() -> Result<(&'static str, &'static str), Error> {
    match (option_env!("FIREBASE_OAUTH_CLIENT_ID"), option_env!("FIREBASE_OAUTH_CLIENT_SECRET")) {
        (Some(id), Some(secret)) if !id.is_empty() => Ok((id, secret)),
        _ => Err(Error::new(
            "Firebase sign-in is not configured in this build — it needs FIREBASE_OAUTH_CLIENT_ID and \
             FIREBASE_OAUTH_CLIENT_SECRET at build time",
        )),
    }
}

fn keychain() -> Result<keyring::Entry, Error> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| Error::new(format!("Keychain is not available: {e}")))
}

fn saved() -> Option<Saved> {
    serde_json::from_str(&keychain().ok()?.get_password().ok()?).ok()
}

fn forget() {
    *ACCESS.lock().unwrap() = None;
    if let Ok(entry) = keychain() {
        let _ = entry.delete_credential();
    }
}

/// The signed-in Google account, or nothing. A saved sign-in Google no longer accepts is dropped.
#[tauri::command]
pub(crate) async fn firebase_account() -> Result<Option<String>, Error> {
    client()?;
    let Some(account) = saved() else { return Ok(None) };
    match access_token().await {
        Ok(_) => Ok(Some(account.email)),
        // A refused refresh token has been forgotten by now: that is "signed out", not an error.
        Err(e) if saved().is_none() => {
            log::info!("[Firebase] Saved sign-in no longer works: {e}");
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

/// Signs in through the system browser and returns the account's email.
#[tauri::command]
pub(crate) async fn firebase_sign_in<R: Runtime>(app: AppHandle<R>) -> Result<String, Error> {
    let (client_id, client_secret) = client()?;
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let redirect = format!("http://127.0.0.1:{}", listener.local_addr()?.port());
    let verifier = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let state = uuid::Uuid::new_v4().simple().to_string();
    let url = auth_url(client_id, &redirect, &challenge(&verifier), &state);

    #[allow(deprecated)]
    app.shell()
        .open(url.as_str(), None)
        .map_err(|e| Error::new(format!("Could not open the browser: {e}")))?;

    let query = tokio::task::spawn_blocking(move || wait_for_redirect(listener))
        .await
        .map_err(|e| Error::new(format!("Sign-in stopped: {e}")))??;
    let params = redirect_params(&query);
    let param = |key: &str| params.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
    if let Some(error) = param("error") {
        return Err(Error::new(format!("Google sign-in did not finish: {error}")));
    }
    if param("state").as_deref() != Some(state.as_str()) {
        return Err(Error::new("Google sign-in answered for another request — try again"));
    }
    let code = param("code").ok_or_else(|| Error::new("Google sign-in returned no code"))?;

    let tokens = token_request(&[
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("code_verifier", &verifier),
        ("redirect_uri", &redirect),
        ("client_id", client_id),
        ("client_secret", client_secret),
    ])
    .await?;
    let refresh_token = tokens["refresh_token"]
        .as_str()
        .ok_or_else(|| Error::new("Google returned no refresh token"))?
        .to_owned();
    let email = tokens["id_token"].as_str().and_then(id_token_email).unwrap_or_else(|| "your account".to_owned());
    keep_access(&tokens);
    let saved = serde_json::to_string(&Saved { refresh_token, email: email.clone() })?;
    keychain()?
        .set_password(&saved)
        .map_err(|e| Error::new(format!("Could not save the sign-in in the keychain: {e}")))?;
    log::info!("[Firebase] Signed in as {email}");
    Ok(email)
}

#[tauri::command]
pub(crate) async fn firebase_sign_out() -> Result<(), Error> {
    if let Some(saved) = saved() {
        let _ = reqwest::Client::new()
            .post("https://oauth2.googleapis.com/revoke")
            .form(&[("token", saved.refresh_token.as_str())])
            .send()
            .await;
    }
    forget();
    Ok(())
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FirebaseApp {
    app_id: String,
    package_name: String,
    display_name: String,
}

/// Every Android app the account can see in Firebase, across its projects.
#[tauri::command]
pub(crate) async fn firebase_apps() -> Result<Vec<FirebaseApp>, Error> {
    let mut apps = Vec::new();
    let mut page_token = String::new();
    loop {
        let body = get(&format!("{MANAGEMENT}/projects/-:searchApps?pageSize=100&pageToken={page_token}")).await?;
        apps.extend(android_apps(&body));
        match body["nextPageToken"].as_str() {
            Some(next) if !next.is_empty() => page_token = next.to_owned(),
            _ => break,
        }
    }
    Ok(apps)
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FirebaseRelease {
    /// `projects/<number>/apps/<appId>/releases/<id>`
    name: String,
    version: String,
    build: String,
    created: String,
    notes: String,
}

/// An app's newest releases, newest first.
#[tauri::command]
pub(crate) async fn firebase_releases(app_id: String) -> Result<Vec<FirebaseRelease>, Error> {
    let project = project_number(&app_id).ok_or_else(|| Error::new(format!("Not a Firebase app id: {app_id}")))?;
    let body = get(&format!("{DISTRIBUTION}/projects/{project}/apps/{app_id}/releases?pageSize=25")).await?;
    Ok(releases(&body))
}

/// Downloads a release's APK into the app cache and returns its path. The release is read again
/// first: its download link is signed and lasts about an hour, so one from the list may be stale.
#[tauri::command]
pub(crate) async fn firebase_fetch<R: Runtime>(app: AppHandle<R>, release_name: String) -> Result<String, Error> {
    if !release_name.starts_with("projects/") || release_name.contains("..") {
        return Err(Error::new(format!("Not a Firebase release: {release_name}")));
    }
    let release = get(&format!("{DISTRIBUTION}/{release_name}")).await?;
    let url = release["binaryDownloadUri"]
        .as_str()
        .ok_or_else(|| Error::new("Firebase offers no download for this release"))?;
    let name = file_name(&release);
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| Error::new(format!("No cache directory: {e}")))?
        .join("firebase");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(&name);
    if !path.exists() {
        let response = reqwest::Client::new()
            .get(url)
            .send()
            .await
            .map_err(|e| Error::new(format!("Could not reach Firebase: {e}")))?;
        if !response.status().is_success() {
            return Err(Error::new(format!("Firebase download answered HTTP {}", response.status().as_u16())));
        }
        let bytes = response.bytes().await.map_err(|e| Error::new(format!("Download of {name} broke off: {e}")))?;
        let partial = dir.join(format!("{name}.part"));
        std::fs::write(&partial, &bytes)?;
        std::fs::rename(&partial, &path)?;
        log::info!("[Firebase] Downloaded {name}");
    }
    Ok(path.to_string_lossy().into_owned())
}

async fn access_token() -> Result<String, Error> {
    if let Some((token, expires)) = ACCESS.lock().unwrap().clone() {
        if Instant::now() + Duration::from_secs(60) < expires {
            return Ok(token);
        }
    }
    let (client_id, client_secret) = client()?;
    let saved = saved().ok_or_else(|| Error::new("Not signed in to Firebase"))?;
    let tokens = token_request(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", &saved.refresh_token),
        ("client_id", client_id),
        ("client_secret", client_secret),
    ])
    .await?;
    Ok(keep_access(&tokens))
}

fn keep_access(tokens: &serde_json::Value) -> String {
    let token = tokens["access_token"].as_str().unwrap_or_default().to_owned();
    let lifetime = Duration::from_secs(tokens["expires_in"].as_u64().unwrap_or(3600));
    *ACCESS.lock().unwrap() = Some((token.clone(), Instant::now() + lifetime));
    token
}

async fn token_request(form: &[(&str, &str)]) -> Result<serde_json::Value, Error> {
    let response = reqwest::Client::new()
        .post(TOKEN_URL)
        .form(form)
        .send()
        .await
        .map_err(|e| Error::new(format!("Could not reach Google: {e}")))?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap_or_default();
    if status.is_success() {
        return Ok(body);
    }
    if body["error"].as_str() == Some("invalid_grant") {
        forget();
        return Err(Error::new("Google no longer accepts the saved sign-in — sign in to Firebase again"));
    }
    Err(Error::new(format!(
        "Google refused the sign-in: {}",
        body["error_description"].as_str().or(body["error"].as_str()).unwrap_or(status.as_str())
    )))
}

async fn get(url: &str) -> Result<serde_json::Value, Error> {
    let token = access_token().await?;
    let response = reqwest::Client::new()
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| Error::new(format!("Could not reach Firebase: {e}")))?;
    let status = response.status().as_u16();
    let body: serde_json::Value = response.json().await.unwrap_or_default();
    match status {
        200..=299 => Ok(body),
        401 => {
            *ACCESS.lock().unwrap() = None;
            Err(Error::new("Firebase refused the sign-in — sign in again"))
        }
        _ => Err(Error::new(format!(
            "Firebase answered HTTP {status}{}",
            body["error"]["message"].as_str().map(|m| format!(": {m}")).unwrap_or_default()
        ))),
    }
}

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn auth_url(client_id: &str, redirect: &str, challenge: &str, state: &str) -> Url {
    Url::parse_with_params(
        AUTH_URL,
        &[
            ("client_id", client_id),
            ("redirect_uri", redirect),
            ("response_type", "code"),
            ("scope", SCOPES),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
            ("state", state),
            // Without these Google returns no refresh token on a second sign-in.
            ("access_type", "offline"),
            ("prompt", "consent"),
        ],
    )
    .expect("static auth URL")
}

/// Waits for the browser's redirect and returns its request line's target, `/?code=…&state=…`.
/// Requests for anything else (a browser's `/favicon.ico`) are answered and skipped.
fn wait_for_redirect(listener: TcpListener) -> Result<String, Error> {
    listener.set_nonblocking(true)?;
    let deadline = Instant::now() + SIGN_IN_TIMEOUT;
    loop {
        let (mut stream, _) = match listener.accept() {
            Ok(accepted) => accepted,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    return Err(Error::new("Google sign-in timed out — finish it in the browser within 3 minutes"));
                }
                std::thread::sleep(Duration::from_millis(200));
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        stream.set_nonblocking(false)?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        let mut buf = [0u8; 4096];
        let n = stream.read(&mut buf).unwrap_or(0);
        let target = request_target(&String::from_utf8_lossy(&buf[..n]));
        let done = target.as_deref().is_some_and(|t| t.starts_with("/?"));
        let page = if done {
            "<html><body style=\"font-family:sans-serif;text-align:center;margin-top:20vh\">\
             <h2>Signed in</h2><p>You can close this tab and go back to Smart TV QA Tool.</p></body></html>"
        } else {
            ""
        };
        let status = if done { "200 OK" } else { "404 Not Found" };
        let _ = write!(
            stream,
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
            page.len()
        );
        if done {
            return Ok(target.unwrap());
        }
    }
}

fn request_target(request: &str) -> Option<String> {
    let mut parts = request.lines().next()?.split_whitespace();
    (parts.next()? == "GET").then(|| parts.next().map(str::to_owned))?
}

fn redirect_params(target: &str) -> Vec<(String, String)> {
    Url::parse(&format!("http://127.0.0.1{target}"))
        .map(|u| u.query_pairs().into_owned().collect())
        .unwrap_or_default()
}

/// The `email` claim of an ID token. Google sent it over TLS straight to us, so it is read without
/// checking the signature.
fn id_token_email(id_token: &str) -> Option<String> {
    let payload = URL_SAFE_NO_PAD.decode(id_token.split('.').nth(1)?).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&payload).ok()?;
    claims["email"].as_str().map(str::to_owned)
}

/// The project number out of an app id, `1:<number>:android:<hash>`.
fn project_number(app_id: &str) -> Option<&str> {
    let number = app_id.split(':').nth(1)?;
    (!number.is_empty() && number.bytes().all(|b| b.is_ascii_digit())).then_some(number)
}

fn android_apps(body: &serde_json::Value) -> Vec<FirebaseApp> {
    body["apps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| a["platform"].as_str() == Some("ANDROID") && a["state"].as_str() != Some("DELETED"))
        .filter_map(|a| {
            let app_id = a["appId"].as_str()?.to_owned();
            let package_name = a["namespace"].as_str().unwrap_or_default().to_owned();
            let display_name = a["displayName"].as_str().filter(|n| !n.is_empty()).unwrap_or(&package_name).to_owned();
            Some(FirebaseApp { app_id, package_name, display_name })
        })
        .collect()
}

fn releases(body: &serde_json::Value) -> Vec<FirebaseRelease> {
    body["releases"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            Some(FirebaseRelease {
                name: r["name"].as_str()?.to_owned(),
                version: r["displayVersion"].as_str().unwrap_or_default().to_owned(),
                build: r["buildVersion"].as_str().unwrap_or_default().to_owned(),
                created: r["createTime"].as_str().unwrap_or_default().to_owned(),
                notes: r["releaseNotes"]["text"].as_str().unwrap_or_default().to_owned(),
            })
        })
        .collect()
}

/// `<version>-(<build>)-<release id>.apk`, with anything unsafe in a file name replaced.
fn file_name(release: &serde_json::Value) -> String {
    let clean = |s: &str| s.chars().map(|c| if c.is_ascii_alphanumeric() || ".-_".contains(c) { c } else { '_' }).collect::<String>();
    let id = release["name"].as_str().unwrap_or_default().rsplit('/').next().unwrap_or_default();
    format!(
        "{}-({})-{}.apk",
        clean(release["displayVersion"].as_str().unwrap_or("release")),
        clean(release["buildVersion"].as_str().unwrap_or_default()),
        clean(id)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_auth_url() {
        // RFC 7636 appendix B.
        assert_eq!(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let url = auth_url("id.apps.googleusercontent.com", "http://127.0.0.1:5000", "ch", "st");
        let params: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        assert!(params.contains(&("redirect_uri".into(), "http://127.0.0.1:5000".into())));
        assert!(params.contains(&("scope".into(), SCOPES.into())));
        assert!(params.contains(&("code_challenge_method".into(), "S256".into())));
    }

    #[test]
    fn reads_the_redirect() {
        let target = request_target("GET /?state=ab&code=4%2F0Ad&scope=email HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
        let params = redirect_params(&target);
        assert!(params.contains(&("code".into(), "4/0Ad".into())));
        assert!(params.contains(&("state".into(), "ab".into())));
        assert_eq!(request_target("POST / HTTP/1.1"), None);
    }

    #[test]
    fn reads_the_id_token_email() {
        let claims = URL_SAFE_NO_PAD.encode(r#"{"email":"qa@freetv.tv","sub":"1"}"#);
        assert_eq!(id_token_email(&format!("h.{claims}.s")).as_deref(), Some("qa@freetv.tv"));
    }

    #[test]
    fn reads_apps_and_releases() {
        let apps = serde_json::json!({"apps": [
            {"appId": "1:123456:android:abc", "displayName": "FreeTV ATV", "platform": "ANDROID", "namespace": "tv.freetv.androidtv", "state": "ACTIVE"},
            {"appId": "1:123456:ios:def", "platform": "IOS", "namespace": "tv.freetv.ios"},
            {"appId": "1:123456:android:old", "platform": "ANDROID", "namespace": "x", "state": "DELETED"}
        ]});
        assert_eq!(android_apps(&apps), [FirebaseApp {
            app_id: "1:123456:android:abc".into(),
            package_name: "tv.freetv.androidtv".into(),
            display_name: "FreeTV ATV".into(),
        }]);
        assert_eq!(project_number("1:123456:android:abc"), Some("123456"));
        assert_eq!(project_number("bad"), None);

        let body = serde_json::json!({"releases": [{
            "name": "projects/123456/apps/1:123456:android:abc/releases/0a1b",
            "displayVersion": "2.1.1", "buildVersion": "26020101", "createTime": "2026-10-20T08:00:00Z",
            "releaseNotes": {"text": "UAT build"}, "binaryDownloadUri": "https://example"
        }]});
        let list = releases(&body);
        assert_eq!(list[0].version, "2.1.1");
        assert_eq!(list[0].notes, "UAT build");
        assert_eq!(file_name(&body["releases"][0]), "2.1.1-(26020101)-0a1b.apk");
    }
}
