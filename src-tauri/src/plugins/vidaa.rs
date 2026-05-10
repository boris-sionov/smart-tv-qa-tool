use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{plugin::Builder, Runtime};
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VidaaDeviceInfo {
    #[serde(rename = "Browser", default)]
    pub browser: String,
    #[serde(rename = "Protocol-Version", default)]
    pub protocol_version: String,
    #[serde(rename = "User-Agent", default)]
    pub user_agent: String,
    #[serde(rename = "WebKit-Version", default)]
    pub webkit_version: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VidaaCdpPage {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: String,
    #[serde(rename = "type", default)]
    pub page_type: String,
    #[serde(rename = "webSocketDebuggerUrl", default)]
    pub ws_debugger_url: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct VidaaApp {
    #[serde(rename = "Id", default)]
    pub id: String,
    #[serde(rename = "AppName", default)]
    pub app_name: String,
    #[serde(rename = "URL", default)]
    pub url: String,
    #[serde(rename = "IconURL", default)]
    pub icon_url: String,
    #[serde(rename = "InstallTime", default)]
    pub install_time: String,
}

type CmdResult<T> = Result<T, String>;

async fn cdp_evaluate(ws_url: &str, expression: &str) -> CmdResult<Value> {
    let (ws_stream, _) = connect_async(ws_url)
        .await
        .map_err(|e| format!("WebSocket connect failed: {}", e))?;
    let (mut write, mut read) = ws_stream.split();

    let cmd = json!({
        "id": 1,
        "method": "Runtime.evaluate",
        "params": {
            "expression": expression,
            "awaitPromise": true,
            "returnByValue": true,
            "timeout": 12000
        }
    });
    write
        .send(Message::Text(cmd.to_string()))
        .await
        .map_err(|e| format!("WebSocket send failed: {}", e))?;

    let result = timeout(Duration::from_secs(15), async {
        while let Some(msg) = read.next().await {
            if let Ok(Message::Text(text)) = msg {
                if let Ok(resp) = serde_json::from_str::<Value>(&text) {
                    if resp.get("id").and_then(|v| v.as_i64()) == Some(1) {
                        if let Some(ex) = resp["result"].get("exceptionDetails") {
                            let msg = ex["exception"]["description"]
                                .as_str()
                                .or_else(|| ex["text"].as_str())
                                .unwrap_or("Unknown exception");
                            return Err(msg.to_string());
                        }
                        return Ok(resp["result"]["result"]["value"].clone());
                    }
                }
            }
        }
        Err("CDP WebSocket closed unexpectedly".to_string())
    })
    .await
    .map_err(|_| "CDP evaluate timed out".to_string())?;

    result
}

async fn find_devkit_page(ip: &str) -> CmdResult<String> {
    let pages = list_cdp_pages(ip).await?;
    let page = pages
        .iter()
        .filter(|p| p.page_type == "page" && !p.ws_debugger_url.is_empty())
        .find(|p| {
            p.title.to_lowercase().contains("devkit")
                || p.url.to_lowercase().contains("devkit")
                || p.url.starts_with("file://")
        })
        .or_else(|| {
            pages
                .iter()
                .find(|p| p.page_type == "page" && !p.ws_debugger_url.is_empty())
        });

    match page {
        Some(p) => Ok(p.ws_debugger_url.clone()),
        None => Err(
            "No open page found on TV. Open DevKit → App Manager on your TV first.".to_string(),
        ),
    }
}

async fn list_cdp_pages(ip: &str) -> CmdResult<Vec<VidaaCdpPage>> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(format!("http://{}:9226/json", ip))
        .send()
        .await
        .map_err(|e| format!("Cannot reach TV at {}:9226 — {}", ip, e))?;
    resp.json::<Vec<VidaaCdpPage>>()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_device_info(ip: String) -> CmdResult<VidaaDeviceInfo> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(format!("http://{}:9226/json/version", ip))
        .send()
        .await
        .map_err(|e| format!("Cannot reach TV at {}:9226 — {}", ip, e))?;
    resp.json::<VidaaDeviceInfo>()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_pages(ip: String) -> CmdResult<Vec<VidaaCdpPage>> {
    list_cdp_pages(&ip).await
}

#[tauri::command]
async fn list_apps(ip: String) -> CmdResult<Vec<VidaaApp>> {
    let ws_url = find_devkit_page(&ip).await?;
    let expr = r#"
        new Promise(function(resolve, reject) {
            try {
                if (typeof HiUtils_createRequest !== 'undefined') {
                    HiUtils_createRequest('fileRead', {path: 'websdk/Appinfo.json', mode: 6}, function(r) {
                        try {
                            var data = JSON.parse(r.readdata || '{"apps":[]}');
                            resolve(data.apps || []);
                        } catch(e) { resolve([]); }
                    });
                } else {
                    resolve([]);
                }
            } catch(e) { resolve([]); }
        })
    "#;
    let val = cdp_evaluate(&ws_url, expr).await?;
    serde_json::from_value::<Vec<VidaaApp>>(val).map_err(|e| e.to_string())
}

#[tauri::command]
async fn install_app(ip: String, app_url: String, name: String, app_id: String) -> CmdResult<()> {
    let ws_url = find_devkit_page(&ip).await?;

    let app_id_js = serde_json::to_string(&app_id).unwrap_or_default();
    let name_js = serde_json::to_string(&name).unwrap_or_default();
    let url_js = serde_json::to_string(&app_url).unwrap_or_default();
    let today = chrono_today();

    let expr = format!(
        r#"
        (function() {{
            var appId = {app_id_js};
            var appName = {name_js};
            var appUrl = {url_js};
            var today = "{today}";
            return new Promise(function(resolve, reject) {{
                try {{
                    if (typeof Hisense_installApp !== 'undefined') {{
                        Hisense_installApp(appId, appName, '', '', '', appUrl, '0', function(r) {{
                            if (r === 0) resolve(true);
                            else reject(new Error('Install failed, code: ' + r));
                        }});
                    }} else if (typeof HiUtils_createRequest !== 'undefined') {{
                        HiUtils_createRequest('fileRead', {{path: 'websdk/Appinfo.json', mode: 6}}, function(r) {{
                            try {{
                                var data = JSON.parse(r.readdata || '{{"apps":[]}}');
                                var apps = data.apps || [];
                                var idx = apps.findIndex(function(a) {{ return a.Id === appId; }});
                                var entry = {{
                                    Id: appId, AppName: appName, URL: appUrl,
                                    IconURL: '', InstallTime: today, RunTimes: 0, Type: 'Browser'
                                }};
                                if (idx >= 0) apps[idx] = entry; else apps.push(entry);
                                data.apps = apps;
                                HiUtils_createRequest('fileWrite', {{
                                    path: 'websdk/Appinfo.json', mode: 6,
                                    writedata: JSON.stringify(data)
                                }}, function() {{ resolve(true); }});
                            }} catch(e) {{ reject(new Error(String(e))); }}
                        }});
                    }} else {{
                        reject(new Error('Hisense install API not available. Open DevKit App Manager on your TV.'));
                    }}
                }} catch(e) {{ reject(new Error(String(e))); }}
            }});
        }})()
    "#
    );

    cdp_evaluate(&ws_url, &expr).await?;
    Ok(())
}

#[tauri::command]
async fn uninstall_app(ip: String, app_id: String) -> CmdResult<()> {
    let ws_url = find_devkit_page(&ip).await?;

    let app_id_js = serde_json::to_string(&app_id).unwrap_or_default();

    let expr = format!(
        r#"
        (function() {{
            var appId = {app_id_js};
            return new Promise(function(resolve, reject) {{
                try {{
                    if (typeof Hisense_uninstallApp !== 'undefined') {{
                        Hisense_uninstallApp(appId, function(ok) {{
                            if (ok) resolve(true);
                            else reject(new Error('Uninstall failed'));
                        }});
                    }} else if (typeof HiUtils_createRequest !== 'undefined') {{
                        HiUtils_createRequest('fileRead', {{path: 'websdk/Appinfo.json', mode: 6}}, function(r) {{
                            try {{
                                var data = JSON.parse(r.readdata || '{{"apps":[]}}');
                                data.apps = (data.apps || []).filter(function(a) {{ return a.Id !== appId; }});
                                HiUtils_createRequest('fileWrite', {{
                                    path: 'websdk/Appinfo.json', mode: 6,
                                    writedata: JSON.stringify(data)
                                }}, function() {{ resolve(true); }});
                            }} catch(e) {{ reject(new Error(String(e))); }}
                        }});
                    }} else {{
                        reject(new Error('Hisense uninstall API not available. Open DevKit App Manager on your TV.'));
                    }}
                }} catch(e) {{ reject(new Error(String(e))); }}
            }});
        }})()
    "#
    );

    cdp_evaluate(&ws_url, &expr).await?;
    Ok(())
}

fn chrono_today() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = secs / 86400;
    // Days since epoch → YYYY-MM-DD (rough calculation)
    let year = 1970 + days / 365;
    let day_of_year = days % 365;
    let month = (day_of_year / 30).min(11) + 1;
    let day = day_of_year % 30 + 1;
    format!("{:04}-{:02}-{:02}", year, month, day)
}

pub fn plugin<R: Runtime>(name: &'static str) -> tauri::plugin::TauriPlugin<R> {
    Builder::new(name)
        .invoke_handler(tauri::generate_handler![
            get_device_info,
            get_pages,
            list_apps,
            install_app,
            uninstall_app,
        ])
        .build()
}
