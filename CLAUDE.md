# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

# Smart TV QA Tool — v1.0.0

A unified Tauri 2 (Rust backend) + Angular 18 desktop application for managing apps across Samsung Tizen, Android TV, and LG WebOS Smart TVs.

---

## Commands

```bash
# First-time setup — downloads ADB and SDB binaries into src-tauri/binaries/
npm run setup           # macOS/Linux
npm run setup:win       # Windows (PowerShell)

# Development
npm run start           # Tauri dev server with Angular hot-reload (port 4281)
npm run build           # Production build

# Angular CLI — use npm run ng, NOT npx ng (wrapper sets required Tauri env vars)
npm run ng -- generate component foo
npm run ng -- test                              # all unit tests (Karma + Jasmine)
npm run ng -- test --include='**/foo.spec.ts'  # single spec file
```

**Build outputs:**
- macOS: `src-tauri/target/release/bundle/dmg/Smart TV QA Tool_1.0.0_x64.dmg`
- Windows: `.../msi/Smart_TV_QA_Tool_1.0.0_x64.msi`
- Linux: `.../deb/smart-tv-qa-tool_1.0.0_amd64.deb`

---

## Architecture

### Two Parallel Architectures (Important)

The codebase is mid-migration. **Android TV and Tizen** use the new `DeviceProvider` abstraction. **LG WebOS** still uses the original SSH-based architecture from the upstream `webosbrew/dev-manager-desktop` fork and is NOT wired into `DeviceProviderFactory`.

```
Angular UI
    │
    ├── DeviceProviderFactory.get(platform)   ← android-tv, tizen only
    │       ├── AdbService   → invoke('plugin:adb-manager|adb_*')   → Rust → ADB sidecar binary
    │       └── SdbService   → invoke('plugin:adb-manager|tizen_*') → Rust → SDB/tizen CLI
    │
    └── LG WebOS (old arch, NOT in factory)
            ├── DeviceManager    ← SSH device store + key management
            ├── SessionManager   ← SSH connection pool (r2d2 + libssh-rs)
            ├── RemoteCommandService / RemoteLunaService / RemoteShellService
            └── Rust plugins: remote-command, remote-shell, remote-file, dev-mode, lg-remote
```

**Key insight about the Rust plugin:** Both ADB (Android TV) and Tizen SDB commands live in `src-tauri/src/plugins/samsung_tizen.rs`, which is registered in `lib.rs` as `plugin("adb-manager")`. The file `src-tauri/src/plugins/adb.rs` is a helper module imported by `samsung_tizen.rs`, not a separate registered plugin. All calls from Angular to either ADB or Tizen go through `invoke('plugin:adb-manager|...')`.

### Route Structure

```
/                   → PlatformSelectorModule  (lazy)
/lg                 → LgComponent (eager) + lazy child modules:
    apps / files / terminal / debug / info / devices
/android-tv         → AndroidTvModule  (lazy)
/tizen              → TizenModule      (lazy)
```

Each platform module owns its own `devices/`, `apps/`, and `info/` sub-routes.

### DeviceProvider Interface

`src/app/core/models/device-provider.interface.ts`

```typescript
type Platform = 'android-tv' | 'tizen' | 'webos';  // vidaa not in type yet

interface DeviceProvider {
    readonly platform: Platform;
    connect(host: string, port?: number): Promise<string>;
    disconnect(serial: string): Promise<void>;
    listConnectedDevices(): Promise<PlatformDevice[]>;
    listApps(serial: string): Promise<PlatformApp[]>;
    getAppIcon(serial: string, appId: string): Promise<string | null>;
    launchApp(serial: string, appId: string): Promise<void>;
    killApp(serial: string, appId: string): Promise<void>;
    installApp(serial: string, filePath: string): Promise<void>;
    uninstallApp(serial: string, appId: string): Promise<void>;
    getDeviceInfo(serial: string): Promise<DeviceInfo>;
    openPackageChooser(): Promise<string | null>;
}
```

Resolve providers via `DeviceProviderFactory.get(platform)` — never import `AdbService` or `SdbService` directly in UI components.

### Service Base Classes

All Angular services that call Rust extend `BackendClient` (`src/app/core/services/backend-client.ts`). It wraps `invoke()` with `NgZone.run()` re-entry (so Tauri promise resolutions trigger Angular CD) and normalises Rust errors into typed `BackendError` / `IOError` / `ExecutionError`.

```typescript
class MyService extends BackendClient {
    constructor(zone: NgZone) { super(zone, 'adb-manager'); }
    doSomething() { return this.invoke<string>('some_command', {arg: 'value'}); }
}
```

For bidirectional streaming (PTY, log tails) use `EventChannel` (`src/app/core/event-channel.ts`). The Rust side opens a channel token; events flow via `token:rx` / `token:tx` / `token:closed` Tauri events. Used by `RemoteShellService` for WebOS PTY shells.

### Device State Persistence

Android TV and Tizen device lists are stored in `localStorage` (not a Tauri store or file). State services:
- `TizenStateService` — keys `smart-tv-qa-tizen-devices`, `smart-tv-qa-tizen-selected-device`, `smart-tv-qa-tizen-studio-path`, `smart-tv-qa-tizen-cert-profile`
- `AdbStateService` — keys `freetv-android-tv-devices`, `freetv-android-tv-selected-device`

`AdbStateService` wipes device state on first launch per app installation (guarded by `adb-state-initialized` flag). This is the "Persistent device state" open work item — the intent is to keep state across reinstalls.

LG WebOS devices are stored in `~/.webos/ose/novacom-devices.json` (macOS/Linux) or `%APPDATA%\.webos\ose\` (Windows) — a legacy path from the webosbrew fork. The `DeviceManager` clears this file once on first run (`.initialized` marker) to drop stale entries from the fork.

### Unified Logging

`DeviceLogService` (`src/app/core/services/device-log.service.ts`) provides a platform-neutral log stream with parsers:
- `parseAndroidLogcat(raw, deviceId)` for `adb logcat`
- `parseTizenDlog(raw, deviceId)` for `sdb dlog`

---

## Platform Details

### Samsung Tizen (SDB)
- **Connection:** TCP port 26101, certificate-based auth (no PIN after first connect)
- **App format:** WGT / TPK
- **Commands:** user-installed `sdb` + `tizen` CLIs, orchestrated from Rust via `adb-manager` plugin

#### Signed WGT Install Flow (Critical — `tizen_install_signed` in Rust)
The CI build double-packages WGTs: files appear at root (unsigned) AND inside `.buildResult/` (signed). The TV rejects unsigned WGTs with error `[118, -12]`.

Pipeline:
1. Repack — strip root entries, keep only `.buildResult/` content
2. Sign — `tizen package -t wgt -s <profile>`
3. `sdb disconnect <ip>:26101` — TV daemon releases session
4. `sdb kill-server` — drops local daemon + any TizenBrew reverse tunnel
5. Wait 1200ms
6. `sdb connect <ip>:26101` — retry up to 4×, 1.5s apart
7. `tizen install -n file.wgt -s <ip>:26101`
8. `sdb disconnect` — cleanup

`sdb disconnect` must come before `kill-server`: `kill-server` only kills the Mac-side daemon; the TV still holds its session. `sdb disconnect` sends a proper teardown so the TV releases the port.

#### Stress Test / CDP
- Launch via `sdb.debug(serial, tizenId)` — launches the app AND returns the CDP port. Never call `debug()` again after waiting — it restarts the app.
- Tizen's `/json` returns `ws://localhost:PORT/...` — rewrite `localhost` to the actual TV IP before connecting the WebSocket.
- Verification selector: `h1.metadata__title`.

#### TizenBrew-Compatible Commands (vd_* protocol)

| Operation | Standard | TizenBrew |
|-----------|----------|-----------|
| Install | `tz install -p <file> -e <serial>` | `sdb push` + `shell 0 vd_appinstall <id> <path>` |
| List apps | `sdb shell 0 applist` | `sdb shell 0 vd_applist` |
| Launch | `sdb shell 0 execute <id>` | `sdb shell 0 was_execute <id>` |
| Debug | `sdb shell 0 debug <id>` | `sdb shell 0 debug <tizenId> 0` |
| Uninstall | `sdb uninstall <id>` | `sdb shell 0 vd_appuninstall <id>` |

#### Known FreeTV App IDs (Tizen)
- **Preprod:** `kY6012WvBv.FreeTVpreprod`

### Android TV (ADB)
- **Connection:** TCP port 5555, no auth after developer mode
- **App format:** APK
- **Commands:** bundled ADB sidecar binary, orchestrated from Rust via `adb-manager` plugin
- **`getAppIcon`** is still in TypeScript (APK icon extraction) — planned migration to Rust + zip crate

### LG WebOS (Luna API)
- **Connection:** SSH port 22 / 9922, Ed25519 key auth
- **App format:** IPK
- **Architecture:** SSH connection pool (`conn_pool/`, `session_manager/`) via `libssh-rs`; Luna service calls over SSH; PTY shells via `shell_manager/`
- **Status:** Fully functional; planned migration to `DeviceProvider` interface

### VIDAA TV (Hisense) — Planned
- **Connection:** MQTT-over-TLS port 36669, credentials `hisenseservice` / `multimqttservice`
- **Plan:** Rust MQTT client (`rumqttc` crate), `VidaaProvider` implementing `DeviceProvider`

---

## Progress Dialog Step List

`src/app/shared/components/progress-dialog/progress-dialog.component.ts`

```typescript
dialog.setSteps([{key: 'step1', label: 'Step One'}, ...]);
dialog.update(message, percent, stepKey);  // advances active step
dialog.fail(stepKey);                      // marks step red ✕
```

Step states: `pending` → `active` (spinner) → `done` (✓) → `failed` (✕).

---

## Design System

Glassmorphism dark theme. CSS custom properties:
- Background: `#0F172B`, Primary: `#5B9FF5`, Danger: `#FF6B6B`, Success: `#4ADE80`
- Text: `#FFFFFF` / `#A8B8CC` (secondary)
- Blur effects, 12–20px rounded corners, smooth transitions

---

## Open Work

| Priority | Item | Notes |
|----------|------|-------|
| Now | Fix Samsung Tizen Info tab | Branch: `fix-samsung-info`; reads `/etc/info.ini` |
| Now | VIDAA TV MQTT support | Research done; implement `VidaaProvider` |
| Soon | LG WebOS into `DeviceProviderFactory` | Wrap existing SSH services in `WebOSProvider` |
| Later | Persistent device state | Stop wiping on startup |
| Later | Mac .dmg distribution build | |

---

## Code Origins

- **LG WebOS:** Forked from [`webosbrew/dev-manager-desktop`](https://github.com/webosbrew/dev-manager-desktop) — kept SSH pool, Luna service, PTY; added stress test, Inspect, dark theme
- **Samsung Tizen:** Built from scratch; reverse-engineered TizenBrew's `vd_*` protocol
- **Android TV:** Ported from internal Python/PySide6 tool; ADB calls moved to Rust

**Last Updated:** June 24, 2026 | **Version:** 1.0.0
