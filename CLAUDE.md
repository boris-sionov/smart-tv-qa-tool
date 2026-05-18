# Smart TV QA Tool — v1.0.0

A **unified Tauri + Angular desktop application** for managing apps across multiple Smart TV platforms.

---

## Project Status (May 2026)

### ✅ COMPLETED
- [x] App renamed from "FreeTV QA Tool" to "Smart TV QA Tool"
- [x] Modern dark theme design system (glassmorphism)
- [x] Android TV ADB service fully functional
- [x] Samsung Tizen SDB service — full device/app management, certificates, inspect/debug
- [x] Samsung Tizen Inspect — `sdb shell 0 debug` → parse port → open Chrome DevTools
- [x] Platform selector UI
- [x] **Platform Abstraction Layer** — `DeviceProvider` interface, `DeviceProviderFactory`
- [x] **Rust ADB Orchestration** — `adb-manager` Tauri plugin; multi-step ops run in Rust
- [x] **Unified Logging Schema** — `DeviceLogService` with logcat / dlog parsers

### 🔄 IN PROGRESS
- [ ] VIDAA TV support (MQTT-over-TLS) — research complete, ready to implement
- [ ] LG WebOS integration — reuse existing Luna API code

### ⏳ PLANNED — FUTURE ARCHITECTURE
- [ ] **Plugin-based architecture** — provider registry for adding new platforms without core changes
- [ ] **Persistent device state** — stop wiping on startup; add manual "Reset" actions
- [ ] **Vendor API resilience** — monitoring strategy as Samsung/LG update SDKs
- [ ] Embed ADB binary in distributable (.dmg) — Week 2
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
Rust adb-manager  TypeScript      Rust / SSH
plugin (invoke)   shell exec      (libssh_rs)
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

TypeScript no longer calls `Command.sidecar()` for ADB. All ADB operations now go through:
```
Angular invoke('plugin:adb-manager|<command>') → Rust → bundled ADB sidecar
```

**Commands in Rust:** `adb_list_devices`, `adb_connect`, `adb_disconnect`, `adb_list_packages` (multi-step: list → filter whitelist → parallel version fetch), `adb_get_prop`, `adb_launch`, `adb_force_stop`, `adb_uninstall`, `adb_install`.

**Still in TypeScript:** `getAppIcon` (Python-based APK icon extraction — move to Rust + zip crate in the future).

**SDB stays in TypeScript** — complex user-installed CLI discovery (searches VS Code extensions, Tizen Studio paths, system PATH). Moving to Rust adds no value here.

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

## Future Architecture (Planned)

### Plugin-based Platform Registry
When adding VIDAA or LG WebOS, register providers without touching existing code:
```typescript
// future pattern
registry.register('vidaa', VidaaProvider);
registry.register('webos', WebOSProvider);
```
The `DeviceProviderFactory` will be extended to read from a registry rather than a hardcoded map.

### Persistent Device State
**Current (development-era behaviour):** clears all device state on startup.
**Problem for production:** QA engineers want saved devices, recently installed builds, certificate configs.

**Planned change:**
- Remove the startup clear in `lib.rs` and Angular state services
- Keep device configs across launches
- Add explicit **"Reset All State"** / **"Clear Devices"** actions in Settings

### Vendor API Resilience
Samsung SDB, LG Luna, and VIDAA MQTT all change periodically.
- Use official tooling (ADB, SDB, tz CLI) wherever possible — avoids custom protocol maintenance
- Isolate vendor-specific code in individual provider classes
- Keep a test device per platform for regression testing after SDK updates

---

## Platform Details

### Android TV (ADB)
- **Connection:** TCP/IP port 5555
- **Auth:** None (after developer mode enabled)
- **Packages:** APK format
- **Commands:** via bundled ADB sidecar → Rust adb-manager plugin
- **Status:** ✅ Feature-complete

### Samsung Tizen (SDB)
- **Connection:** TCP/IP port 26101
- **Auth:** Certificate-based (no PIN after first connect)
- **Packages:** WGT / TPK format
- **Commands:** SDB CLI (user-installed via Tizen Extension or Tizen Studio)
- **Status:** ✅ Implemented

#### Tizen Implementation Status

| Feature | Status | Notes |
|---------|--------|-------|
| Device connection (SDB) | ✅ Done | `sdb connect <ip>:26101` |
| List connected devices | ✅ Done | `sdb devices` |
| List installed apps | ✅ Done | Multiple fallback commands (applist, pkgcmd) |
| Install WGT/TPK | ✅ Done | Via `tz install` (modern CLI) |
| Sign & Install | ✅ Done | `tz pack` + `tz install` in one flow |
| Launch app | ✅ Done | `sdb shell 0 execute <appId>` |
| Kill app | ✅ Done | `sdb shell 0 execute 0 kill <appId>` |
| Inspect / Debug app | ✅ Done | `sdb shell 0 debug <appId>` → parse port → open browser |
| Device info | ✅ Done | Reads `/etc/info.ini` |
| Certificate creation | ✅ Done | Author certs via `tz cert` |
| Profile management | ✅ Done | Create, set active, delete profiles |
| Device DUID | ✅ Done | For retail TV signing |
| Log parsing (dlog) | ✅ Done | `parseTizenDlog()` in DeviceLogService |
| Add device wizard | ✅ Done | Two-step wizard with dev mode instructions |
| Uninstall app | ✅ Done | `sdb uninstall` with pkgcmd fallback |
| UserWidget (USB) install | N/A | Manual process: copy WGT to `userwidget/` folder on USB |

#### Known FreeTV App IDs (Tizen)
- **Preprod:** `kY6012WvBv.FreeTVpreprod`
- **UAT:** TBD (check `kY6012WvBv.FreeTVuat` or similar)

#### Key Tizen Commands
```bash
sdb shell 0 execute <app-id>          # launch
sdb shell 0 execute 0 kill <app-id>   # kill
sdb shell 0 debug <app-id>            # launch in debug mode → returns inspector port
tz install -p <file> -e <serial>      # install (modern tz CLI)
sdb duid                              # get device DUID for certificate
```

#### Inspect Flow
1. Run `sdb shell 0 debug <appId>` on the connected device
2. Output: `"successfully launched pid = XXXX with debug 1 port: NNNNN"`
3. Parse port number from output
4. Open `http://<device_ip>:<port>` in system browser (Chrome DevTools)

#### UserWidget (USB) Install
Manual process — no code needed:
1. Copy `.wgt` file to USB drive in a folder named `userwidget/`
2. Plug USB into the Samsung TV
3. TV auto-installs any WGT files in that folder

Certificate flow: create author cert (`tz cert`) → create distributor profile (`tz security-profiles add`) → sign & install (`tz pack` + `tz install`).

#### TizenBrew-Compatible Commands (vd_* protocol)
Our app supports both the standard `tz` CLI flow and the TizenBrew push+shell flow:

| Operation | Standard (tz CLI) | TizenBrew (vd_* protocol) |
|-----------|-------------------|---------------------------|
| Install | `tz install -p <file> -e <serial>` | `sdb push` + `shell 0 vd_appinstall <id> <path>` |
| List apps | `sdb shell 0 applist` | `sdb shell 0 vd_applist` (includes version, app_index) |
| Launch | `sdb shell 0 execute <id>` | `sdb shell 0 was_execute <id>` |
| Debug | `sdb shell 0 debug <id>` | `sdb shell 0 debug <tizenId> 0` |
| Uninstall | `sdb uninstall <id>` | `sdb shell 0 vd_appuninstall <id>` |

**Implementation:** `installViaTizenBrew()` in `sdb.service.ts` replicates the TizenBrew install flow:
1. Extract app ID from WGT/TPK ZIP manifest (config.xml or tizen-manifest.xml)
2. Push file via `sdb push` to `/home/owner/share/tmp/sdk_tools/<filename>`
3. Run `sdb shell 0 vd_appinstall <appId> <remotePath>`

**vd_applist fields:** `app_title`, `app_version`, `app_id` (runtime), `app_tizen_id` (package), `app_index` (≥300 = user-installed, can be debugged)

**Launch:** Tries `was_execute` first, falls back to `execute`.
**Debug:** Uses `0 debug <tizenId> 0` (trailing 0 required per TizenBrew protocol).

### VIDAA TV (MQTT)
- **Connection:** MQTT-over-TLS port 36669
- **Credentials:** `hisenseservice` / `multimqttservice`
- **Status:** ✅ Research complete, ready to implement
- **Reference:** [vidaa-control](https://github.com/tombabolewski/vidaa-control), [ha-vidaa-tv](https://github.com/tombabolewski/ha-vidaa-tv)
- **Plan:** Rust MQTT client, `VidaaProvider` implementing `DeviceProvider`

### LG WebOS (Luna API)
- **Connection:** SSH port 22 / 9922
- **Auth:** RSA key (Ed25519)
- **Status:** ✅ Existing Rust SSH+Luna implementation (originally from webOS Dev Manager)
- **Plan:** Create `WebOSProvider` wrapping existing `RemoteLunaService` / `RemoteCommandService`

---

## Platform Comparison

| Aspect         | Android TV  | Tizen       | VIDAA       | WebOS      |
|----------------|-------------|-------------|-------------|------------|
| Port           | TCP:5555    | TCP:26101   | MQTT:36669  | SSH:22     |
| Auth           | None        | Certificate | User/Pass   | RSA Key    |
| App format     | APK         | WGT/TPK     | —           | IPK        |
| Install        | ✅ Easy     | ✅ Easy     | ⚠️ Limited | ✅ Easy    |
| Market share   | ~50%        | ~30%        | ~5%         | ~10%       |
| Implementation | Rust plugin | TS CLI wrap | Rust MQTT   | Rust SSH   |

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
        sdb.service.ts                 ← Samsung Tizen (implements DeviceProvider)
        device-provider.factory.ts     ← resolves provider by platform
        device-log.service.ts          ← unified log stream + platform parsers
    android-tv/                        ← Android TV UI module
    tizen/                             ← Tizen UI module
    platform-selector/                 ← main platform switcher UI

src-tauri/
  src/
    plugins/
      adb.rs          ← Rust ADB commands (adb-manager plugin)
      cmd.rs          ← SSH remote exec (WebOS)
      shell.rs        ← SSH PTY shells (WebOS)
      file.rs         ← SFTP file ops (WebOS)
      devmode.rs      ← LG dev mode tokens
      local_file.rs   ← local filesystem ops
    device_manager/   ← SSH device definitions + key management
    session_manager/  ← SSH connection pooling
    shell_manager/    ← PTY shell management
    lib.rs            ← Tauri app init + plugin registration
  Cargo.toml          ← Rust deps (tauri, libssh-rs, tokio, futures, …)
```

---

## Design System

**Color Palette (Glassmorphism):**
- Background: `#0F172B` (deep navy)
- Primary: `#5B9FF5` (vibrant blue)
- Danger: `#FF6B6B` (soft red)
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

| Phase     | Item                              | Status         |
|-----------|-----------------------------------|----------------|
| Now       | Platform Abstraction Layer        | ✅ Done        |
| Now       | Rust ADB Orchestration            | ✅ Done        |
| Now       | Unified Logging Schema            | ✅ Done        |
| Week 2    | Embed ADB binary in .dmg          | ⏳ TODO        |
| Week 3+   | VIDAA TV MQTT implementation      | ⏳ Ready       |
| Later     | LG WebOS provider integration     | ⏳ Planned     |
| Later     | Plugin registry architecture      | ⏳ Planned     |
| Later     | Persistent device state           | ⏳ Planned     |
| Later     | Mac .dmg distribution build       | ⏳ Final step  |

---

**Last Updated:** May 5, 2026
**Version:** 1.0.0
