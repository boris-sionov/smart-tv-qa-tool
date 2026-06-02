# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

# Smart TV QA Tool — v1.0.0

A **unified Tauri + Angular desktop application** for managing apps across multiple Smart TV platforms.

---

## Commands

```bash
# First-time setup (downloads ADB and SDB binaries into src-tauri/binaries/)
npm run setup           # macOS/Linux
npm run setup:win       # Windows (PowerShell)

# Development
npm run start           # Tauri dev server with Angular hot-reload
npm run build           # Production build

# Angular CLI (via wrapper that sets Tauri env vars)
npm run ng -- generate component foo
npm run ng -- test      # run unit tests (Karma + Jasmine)
npm run ng -- test --include='**/foo.spec.ts'  # single spec file
```

> **Note:** Use `npm run ng` instead of `npx ng` — the wrapper script sets required environment variables for the Tauri context.

---

## Code Origins

### LG WebOS
- **Source:** Forked and adapted from [`webosbrew/dev-manager-desktop`](https://github.com/webosbrew/dev-manager-desktop) — an open-source Tauri+Angular LG developer tool
- **What we kept:** SSH connection pool, Luna API service layer, device manager, shell/PTY infrastructure
- **What we added:** FreeTV app filtering, stress test (launch/kill cycles + CDP verification), Inspect button, custom dark theme

### Samsung Tizen
- **Source:** Built from scratch using Samsung's official SDB (Smart Development Bridge) CLI + `tz` CLI tools
- **Protocol reference:** Reverse-engineered TizenBrew's `vd_*` shell commands for sideloading without Tizen Studio
- **Key discovery:** TizenBrew creates a reverse TCP tunnel (TV→Mac), which must be gracefully disconnected before a fresh `sdb connect` will succeed
- **WGT signing:** Build system produces double-packaged WGTs (`.buildResult/` + root duplicates); we repack in Rust before signing

### Android TV
- **Source:** Ported from an in-house Python/PySide6 tool (`/PycharmProjects/AndroidQATool`)
- **What changed:** ADB calls moved to Rust (`src-tauri/src/plugins/adb.rs`) via a bundled ADB sidecar binary; UI rewritten in Angular matching the unified design system

---

## Project Status (June 2026)

### ✅ COMPLETED
- [x] App renamed from "FreeTV QA Tool" to "Smart TV QA Tool"
- [x] Modern dark theme design system (glassmorphism)
- [x] Android TV ADB service fully functional (Rust plugin + bundled sidecar)
- [x] Samsung Tizen SDB service — full device/app management, certificates, inspect/debug
- [x] Samsung Tizen — **Signed WGT install flow**: repack double-packaged WGTs → sign with `tz` CLI → graceful `sdb disconnect` + `kill-server` → retry `sdb connect` (4 attempts) → `tizen install`
- [x] Samsung Tizen — **Stress test**: launch via `sdb debug` (gets CDP port) → wait → WebSocket CDP eval for `h1.metadata__title` → kill → repeat
- [x] Samsung Tizen Inspect — `sdb shell 0 debug` → parse port → open Chrome DevTools
- [x] **Progress dialog step list** — visual step-by-step UI with spinner/✓/✕ per step
- [x] Platform selector UI
- [x] **Platform Abstraction Layer** — `DeviceProvider` interface, `DeviceProviderFactory`
- [x] **Rust ADB Orchestration** — `adb-manager` Tauri plugin; multi-step ops run in Rust
- [x] **Unified Logging Schema** — `DeviceLogService` with logcat / dlog parsers
- [x] LG WebOS stress test — launch/kill cycles with CDP verification
- [x] LG WebOS — app buttons layout fixed (flex, no wrap)
- [x] Codebase cleanup — removed dead code, WGT build artifacts, `.history/`, unused permissions

### 🔄 IN PROGRESS / NEXT
- [ ] **Fix Samsung Tizen Info tab** — device info display has issues (branch: `fix-samsung-info`)
- [ ] VIDAA TV support (MQTT-over-TLS) — research complete, ready to implement
- [ ] LG WebOS full provider integration into `DeviceProviderFactory`

### ⏳ PLANNED — FUTURE ARCHITECTURE
- [ ] **VIDAA TV** — Rust MQTT client over TLS port 36669, `VidaaProvider` implementing `DeviceProvider`
- [ ] **Plugin-based architecture** — provider registry for adding new platforms without core changes
- [ ] **Persistent device state** — stop wiping on startup; add manual "Reset" actions
- [ ] **Vendor API resilience** — monitoring strategy as Samsung/LG update SDKs
- [ ] Mac distributable build (.dmg)

---

## Architecture

### Layer Model

```
┌──────────────────────────────────────────────────────────┐
│  Angular UI  (platform-selector, device management, apps) │
└────────────────────┬─────────────────────────────────────┘
                     │ DeviceProvider interface
        ┌────────────┴─────────────┐
        │  DeviceProviderFactory   │  ← selects correct provider per platform
        └────────────┬─────────────┘
     ┌───────────────┼──────────────┐
     ▼               ▼              ▼
AdbService       SdbService    (future providers)
(android-tv)      (tizen)       vidaa / webos
     │               │
     ▼               ▼
Rust adb-manager  Rust samsung_tizen    Rust / SSH
plugin (invoke)   plugin (invoke)       (libssh_rs)
     │
     ▼
bundled ADB binary (sidecar)
```

### DeviceProvider Interface

All platform services implement `DeviceProvider`:

```typescript
interface DeviceProvider {
    readonly platform: Platform;                         // 'android-tv' | 'tizen' | 'vidaa' | 'webos'
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

Use `DeviceProviderFactory.get(platform)` to resolve the correct provider at runtime — never import platform services directly in UI components.

### Rust Orchestration (adb-manager plugin)

All ADB and Tizen SDB operations go through Tauri invoke:
```
Angular invoke('plugin:adb-manager|<command>') → Rust → bundled ADB/SDB sidecar
```

**ADB commands in Rust:** `adb_list_devices`, `adb_connect`, `adb_disconnect`, `adb_list_packages`, `adb_get_prop`, `adb_launch`, `adb_force_stop`, `adb_uninstall`, `adb_install`.

**Tizen commands in Rust:** `tizen_connect`, `tizen_list_apps`, `tizen_launch`, `tizen_kill`, `tizen_debug`, `tizen_install`, `tizen_install_signed` (full repack→sign→connect→install pipeline), `tizen_detect_studio`, `tizen_get_device_info`, and more.

**Still in TypeScript:** `getAppIcon` (Python-based APK icon extraction — move to Rust + zip crate in the future).

### Unified Logging

`DeviceLogService` provides a platform-neutral log stream:

```typescript
interface DeviceLog {
    id: string;           // UUID
    deviceId: string;     // device serial
    platform: LogPlatform; // 'android-tv' | 'tizen' | 'vidaa' | 'webos'
    application?: string;
    timestamp: Date;
    level: LogLevel;      // 'verbose' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
    tag?: string;
    message: string;
    raw?: string;
}
```

Parsers: `parseAndroidLogcat(raw, deviceId)` for `adb logcat`, `parseTizenDlog(raw, deviceId)` for `sdb dlog`.

---

## Platform Details

### Android TV (ADB)
- **Connection:** TCP/IP port 5555
- **Auth:** None (after developer mode enabled)
- **Packages:** APK format
- **Commands:** via bundled ADB sidecar → Rust adb-manager plugin
- **Status:** ✅ Feature-complete
- **Code origin:** Ported from `/PycharmProjects/AndroidQATool` (Python/PySide6)

### Samsung Tizen (SDB)
- **Connection:** TCP/IP port 26101
- **Auth:** Certificate-based (no PIN after first connect)
- **Packages:** WGT / TPK format
- **Commands:** SDB CLI (user-installed via Tizen Extension or Tizen Studio), orchestrated from Rust
- **Status:** ✅ Implemented
- **Code origin:** Built from scratch

#### Tizen Implementation Status

| Feature | Status | Notes |
|---------|--------|-------|
| Device connection (SDB) | ✅ Done | `sdb connect <ip>:26101` |
| List connected devices | ✅ Done | `sdb devices` |
| List installed apps | ✅ Done | Multiple fallback commands (applist, pkgcmd, vd_applist) |
| Install WGT/TPK (basic) | ✅ Done | Via `tz install` (modern CLI) |
| Signed WGT install | ✅ Done | Repack → sign → disconnect/kill-server → retry connect → `tizen install` |
| Launch app | ✅ Done | `was_execute` with fallback to `execute` |
| Kill app | ✅ Done | `sdb shell 0 execute 0 kill <appId>` |
| Inspect / Debug app | ✅ Done | `sdb shell 0 debug <appId>` → parse port → open browser |
| Stress test (CDP) | ✅ Done | Debug launch → wait → CDP eval `h1.metadata__title` → kill → repeat |
| Device info | ⚠️ Needs fix | Reads `/etc/info.ini` — display has issues |
| Certificate wizard | ✅ Done | Browse `~/SamsungCertificate`, derive profile from folder name |
| Profile management | ✅ Done | Create, set active, delete profiles |
| Device DUID | ✅ Done | For retail TV signing |
| Log parsing (dlog) | ✅ Done | `parseTizenDlog()` in DeviceLogService |
| Add device wizard | ✅ Done | Two-step wizard with dev mode instructions |
| Uninstall app | ✅ Done | `sdb uninstall` with pkgcmd fallback |
| UserWidget (USB) install | N/A | Manual: copy WGT to `userwidget/` folder on USB |

#### Known FreeTV App IDs (Tizen)
- **Preprod:** `kY6012WvBv.FreeTVpreprod`
- **UAT:** TBD (check `kY6012WvBv.FreeTVuat` or similar)

#### Key Tizen Commands
```bash
sdb shell 0 execute <app-id>          # launch
sdb shell 0 execute 0 kill <app-id>   # kill
sdb shell 0 debug <app-id>            # launch in debug mode → returns inspector port
tizen install -n file.wgt -s <ip>:26101  # CLI install
sdb duid                              # get device DUID for certificate
```

#### Signed WGT Install Flow (Critical)
The build system double-packages WGTs: files exist at root (unsigned) AND inside `.buildResult/` (signed). TV rejects unsigned with error `[118, -12]`.

**Pipeline (all in Rust `tizen_install_signed`):**
1. Repack — strip root entries, keep only `.buildResult/` content
2. Sign — `tizen package -t wgt -s <profile>`
3. `sdb disconnect <ip>:26101` — graceful disconnect so TV daemon releases session
4. `sdb kill-server` — drop local daemon + TizenBrew reverse tunnel
5. Wait 1200ms
6. `sdb connect <ip>:26101` — retry up to 4×, 1.5s apart
7. `tizen install -n file.wgt -s <ip>:26101`
8. `sdb disconnect` — cleanup

**Why disconnect before kill-server:** `kill-server` only kills the Mac side. The TV SDB daemon still holds the session. `sdb disconnect` sends a proper teardown so the TV releases the port immediately.

#### Stress Test / CDP Check
- Launch via `sdb.debug(serial, tizenId)` — this both launches the app AND returns the CDP port. **Never call `debug()` after waiting** — it restarts the app.
- Tizen's `/json` returns `ws://localhost:PORT/...` — must rewrite to actual TV IP before connecting WebSocket.
- Selector: `h1.metadata__title` — also reads channel name, Live/VOD type, action buttons.

#### TizenBrew-Compatible Commands (vd_* protocol)

| Operation | Standard (tz CLI) | TizenBrew (vd_* protocol) |
|-----------|-------------------|---------------------------|
| Install | `tz install -p <file> -e <serial>` | `sdb push` + `shell 0 vd_appinstall <id> <path>` |
| List apps | `sdb shell 0 applist` | `sdb shell 0 vd_applist` (includes version, app_index) |
| Launch | `sdb shell 0 execute <id>` | `sdb shell 0 was_execute <id>` |
| Debug | `sdb shell 0 debug <id>` | `sdb shell 0 debug <tizenId> 0` |
| Uninstall | `sdb uninstall <id>` | `sdb shell 0 vd_appuninstall <id>` |

### VIDAA TV (MQTT) — Planned
- **Connection:** MQTT-over-TLS port 36669
- **Credentials:** `hisenseservice` / `multimqttservice`
- **Status:** ⏳ Research complete, ready to implement
- **Reference:** [vidaa-control](https://github.com/tombabolewski/vidaa-control), [ha-vidaa-tv](https://github.com/tombabolewski/ha-vidaa-tv)
- **Plan:** Rust MQTT client (e.g. `rumqttc` crate), `VidaaProvider` implementing `DeviceProvider`

### LG WebOS (Luna API)
- **Connection:** SSH port 22 / 9922
- **Auth:** RSA key (Ed25519)
- **Status:** ✅ Working (stress test, inspect, install, launch, kill)
- **Code origin:** Adapted from [`webosbrew/dev-manager-desktop`](https://github.com/webosbrew/dev-manager-desktop)
- **Plan:** Wrap existing `RemoteLunaService` / `RemoteCommandService` in `WebOSProvider`

---

## Progress Dialog Step List

`src/app/shared/components/progress-dialog/progress-dialog.component.ts`

When steps are configured, the dialog shows a visual step list instead of a bare progress bar.

```typescript
dialog.setSteps([{key: 'step1', label: 'Step One'}, ...]);
dialog.update(message, percent, stepKey);  // advances active step
dialog.fail(stepKey);                      // marks step red ✕
```

Step states: `pending` (○ dimmed) → `active` (spinner + blue) → `done` (✓ green) → `failed` (✕ red).

---

## Platform Comparison

| Aspect         | Android TV  | Tizen       | VIDAA       | WebOS      |
|----------------|-------------|-------------|-------------|------------|
| Port           | TCP:5555    | TCP:26101   | MQTT:36669  | SSH:22     |
| Auth           | None        | Certificate | User/Pass   | RSA Key    |
| App format     | APK         | WGT/TPK     | —           | IPK        |
| Install        | ✅ Easy     | ✅ Done     | ⚠️ Limited | ✅ Easy    |
| Market share   | ~50%        | ~30%        | ~5%         | ~10%       |
| Implementation | Rust plugin | Rust plugin | Rust MQTT   | Rust SSH   |

---

## Key Files

```
src/
  app/
    core/
      models/
        device-provider.interface.ts   ← DeviceProvider, PlatformDevice, PlatformApp, DeviceInfo
        device-log.model.ts            ← DeviceLog, LogLevel, LogFilter
      services/
        adb.service.ts                 ← Android TV (implements DeviceProvider, calls Rust plugin)
        sdb.service.ts                 ← Samsung Tizen (implements DeviceProvider, calls Rust plugin)
        device-provider.factory.ts     ← resolves provider by platform
        device-log.service.ts          ← unified log stream + platform parsers
    shared/
      components/
        progress-dialog/               ← step list UI for long operations
    android-tv/                        ← Android TV UI module
    tizen/                             ← Tizen UI module
      apps/                            ← app list, install, stress test
      devices/                         ← device management
      wizard/                          ← add device + cert setup wizard
    apps/                              ← LG WebOS app list (installed.component)
    platform-selector/                 ← main platform switcher UI

src-tauri/
  src/
    plugins/
      adb.rs              ← Rust ADB commands (adb-manager plugin)
      samsung_tizen.rs    ← Rust Tizen commands (repack, sign, install, debug, etc.)
      lg_remote.rs        ← LG remote control commands
      cmd.rs              ← SSH remote exec (WebOS)
      shell.rs            ← SSH PTY shells (WebOS)
      file.rs             ← SFTP file ops (WebOS)
      devmode.rs          ← LG dev mode tokens
      local_file.rs       ← local filesystem ops
    device_manager/       ← SSH device definitions + key management
    session_manager/      ← SSH connection pooling
    shell_manager/        ← PTY shell management
    lib.rs                ← Tauri app init + plugin registration
  Cargo.toml              ← Rust deps (tauri, libssh-rs, tokio, futures, adb_client, …)
```

---

## Design System

**Color Palette (Glassmorphism):**
- Background: `#0F172B` (deep navy)
- Primary: `#5B9FF5` (vibrant blue)
- Danger: `#FF6B6B` (soft red)
- Success: `#4ADE80` (green)
- Text Primary: `#FFFFFF`
- Text Secondary: `#A8B8CC`

**Features:** blur effects, rounded corners (12–20px), smooth transitions, modern system fonts.

---

## Build

```bash
npm install        # install Angular deps
npm run start      # dev mode (Tauri + Angular hot-reload)
npm run build      # production build
```

**Outputs:**
- macOS: `src-tauri/target/release/bundle/dmg/Smart TV QA Tool_1.0.0_x64.dmg`
- Windows: `.../msi/Smart_TV_QA_Tool_1.0.0_x64.msi`
- Linux: `.../deb/smart-tv-qa-tool_1.0.0_amd64.deb`

**Requirements:** Rust 1.92+, Node.js 20+

---

## Development Roadmap

| Priority  | Item                                        | Status            |
|-----------|---------------------------------------------|-------------------|
| 🔴 Now    | Fix Samsung Tizen Info tab                  | 🔄 In progress    |
| 🔴 Now    | VIDAA TV MQTT implementation                | ⏳ Research done  |
| 🟡 Soon   | LG WebOS `WebOSProvider` in factory         | ⏳ Planned        |
| 🟡 Soon   | Screenshot from Samsung TV (SDB/CDP)        | ⏳ Planned        |
| 🟢 Later  | Plugin registry architecture                | ⏳ Planned        |
| 🟢 Later  | Persistent device state (no wipe on start)  | ⏳ Planned        |
| 🟢 Later  | Mac .dmg distribution build                 | ⏳ Final step     |

---

**Last Updated:** June 2, 2026
**Version:** 1.0.0
