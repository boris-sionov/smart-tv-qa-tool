use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async_tls_with_config, Connector};

use crate::error::Error;

const REGISTER_MANIFEST: &str = r#"{
  "forcePairing": false,
  "pairingType": "PROMPT",
  "manifest": {
    "manifestVersion": 1,
    "appVersion": "1.1",
    "signed": {
      "created": "20140509",
      "appId": "com.lge.test",
      "vendorId": "com.lge",
      "localizedAppNames": {"": "LG Remote App", "ko-KR": "리모컨 앱", "zxx-XX": "ЛГ Rэмotэ AПП"},
      "localizedVendorNames": {"": "LG Electronics"},
      "permissions": ["TEST_SECURE","CONTROL_INPUT_TEXT","CONTROL_MOUSE_AND_KEYBOARD","READ_INSTALLED_APPS","READ_LGE_SDX","READ_NOTIFICATIONS","SEARCH","WRITE_SETTINGS","WRITE_NOTIFICATION_ALERT","CONTROL_POWER","READ_CURRENT_CHANNEL","READ_RUNNING_APPS","READ_UPDATE_INFO","UPDATE_FROM_REMOTE_APP","READ_LGE_TV_INPUT_EVENTS","READ_TV_CURRENT_TIME"],
      "serial": "2f930e2d2cfe083771f68e4fe7bb07"
    },
    "permissions": ["LAUNCH","LAUNCH_WEBAPP","APP_TO_APP","CLOSE","TEST_OPEN","TEST_PROTECTED","CONTROL_AUDIO","CONTROL_DISPLAY","CONTROL_INPUT_JOYSTICK","CONTROL_INPUT_MEDIA_RECORDING","CONTROL_INPUT_MEDIA_PLAYBACK","CONTROL_INPUT_TV","CONTROL_POWER","READ_APP_STATUS","READ_CURRENT_CHANNEL","READ_INPUT_DEVICE_LIST","READ_NETWORK_STATE","READ_RUNNING_APPS","READ_TV_CHANNEL_LIST","WRITE_NOTIFICATION_TOAST","READ_POWER_STATE","READ_COUNTRY_INFO","READ_SETTINGS"],
    "signatures": [{"signatureVersion": 1, "signature": "eyJhbGdvcml0aG0iOiJSU0EtU0hBMjU2IiwidHlwZSI6IkFHRiJ9.hrVRgjCwXVvE2OOSpDZ58hR+59aFNwYDyjQgKk3auukd7pcegmE2CzPCa0bJ0ZsRAcKkCTJrWo5iDzNhMBWRyaMOv5zWSrthlf7G128qvIlpMT0YNY+n/FaOHE73uLrS/g7swl3/qH/BGFG2Hu4RlL48eb3lLKqTt2xKHdCs6Cd4RMfJPYnzgvI4BNrFUKsjkcu+WD4OO2A27Pq1n50cMchmcaXadJhGrOqH5YmHdOCj5NSHzJYrsW0HPlpuAx/ECMeIZYDh6RMqaFM2DXzdKX9NmmyqzJ3o/0lkk/N97gfVRLW5hA29yeAwaCViZNCP8iC9aO0q9fQojoa7NQnAtw=="}]
  }
}"#;

#[derive(Deserialize)]
struct PressButtonArgs {
    host: String,
    button: String,
    client_key: Option<String>,
}

#[derive(Serialize)]
struct PressButtonResult {
    client_key: Option<String>,
}

#[tauri::command]
async fn press_button(args: PressButtonArgs) -> Result<PressButtonResult, Error> {
    let tls = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()
        .map_err(|e| Error::new(format!("tls build: {e}")))?;
    let connector = Connector::NativeTls(tls);

    let url = format!("wss://{}:3001", args.host);
    let request = url
        .into_client_request()
        .map_err(|e| Error::new(format!("bad url: {e}")))?;

    let (mut ws, _resp) = timeout(
        Duration::from_secs(5),
        connect_async_tls_with_config(request, None, false, Some(connector)),
    )
    .await
    .map_err(|_| Error::new("timeout connecting to TV on :3001"))?
    .map_err(|e| Error::new(format!("ws connect: {e}")))?;

    // Build register payload
    let mut payload: Value = serde_json::from_str(REGISTER_MANIFEST).unwrap();
    if let Some(key) = &args.client_key {
        payload["client-key"] = Value::String(key.clone());
    }
    let register_id = "register_0";
    let register_msg = json!({
        "id": register_id,
        "type": "register",
        "payload": payload
    });
    ws.send(Message::Text(register_msg.to_string()))
        .await
        .map_err(|e| Error::new(format!("send register: {e}")))?;

    // Wait for "registered" (TV prompts user if no client-key)
    let mut new_client_key: Option<String> = None;
    loop {
        let msg = timeout(Duration::from_secs(60), ws.next())
            .await
            .map_err(|_| Error::new("timed out waiting for TV pairing"))?
            .ok_or_else(|| Error::new("ws closed before register"))?
            .map_err(|e| Error::new(format!("ws read: {e}")))?;
        let text = match msg {
            Message::Text(t) => t,
            _ => continue,
        };
        let v: Value = serde_json::from_str(&text)
            .map_err(|e| Error::new(format!("bad register response: {e}")))?;
        let msg_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if v.get("id").and_then(|i| i.as_str()) != Some(register_id) {
            continue;
        }
        match msg_type {
            "registered" => {
                new_client_key = v
                    .pointer("/payload/client-key")
                    .and_then(|k| k.as_str())
                    .map(String::from);
                break;
            }
            "response" => {
                // Server says "PROMPT" — keep waiting
                continue;
            }
            "error" => {
                let err = v
                    .get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("register error");
                return Err(Error::new(err.to_string()));
            }
            _ => continue,
        }
    }

    // Request pointer input socket
    let pointer_id = "getPointer_0";
    ws.send(Message::Text(
        json!({
            "id": pointer_id,
            "type": "request",
            "uri": "ssap://com.webos.service.networkinput/getPointerInputSocket"
        })
        .to_string(),
    ))
    .await
    .map_err(|e| Error::new(format!("send getPointer: {e}")))?;

    let socket_path = loop {
        let msg = timeout(Duration::from_secs(10), ws.next())
            .await
            .map_err(|_| Error::new("timed out waiting for pointer socket"))?
            .ok_or_else(|| Error::new("ws closed before pointer socket"))?
            .map_err(|e| Error::new(format!("ws read: {e}")))?;
        let text = match msg {
            Message::Text(t) => t,
            _ => continue,
        };
        let v: Value = serde_json::from_str(&text)
            .map_err(|e| Error::new(format!("bad pointer response: {e}")))?;
        if v.get("id").and_then(|i| i.as_str()) != Some(pointer_id) {
            continue;
        }
        if let Some(path) = v.pointer("/payload/socketPath").and_then(|p| p.as_str()) {
            break path.to_string();
        }
        return Err(Error::new(
            v.get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("no socketPath in response")
                .to_string(),
        ));
    };

    // Connect to pointer socket and send button
    send_button(&socket_path, &args.button).await?;

    let _ = ws.close(None).await;
    Ok(PressButtonResult {
        client_key: new_client_key.or(args.client_key),
    })
}

async fn send_button(socket_url: &str, button: &str) -> Result<(), Error> {
    let request = socket_url
        .into_client_request()
        .map_err(|e| Error::new(format!("bad pointer url: {e}")))?;

    let tls = native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()
        .map_err(|e| Error::new(format!("tls build: {e}")))?;
    let connector = Connector::NativeTls(tls);

    let (mut ws, _) = timeout(
        Duration::from_secs(5),
        connect_async_tls_with_config(request, None, false, Some(connector)),
    )
    .await
    .map_err(|_| Error::new("timeout connecting to pointer socket"))?
    .map_err(|e| Error::new(format!("pointer connect: {e}")))?;

    let payload = format!("type:button\nname:{}\n\n", button);
    ws.send(Message::Text(payload))
        .await
        .map_err(|e| Error::new(format!("send button: {e}")))?;

    // Small delay to let TV process before closing
    tokio::time::sleep(Duration::from_millis(150)).await;
    let _ = ws.close(None).await;
    Ok(())
}

pub fn plugin<R: Runtime>(name: &'static str) -> TauriPlugin<R> {
    Builder::new(name)
        .invoke_handler(tauri::generate_handler![press_button])
        .build()
}
