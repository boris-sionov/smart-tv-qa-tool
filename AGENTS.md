# Smart TV QA Tool — Agent & Developer Reference

## What This Project Is

A **unified Tauri + Angular desktop application** for QA engineers managing apps across multiple Smart TV platforms from one tool.

**Platforms supported:**
| Platform | Status | Protocol |
|----------|--------|----------|
| Samsung Tizen | ✅ Full — install, launch, kill, inspect, stress test | SDB + tz CLI |
| Android TV | ✅ Full — install, launch, kill, device info | ADB (Rust sidecar) |
| LG WebOS | ✅ Working — install, launch, kill, inspect, stress test | SSH + Luna API |
| VIDAA (Hisense) | ⏳ Research done, ready to implement | MQTT-over-TLS |

---

## Code Origins

### LG WebOS
**Forked from:** [`webosbrew/dev-manager-desktop`](https://github.com/webosbrew/dev-manager-desktop)
- Open-source Tauri + Angular LG developer manager
- We kept: SSH connection pooling, Luna service layer, device manager, SFTP, shell/PTY infrastructure
- We added: FreeTV/Smart TV branding, stress test, Inspect shortcut, custom dark theme, unified platform selector

### Samsung Tizen
**Built from scratch** using:
- Samsung's official `sdb` (Smart Development Bridge) CLI — analogous to ADB
- Samsung's `tz` / `tizen` CLI — for signing and installing WGT packages
- Reverse-engineered TizenBrew's `vd_*` protocol for sideloading

### Android TV
**Ported from:** `/PycharmProjects/AndroidQATool` (internal Python/PySide6 tool)
- ADB logic (~300 lines Python) translated to Rust in `src-tauri/src/plugins/adb.rs`
- UI rebuilt in Angular with the unified design system

---

## Current Architecture

```
Angular UI
    │
    ▼ invoke()
Tauri Rust Backend
    ├── adb.rs          ← Android TV: ADB sidecar binary
    ├── samsung_tizen.rs ← Samsung: SDB + tz CLI orchestration
    ├── lg_remote.rs    ← LG: remote control commands
    ├── cmd.rs          ← LG: SSH remote exec
    ├── shell.rs        ← LG: SSH PTY shells
    └── file.rs         ← LG: SFTP file ops
```

**Key principle:** UI never calls platform CLIs directly — everything goes through Tauri `invoke()` to Rust, which calls the tools.

---

## What Was Built (June 2026 Session)

### Samsung Tizen — Signed WGT Install
The build system produces double-packaged WGTs with files at both root (unsigned) and `.buildResult/` (signed). TV rejects the unsigned root with `[118, -12]`.

**Pipeline in `samsung_tizen.rs → tizen_install_signed`:**
1. **Repack** — strip root duplicates, keep only `.buildResult/` content, remove old signatures
2. **Sign** — `tizen package -t wgt -s <profile>` (no device needed)
3. **Graceful disconnect** — `sdb disconnect <ip>:26101` tells TV daemon to release session
4. **Kill server** — `sdb kill-server` drops TizenBrew reverse tunnel
5. **Wait 1.2s** — TV port needs time to free
6. **Connect with retry** — `sdb connect` up to 4 attempts, 1.5s apart
7. **Install** — `tizen install -n file.wgt -s <ip>:26101`
8. **Disconnect** — cleanup

**Key insight:** TizenBrew creates a reverse tunnel (TV→Mac). `kill-server` alone only kills the Mac side — the TV still holds the session. Must `sdb disconnect` first for the TV to release the port immediately.

### Progress Dialog — Visual Step List
`src/app/shared/components/progress-dialog/`

Replaced bare progress bar with a step list during long operations:
- `○` pending (dimmed) → `⟳` active (spinning blue) → `✓` done (green) → `✕` failed (red)
- API: `dialog.setSteps([...])` then `dialog.update(msg, pct, stepKey)`

### Samsung Tizen — Stress Test
In `src/app/tizen/apps/tizen-apps.component.ts`:
- **Stress button** next to Inspect on each app
- Each cycle: launch via `sdb.debug()` (gets CDP port without restart) → wait 30s → WebSocket CDP eval for `h1.metadata__title` → kill → wait 10s
- Results table: cycle, Live/VOD badge, title, channel, action buttons, FOUND/MISSING

**Two critical fixes discovered:**
1. Must call `sdb.debug()` at launch time (not after waiting) — `debug` restarts the app
2. Tizen's `webSocketDebuggerUrl` uses `localhost` — must rewrite to TV's IP before WebSocket connect

### Other Fixes
- LG WebOS app buttons: fixed wrapping (5 buttons: Inspect/Launch/Kill/Stress/Remove stayed on one row by switching from `grid` with hardcoded 4 columns to `flex`)
- Dead code removed: `extract-icons.ts`, `samsung-tizen.service.ts`, `permissions/vidaa/`, `permissions/samsung-tizen/`, `icon.png` (root), `scripts/generate-lg-badge-previews.js`
- Workspace file renamed: `FreeTV-QA-Tool.code-workspace` → `Smart-TV-QA-Tool.code-workspace`
- `.gitignore` updated: added `*.wgt`, `*.apk`, `.history/`, session notes

---

## Planned / In Progress

### 🔴 Fix Samsung Tizen Info Tab (branch: `fix-samsung-info`)
The Info tab for Samsung TV shows incorrect or missing device information. Reads from `/etc/info.ini` via `tizen_get_device_info` Rust command.

**To investigate:**
- What fields are being returned vs. what's displayed
- Whether the `TizenInfoEntry` parsing is correct
- Whether the UI component maps fields properly

### 🔴 VIDAA TV — MQTT Implementation
**Connection:** `192.168.x.x:36669` over MQTT-TLS
**Credentials:** `hisenseservice` / `multimqttservice`
**References:**
- https://github.com/tombabolewski/vidaa-control
- https://github.com/tombabolewski/ha-vidaa-tv

**Plan:**
1. Add `rumqttc` crate to `Cargo.toml`
2. Create `src-tauri/src/plugins/vidaa.rs` with MQTT connect/subscribe/publish
3. Add Tauri commands: `vidaa_connect`, `vidaa_list_apps`, `vidaa_launch`, `vidaa_kill`
4. Create `VidaaProvider` in TypeScript implementing `DeviceProvider`
5. Register in `DeviceProviderFactory` and platform selector

### 🟡 Screenshot from Samsung TV
Two approaches:
- **SDB shell** (full screen): `sdb shell 0 screencapture /tmp/screen.png` + `sdb pull` — not supported on all firmware
- **CDP** (web app only): `Page.captureScreenshot` via existing debug port infrastructure — works on any debug build

### 🟡 LG WebOS Provider Integration
Create `WebOSProvider` that wraps existing `RemoteLunaService` and `RemoteCommandService`, register in `DeviceProviderFactory` so LG goes through the same abstraction as Tizen/ATV.

---

## Key Conventions

### Serial Format
- Tizen: `<ip>:26101` (e.g. `192.168.50.180:26101`)
- Android TV: `<ip>:5555`
- `tizenSerial(device)` helper builds this from a `TizenDevice` object

### App ID Fields (Tizen)
- `app.runtimeId || app.id` — use for `launch` and `kill`
- `app.tizenId` — use for `debug` and `inspect` (format: `kY6012WvBv.FreeTVpreprod`)

### DeviceProviderFactory
Never import `SdbService`, `AdbService`, etc. directly in UI components. Always use:
```typescript
const provider = DeviceProviderFactory.get('tizen');
```

### Tauri Commands
All platform operations use `invoke('plugin:adb-manager|<command>', {...})`. The plugin name `adb-manager` covers both ADB and Tizen SDB commands (legacy naming).

### .gitignore Rules
- `*.wgt`, `*.apk`, `*.tpk`, `*.ipk` — never commit build packages
- `.history/` — VS Code local history plugin
- `SESSION_SUMMARY_*.md` — session notes

---

## Known FreeTV App IDs

| Platform | Environment | App ID |
|----------|-------------|--------|
| Tizen | Preprod | `kY6012WvBv.FreeTVpreprod` |
| Tizen | UAT | TBD (`kY6012WvBv.FreeTVuat`?) |
| LG | Preprod | `tv.freetv.portal.preprod` |
| LG | UAT | `tv.freetv.portal.uat` |
| Android TV | Preprod | `tv.freetv.androidtv` (check package name) |

---

**Last Updated:** June 2, 2026
