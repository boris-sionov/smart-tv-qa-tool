# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

# Smart TV QA Tool

A unified **Tauri 2** (Rust backend) + **Angular 18.2** desktop application for managing apps across Samsung Tizen, Android TV, and LG WebOS Smart TVs. Requires Node 20+ and Rust 1.92+.

---

## Commands

```bash
# First-time setup — downloads ADB and SDB binaries into src-tauri/binaries/
npm run setup           # macOS/Linux
npm run setup:win       # Windows (PowerShell)

# Development
npm run start           # Tauri dev server with Angular hot-reload (port 4281)
npm run build           # Production build (bumps the build number first — see Versioning)

# Angular CLI — use npm run ng, NOT npx ng (wrapper sets required Tauri env vars)
npm run ng -- generate component foo
npm run ng -- test --browsers=TauriDesktop                            # unit tests (Karma + Jasmine)
npm run ng -- test --browsers=TauriDesktop --include='**/foo.spec.ts' # single spec file

# Rust tests
cargo test -p devman
```

Karma does not use Chrome — `scripts/karma-tauri-launcher.js` registers `TauriDesktop` and
`TauriAndroid` launchers that run the specs inside a real Tauri window (so `invoke()` works).
`--browsers=Tauri` is not a launcher name and fails with "it is not registered". `autoWatch` is on and
`singleRun` is false by default; add `--watch=false` for one-shot runs.

**Build outputs** land in the *workspace* target dir at the repo root (`Cargo.toml` declares a
workspace whose only member is `src-tauri`), **not** `src-tauri/target/`:
- macOS: `target/release/bundle/dmg/Smart TV QA Tool_<version>_aarch64.dmg`
- Windows: `target/release/bundle/msi/*.msi`, `.../nsis/*.exe`
- Linux: `target/release/bundle/deb/*.deb`, `.../rpm/*.rpm`, `.../appimage/*.AppImage`

---

## Versioning & Build Number

`package.json` `version` is the single source of semver — `src-tauri/tauri.conf.json` reads it via
`"version": "../package.json"`. Bundle filenames come from it.

The build number is separate and generated:

| File | Role |
|------|------|
| `scripts/build-info.js` | Generator. `--bump` increments, `--force` always increments |
| `src/build-info.json` | Generated **and committed** — holds the counter, commit, branch, timestamp |
| `src/app/core/build-info.ts` | Typed accessor: `BUILD_INFO`, `APP_VERSION` (`"1.0.0 (build 12)"`) |

Wiring: `prebuild` runs `build-info.js --bump` before every `npm run build`; `prestart` refreshes
(without bumping) before `npm run start`. The bump is conditional — it only fires when HEAD moved
or the tree is dirty (ignoring `src/build-info.json` itself), so building the same clean commit
twice keeps the same number. That's why CI's double `npm run build` on Windows x64 doesn't inflate it.

`APP_VERSION` is displayed in the platform-selector footer, the LG sidebar, and LG → More → Version.

Do **not** confuse this with `src/release.json` (`{version: ""}`), a fork leftover consumed only by
`src/main.ts` to gate Sentry: empty version ⇒ Sentry disabled and release reported as `local`. Leave
it empty for local builds.

---

## Architecture

### Two Parallel Architectures (Important)

The codebase is mid-migration. **Android TV and Tizen** use the new `DeviceProvider` abstraction.
**LG WebOS** still uses the original SSH-based architecture from the upstream
`webosbrew/dev-manager-desktop` fork and is NOT wired into `DeviceProviderFactory`.

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

`DeviceProviderFactory.get()` **throws** for `webos` — check `supports(platform)` first in any
code path that may see all three platforms.

### Rust Plugin Registration (`src-tauri/src/lib.rs`)

| Registered name | Module | Serves |
|-----------------|--------|--------|
| `device-manager` | `plugins/device.rs` | LG device store |
| `remote-command` | `plugins/cmd.rs` | LG SSH exec / Luna |
| `remote-shell` | `plugins/shell.rs` | LG PTY shells |
| `remote-file` | `plugins/file.rs` | LG SFTP |
| `dev-mode` | `plugins/devmode.rs` | LG dev-mode token |
| `local-file` | `plugins/local_file.rs` | Host filesystem |
| `adb-manager` | `plugins/samsung_tizen.rs` | **Both** Android TV ADB *and* Tizen SDB |
| `lg-remote` | `plugins/lg_remote.rs` | LG remote-control keys |

**Key insight:** `plugins/adb.rs` is a helper module imported by `samsung_tizen.rs`, not a separately
registered plugin. Every ADB *and* Tizen call from Angular goes through `invoke('plugin:adb-manager|...')`.

Cargo package name is still `devman` and the binary `webos-dev-manager` (fork leftovers) — the
product name `Smart TV QA Tool` comes from `tauri.conf.json`.

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

Resolve providers via `DeviceProviderFactory.get(platform)` — never import `AdbService` or
`SdbService` directly in UI components.

### Service Base Classes

All Angular services that call Rust extend `BackendClient` (`src/app/core/services/backend-client.ts`).
It wraps `invoke()` with `NgZone.run()` re-entry (so Tauri promise resolutions trigger Angular CD)
and normalises Rust errors into typed `BackendError` / `IOError` / `ExecutionError`.

```typescript
class MyService extends BackendClient {
    constructor(zone: NgZone) { super(zone, 'adb-manager'); }
    doSomething() { return this.invoke<string>('some_command', {arg: 'value'}); }
}
```

For bidirectional streaming (PTY, log tails) use `EventChannel` (`src/app/core/event-channel.ts`).
The Rust side opens a channel token; events flow via `token:rx` / `token:tx` / `token:closed` Tauri
events. Used by `RemoteShellService` for WebOS PTY shells.

### Device State Persistence

Android TV and Tizen device lists are stored in `localStorage` (not a Tauri store or file):
- `TizenStateService` — keys `smart-tv-qa-tizen-devices`, `smart-tv-qa-tizen-selected-device`, `smart-tv-qa-tizen-studio-path`, `smart-tv-qa-tizen-cert-profile`
- `AdbStateService` — keys `freetv-android-tv-devices`, `freetv-android-tv-selected-device`

`AdbStateService` wipes device state on first launch per app installation (guarded by
`adb-state-initialized` flag). This is the "Persistent device state" open work item — the intent is
to keep state across reinstalls.

LG WebOS devices live in `~/.webos/ose/novacom-devices.json` (macOS/Linux) or `%APPDATA%\.webos\ose\`
(Windows) — a legacy path from the webosbrew fork. `DeviceManager` clears this file once on first
run (`.initialized` marker) to drop stale entries from the fork.

### Unified Logging

`DeviceLogService` (`src/app/core/services/device-log.service.ts`) provides a platform-neutral log
stream with parsers: `parseAndroidLogcat(raw, deviceId)` for `adb logcat`, `parseTizenDlog(raw, deviceId)`
for `sdb dlog`.

---

## Platform Details

### Samsung Tizen (SDB)
- **Connection:** TCP port 26101, certificate-based auth (no PIN after first connect)
- **App format:** WGT / TPK
- **Commands:** user-installed `sdb` + `tizen` CLIs, orchestrated from Rust via `adb-manager` plugin

#### Signed WGT Install Flow (Critical — `tizen_install_signed` in Rust)
The CI build double-packages WGTs: files appear at root (unsigned) AND inside `.buildResult/` (signed).
The TV rejects unsigned WGTs with error `[118, -12]`.

Pipeline:
1. `sdb disconnect <ip>:26101` — TV daemon releases session
2. `sdb kill-server` — drops local daemon + any TizenBrew reverse tunnel
3. Wait 1000ms
4. `sdb connect <ip>:26101` — retry up to 4×, 1.5s apart
5. Match the certificate profile to the TV (see below)
6. Stage — strip root entries, keep only `.buildResult/` content, swap in the environment icon
7. Sign — `tizen package -t wgt -s <profile>`
8. `tizen install -n file.wgt -s <ip>:26101`
9. `sdb disconnect` — cleanup

`sdb disconnect` must come before `kill-server`: `kill-server` only kills the Mac-side daemon; the TV
still holds its session. `sdb disconnect` sends a proper teardown so the TV releases the port.

`stage_wgt` always writes to a temp file, even when the WGT needs no restructuring — signing
rewrites the file in place and the source is the user's download. The temp file is deleted on every
exit path.

#### Environment Icon At Install

The badged icon goes *into the package*, replacing the entry `config.xml` names in `<icon src>`,
just before signing. Unlike webOS there is no post-install option: a retail Samsung TV answers
`You cannot push files to this path` for `/opt/share/webappservice/apps_icon/…`, and refuses `pull`
there too, so the packaged icon is the only one we can set. The install flow is already rebuilding
and re-signing the WGT, so the swap costs nothing extra.

`tizen_read_wgt_info` reads the id and name out of `config.xml` before the install starts, so
`environmentIcon('tizen', …)` can pick the badge; the bytes travel to Rust as base64. Best-effort —
a WGT we cannot read, or an icon we cannot load, installs with the artwork it shipped.

#### Certificate ↔ TV Matching (the other cause of `[118, -12]`)

A Samsung *distributor* certificate is issued for a fixed list of TV DUIDs. Signing with a profile
that does not list the target TV produces a perfectly well-formed, properly signed package that the
TV still rejects with `install failed[118, -12] … Unsigned file error` — the same code an actually
unsigned package gets. The message points at the package; the cause is the certificate.

The app stores one cert profile (`smart-tv-qa-tizen-cert-profile`) for all devices, so switching TVs
in the picker used to keep signing with the previous TV's certificate. `tizen_install_signed` now
resolves the profile per install instead:

- `read_duid(serial)` reads the TV's DUID over the raw SDB protocol (after the connect step).
  `0 getduid` is the command that answers on current firmware; `0 duid`, `0 /usr/bin/duid` and
  `0 getprop _duid` all return empty there and are kept only as fallbacks.
- `parse_cert_profiles()` reads `tizen-studio-data/profile/profiles.xml`, and for each profile's
  `distributor="1"` key follows the sibling `device-profile.xml` for its `<TestDevice>` DUIDs.
- The saved profile wins if it covers the DUID; otherwise the first profile that does is used and
  the progress dialog names it. If a DUID is known and no profile covers it, the install stops with
  the DUID and the profile → DUID table rather than letting the TV return `-12`.
- If the DUID read fails, or no profile declares any DUID, the saved profile is used unchanged.

DUID comparison is containment-based (`0 duid` can echo more than the bare id) and case-insensitive.

#### Stress Test / CDP
- Launch via `sdb.debug(serial, tizenId)` — launches the app AND returns the CDP port. Never call
  `debug()` again after waiting — it restarts the app.
- Tizen's `/json` returns `ws://localhost:PORT/...` — rewrite `localhost` to the actual TV IP before
  connecting the WebSocket.
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
- **Icons in the app list** are bundled assets, resolved in `AndroidTvAppsComponent.setPackages()`:
  the badged environment icon for a FreeTV build (see [Environment Icons](#environment-icons)),
  otherwise `assets/app-icons/<packageId>.png` for the ids in `EXTRACTED_ICONS`, otherwise the ATV
  placeholder. Nothing is written to the device — an installed APK's launcher banner is baked into
  the APK and cannot be changed over ADB, so this is our list only, not the TV's home screen.

### LG WebOS (Luna API)
- **Connection:** SSH port 22 / 9922, Ed25519 key auth
- **App format:** IPK
- **Architecture:** SSH connection pool (`conn_pool/`, `session_manager/`) via `libssh-rs`; Luna
  service calls over SSH; PTY shells via `shell_manager/`
- **Status:** Fully functional; planned migration to `DeviceProvider` interface

#### Environment Icons After Install
`AppManagerService.applyEnvironmentIcons()` runs as the last install step and overwrites the
`icon` / `largeIcon` files of every sideloaded FreeTV build over SFTP with the badged icon for its
environment (see [Environment Icons](#environment-icons)).

Developer partition only, and best-effort — an unmapped environment or a failed write leaves the
packaged icon. It re-runs on every install because installing the IPK puts the packaged icon back.

It walks the whole developer list rather than the app that was just installed: appinstalld does not
reliably report a `packageId`, and reinstalling the same version is invisible to a before/after diff
of the app list, so neither identifies the app well enough to rely on. Walking the list also repairs
an app whose earlier stamp failed. Each run logs one of `[Install] Stamped environment icons: …`,
`[Install] No installed app matches a bundled environment icon`, or `[Install] Could not stamp …` —
start there when an icon does not turn up.

### Environment Icons

Every FreeTV build ships the same green icon, so two of them side by side — on a TV's home screen,
or in our own app list — are indistinguishable. `src/app/shared/app-environment-icons.ts` maps the
environment `appEnvironment()` reports onto the badged icon for that platform:

| Environment | webOS (`assets/lg-icons/`) | Android TV (`assets/android-tv-icons/`) | Tizen (`assets/tizen-icons/`) |
|---|---|---|---|
| PreProd | `freetv-lg-preprod-icon.png` | `freetv-atv-preprod-icon.png` | `freetv-tizen-preprod-icon.png` |
| PreProd Test, Test | `freetv-lg-prod-test-icon.png` | `freetv-atv-prod-test-icon.png` | `freetv-tizen-prod-test-icon.png` |
| UAT, Prod on UAT | `freetv-lg-uat-icon.png` | `freetv-atv-uat-icon.png` | `freetv-tizen-uat-icon.png` |
| Prod | `freetv-lg-store-icon.png` | `freetv-atv-store-icon.png` | `freetv-tizen-store-icon.png` |
| *(no marker)* | — | `freetv-atv-store-icon.png` | — |
| **2.0 rewrite** | `freetv-lg-2.0-icon.png` | `freetv-atv-2.0-icon.png` | `freetv-tizen-2.0-icon.png` |

The three families are byte-identical artwork today, kept one folder per platform so QA can redraw
one platform's badges without disturbing the others.

FreeTV builds only — every bundled icon is a FreeTV one. An environment with no icon of its own
(Staging, QA, Debug) is left alone.

Only icons drawn in the current style are referenced: the logo large in the middle with one wide
badge, white-outlined, below it. `freetv-atv-prod-icon.png` and both files under
`lg-icons/previews/` are the older style — small badge tucked into a corner — and are deliberately
unused, which is why a prod build takes the STORE icon on both platforms. `freetv-lg-uat-icon.png`
was in that older style too and has been replaced with the current one.

The 2.0 row is the `version2` field, matched on app id rather than environment: the rewrite ships
as `com.freetv.smarttv` (webOS, Android TV) and `Plusdrie00.FreeTV` (Tizen), carries no environment
marker, and has its own artwork — dark ground with a gradient logo, taken from the app repo's
`platforms/lg/icon.png` — rather than a badge over the 1.x icon. A 2.0 build that *does* carry an
environment marker keeps that environment instead.

The unmarked row is the `unmarked` field of each platform's `IconFamily`. What QA installs on an
Android TV is prod or uat and only uat carries a marker, so an unmarked FreeTV APK —
`tv.freetv.androidtv` — is the prod build and gets the PROD badge. webOS has no such default: there
the icon is written to the TV, and an unmarked build there is the Content Store one. Tizen follows
webOS for the same reason — the icon becomes the app's real icon, so an unmarked build keeps the
artwork it shipped rather than being labelled on a guess.

Where the icon is applied differs per platform, because what each one lets us write differs:

| Platform | Where | When |
|---|---|---|
| webOS | the app's `icon` / `largeIcon` files on the TV, over SFTP | after every install |
| Tizen | `icon.png` inside the WGT, before signing | during install |
| Android TV | nowhere on the device — our app list only | n/a (the APK's banner is baked in) |

### VIDAA TV (Hisense) — Planned
- **Connection:** MQTT-over-TLS port 36669, credentials `hisenseservice` / `multimqttservice`
- **Plan:** Rust MQTT client (`rumqttc` crate), `VidaaProvider` implementing `DeviceProvider`

---

## Sidecar Binaries

`tauri.conf.json` declares `externalBin: ["binaries/adb", "binaries/sdb"]`. Tauri resolves these
per **target triple**, so `src-tauri/binaries/` must contain e.g. `adb-aarch64-apple-darwin`,
`sdb-x86_64-pc-windows-msvc.exe`. A build fails with "binary not found" when the triple for the
current target is missing — `npm run setup` fetches the host ones; CI copies/duplicates them for
cross-compiled targets (see `.github/workflows/release.yml`).

---

## CI

- `.github/workflows/build-verify.yml` — build on push/PR to `main` across Linux, macOS, Windows
  x64 + Windows ARM64.
- `.github/workflows/release.yml` — on published release (or manual dispatch), builds all targets
  (Windows x64 + i686 + ARM64, Linux x86_64 + ARM64, macOS universal) with
  `--features=vendored-openssl` and attaches bundles to the release.

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

Glassmorphism dark theme. Colors: background `#0F172B`, primary `#5B9FF5`, danger `#FF6B6B`,
success `#4ADE80`, text `#FFFFFF` / `#A8B8CC` (secondary). Blur effects, 12–20px rounded corners,
smooth transitions.

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

See also `AGENTS.md` (session history and deeper protocol notes) and `README.md` (user-facing setup).
