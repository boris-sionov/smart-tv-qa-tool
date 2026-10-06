# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, …) and developers working in this
repository. This is the single agent-instructions file — there is no `CLAUDE.md`; keep everything here.

---

# Smart TV QA Tool

A unified **Tauri 2** (Rust backend) + **Angular 18.2** desktop application for managing apps across Samsung Tizen, Android TV, and LG WebOS Smart TVs (VIDAA in design). Requires Node 20+ and Rust 1.92+.

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

Wiring: **`.github/workflows/build-number.yml` owns the counter.** It runs `build-info.js --bump
--force` on every push to `main` and commits the result, so the number counts merged PRs. The bump
lives there rather than in each PR branch because two open PRs both touch the same line and
conflict on the second merge, and bumping at PR time would count PRs opened rather than shipped.

`prebuild` and `prestart` both run `build-info.js` without `--bump`: they refresh the commit,
branch and timestamp for the build at hand but leave the counter to CI, so a local `npm run build`
reports the same number as the artifact CI would produce from that commit. The script still
supports `--bump` (conditional on HEAD moving or a dirty tree) and `--bump --force`.

No push loop: a push made with `GITHUB_TOKEN` does not trigger workflows, and the commit is
additionally tagged `[skip ci]`.

`APP_VERSION` is displayed in the platform-selector footer, the LG sidebar, and LG → More → Version.

## Logs

`~/Library/Logs/com.smarttv.qa-tool/Smart TV QA Tool.log` (macOS), via `tauri_plugin_log`.

**`console.log` does not reach it.** A release build opens no devtools, so a frontend line logged
that way is gone. To put one in the file, call the plugin's `info`/`warn` directly — `installLog`
(webOS, `app-manager.service.ts`) and `tizenLog` (`tizen-apps.component.ts`) both do, alongside the
console call. The plugin's `attachConsole()` is not the way: it pipes the Rust log *into* the
webview console, the opposite direction.

Start here when the UI reports something the backend log does not explain.

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

### Adding a Tauri Command — Three Places, Not One

A new command has to be listed in **all three** of:

1. `tauri::generate_handler![…]` in the plugin's `build()` — otherwise it does not exist.
2. `InlinedPlugin::new().commands([…])` in `src-tauri/build.rs` — this is what generates the
   `allow-<kebab-name>` permission.
3. `src-tauri/permissions/<plugin>/default.toml` — otherwise every call fails at runtime with
   `Command plugin:<name>|<command> not allowed by ACL`.

Miss 2 or 3 and it compiles, ships, and fails only when called — invisible behind any `catch`.
`tizen_read_wgt_info` shipped that way and made the Tizen environment badge look broken for two
releases. `acl_tests` in `samsung_tizen.rs` now parses the three lists and fails the build when
they disagree.

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
4. Match the certificate profile to the TV (see below) — **before** the connect
5. `sdb connect <ip>:26101` — retry up to 4×, 1.5s apart
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

`tizen_read_wgt_info` reads the id, name and `<widget version>` out of `config.xml` before the
install starts; the icon bytes travel to Rust as base64. Best-effort — a WGT we cannot read, or
artwork we cannot draw, installs with the icon it shipped.

**Tizen draws its badge rather than shipping one per environment.** The label carries the build
version (`PREPROD-1.26.0`), because QA installs several versions of the same environment in a day
and a tile reading `PREPROD` alone does not say which one is on the TV — so there is no finite set
of PNGs to bundle. `tizenEnvironmentIcon()` picks the artwork and the label;
`renderEnvironmentBadge()` (`src/app/shared/environment-badge.ts`) draws the pill on a canvas.

| | |
|---|---|
| Base artwork | `assets/tizen-icons/freetv-tizen-base-icon.png` — the unbadged green icon |
| Layout | two pills set diagonally: environment upper-left, version lower-right |
| Fill | environment `#C41F64` (sampled from the webOS icons); version a dark ground, so it reads as secondary |
| Font | **Arial** first — `Arial Black` renders ~11% wider and overruns the pill |
| Long labels | shrink the type; `fillText`'s `maxWidth` condenses glyphs and looks like another face |
| Decoding | `fetch` → `createImageBitmap`, **never** `new Image().src` — see below |

Two pills rather than one wide one along the bottom: a single pill holding environment *and*
version had to run nearly the icon's full width to stay legible, which crowded the logo.

**They are not in the corners.** A Samsung launcher crops the tile to a squircle, and a corner
badge loses its ends to that — the first attempt shipped and rendered as `REPROD` / `1.26.(` on a
real TV. Each pill is now placed against the *mask's* edge at its own vertical centre
(`maskHalfWidth`, a superellipse with `MASK_EXPONENT = 4`), so the layout follows the crop rather
than the square it is drawn in. Checked against rounder masks (n=3, n=2.4) and the longest labels
we ship, `PREPROD TEST` / `22.4.706`, since a rounder mask is the one that bites.

A release build serves the page from `tauri://localhost`, and WKWebView treats an image fetched
through that custom scheme as cross-origin: drawing it taints the canvas and `toBlob()` then
returns nothing, so the badge silently never appears. Everything works under `tauri dev`, which
serves over plain http — so this does not reproduce in development. Bytes fetched and handed to
`createImageBitmap` are origin-clean whatever the scheme.

The 2.0 rewrite is the exception: `freetv-tizen-2.0-icon.png` already carries a purple `2.0` pill in
the same place ours would go, so a 2.0 build installs that artwork unchanged and gets no version
badge. Giving it one needs an unbadged 2.0 base.

#### Certificate ↔ TV Matching (the other cause of `[118, -12]`)

A Samsung *distributor* certificate is issued for a fixed list of TV DUIDs. Signing with a profile
that does not list the target TV produces a perfectly well-formed, properly signed package that the
TV still rejects with `install failed[118, -12] … Unsigned file error` — the same code an actually
unsigned package gets. The message points at the package; the cause is the certificate.

The app stores one cert profile (`smart-tv-qa-tizen-cert-profile`) for all devices, so switching TVs
in the picker used to keep signing with the previous TV's certificate. `tizen_install_signed` now
resolves the profile per install instead:

- `read_duid(serial)` reads the TV's DUID over the raw SDB protocol, in the window between
  `kill-server` and `sdb connect`. **The order matters**: the TV's SDB daemon serves one session at
  a time, and while the local sdb server holds it every other socket to port 26101 is reset by peer
  (`ConnectionResetError`), so a DUID read placed after the connect silently returns nothing and the
  match falls back to the saved profile. Reading it first also fails a hopeless certificate before
  the install spends time connecting and signing.
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

| Environment | webOS (`assets/lg-icons/`) | Android TV (`assets/android-tv-icons/`) |
|---|---|---|
| PreProd | `freetv-lg-preprod-icon.png` | `freetv-atv-preprod-icon.png` |
| PreProd Test, Test | `freetv-lg-prod-test-icon.png` | `freetv-atv-prod-test-icon.png` |
| UAT, Prod on UAT | `freetv-lg-uat-icon.png` | `freetv-atv-uat-icon.png` |
| Prod | `freetv-lg-store-icon.png` | `freetv-atv-store-icon.png` |
| *(no marker)* | — | `freetv-atv-store-icon.png` |
| **2.0 rewrite** | `freetv-lg-2.0-icon.png` | `freetv-atv-2.0-icon.png` |

The two families are byte-identical artwork, kept one folder per platform so QA can redraw one
without disturbing the other. **Tizen is not in this table** — its badge carries the build version,
so it is drawn at install time from `assets/tizen-icons/freetv-tizen-base-icon.png` rather than
picked from a bundled file. See [Environment Icon At Install](#environment-icon-at-install).

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

#### App List Icons (our list, not the TV)

The Tizen list draws bundled artwork per app — Disney, Netflix, yes+, HOT and the rest — because
webOS's approach does not port: a retail Samsung TV refuses `sdb pull` from
`/opt/share/webappservice/apps_icon/`, and its `sdb shell` is the restricted `vd_*` one with no
`cat`, so the app's real icon is unreachable. `src/app/shared/app-brand-icons.ts` matches on a
brand pattern rather than an id table, because the ids differ per platform and per store listing
(`Di0N6xZMEA.disneyplus` on Samsung, `com.disneyplus` on Android TV) while the brand in the id or
title does not. Artwork lives in `assets/brand-icons/`.

A FreeTV row is the exception: it renders the same badge the install writes, from the version the
list already fetched, so two PreProd builds are as distinguishable in our list as on the TV.

| Platform | Where | What | When |
|---|---|---|---|
| webOS | the app's `icon` / `largeIcon` files on the TV, over SFTP | bundled PNG per environment | after every install |
| Tizen | `icon.png` inside the WGT, before signing | drawn, `PREPROD-1.26.0` | during install |
| Android TV | nowhere on the device — our app list only | bundled PNG per environment | n/a (the APK's banner is baked in) |

### VIDAA TV (Hisense) — In Design

Not implemented yet. The approach is no longer the MQTT-first one this file used to describe: app
control goes through the VIDAA **DevKit Web** page driven over CDP, and logs come from the TV's own
DevTools port. Full design and its open questions:
[VIDAA (Hisense) — Implementation Plan](#vidaa-hisense--implementation-plan).

- **Sideload:** VIDAA DevKit (TV app) + DevKit Web on a PC — hosted app, installed by URL
- **App format:** none — an app URL plus an icon URL
- **Debug / logs:** Chrome DevTools at `http://<tv-ip>:9226` (9222 on older chipsets) — *unverified on our TVs*

#### Devkit Install — App And Icon URLs

FreeTV on VIDAA is a hosted web app: the devkit installs it from an app URL plus an icon URL, with
nothing packaged. These are the pairs QA installs with:

| Environment | App URL | Icon URL |
|---|---|---|
| PreProd | `https://uat-web.freetv.tv/apps/smarttv/preprod/hisense/index.html` | `https://raw.githubusercontent.com/boris-sionov/smart-tv-qa-tool/main/src/assets/lg-icons/freetv-lg-preprod-icon.png` |
| UAT | `https://uat-web.freetv.tv/apps/smarttv/web/index.html` | `https://raw.githubusercontent.com/boris-sionov/smart-tv-qa-tool/main/src/assets/lg-icons/freetv-lg-uat-icon.png` |
| Prod | `https://web.freetv.tv/apps/smarttv/web/index.html` | `https://raw.githubusercontent.com/boris-sionov/smart-tv-qa-tool/main/src/assets/lg-icons/freetv-lg-store-icon.png` |

The icons are the webOS badged ones (see [Environment Icons](#environment-icons)), served from this
repo's `main` — renaming or moving those files breaks every Hisense install that points at them.

FreeTV hosts no icon of its own for these builds. `uat-web.freetv.tv` answers **every** unknown path
with the app's index page and a 200, `icon.png` included, so a 200 there proves nothing — check the
`Content-Type` is `image/png`. The only real images next to each build are the unbadged
`1280x720-logo.png` / `1920x1080-logo.png`.

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

## Platform Status

| Platform | Status | Protocol |
|----------|--------|----------|
| Samsung Tizen | ✅ Full — install, launch, kill, inspect, stress test | SDB + tz CLI |
| Android TV | ✅ Full — install, launch, kill, device info | ADB (Rust sidecar) |
| LG WebOS | ✅ Working — install, launch, kill, inspect, stress test | SSH + Luna API |
| VIDAA (Hisense) | ⏳ In design — see [the plan](#vidaa-hisense--implementation-plan) | DevKit Web over CDP + TV DevTools |

---

## Open Work

| Priority | Item | Notes |
|----------|------|-------|
| Now | Fix Samsung Tizen Info tab | Branch: `fix-samsung-info`; reads `/etc/info.ini` via `tizen_get_device_info` — check the fields returned vs displayed, the `TizenInfoEntry` parsing, and the UI mapping |
| Now | VIDAA TV support | [Implementation plan](#vidaa-hisense--implementation-plan) — phase 0 checks on the TV first |
| Soon | LG WebOS into `DeviceProviderFactory` | Wrap `RemoteLunaService` / `RemoteCommandService` in `WebOSProvider` |
| Soon | Screenshot from Samsung TV | `sdb shell 0 screencapture` + `sdb pull` (not on all firmware), or CDP `Page.captureScreenshot` on a debug build |
| Later | Persistent device state | Stop wiping on startup |
| Later | Mac .dmg distribution build | |

---

## VIDAA (Hisense) — Implementation Plan

Status: **researched, not started** (October 2026; two research rounds). Goal: the same per-app **Launch / Close** buttons,
install and logs that Tizen, LG and Android TV have, for FreeTV on a Hisense VIDAA TV.

### How QA does it by hand today

1. On the TV: open the **DevKit** app (VIDAA App Store → focus the search button without pressing OK,
   type `2775379`; a per-TV secure code from the VIDAA contact unlocks it) → **Connect to PC**. The TV
   shows a 6-character **Connection Code** and the DevKit Web URL.
2. On the PC: open `https://partner-doc.vidaa.com/vdocs/more/devkitweb.html`, sign in with the VIDAA
   partner account, enter the connection code.
3. Tabs **Index / App Sideload / Logger**. App Sideload lists the installed apps and has the install
   form: AppUrl (+ **Launch**), Type, AppName, IconUrl, configUrl, **Install**, **Clear**. The URL/icon
   pairs QA uses are in [Devkit Install — App And Icon URLs](#devkit-install--app-and-icon-urls).

### Our test TV

| | |
|---|---|
| Model | `43E70QEVS_10` |
| VIDAA | `U09.60`, firmware `V0000.09.60W.Q0612(release)` |
| Platform | `MTK9603_EU_A` |
| LAN IP | `192.168.50.234` |

First port probe from the QA Mac (October 2026, DevKit connected, FreeTV **not** confirmed in the foreground):
- the TV answers ping
- **36669 (MQTT) is open**
- 9222 / 9223 / 9224 / 9226 / 9229 all refuse

A second probe returned the same result. A *refused* TCP connection means nothing is listening on the
port, so this is not the "direct HTTP access is deprecated" caveat in the official docs. The VIDAA
docs say some models ship with the port closed and that VIDAA opens it on request. Unless phase 0
shows it opening while a sideloaded app runs, **ask VIDAA through our PEM (partner manager) to enable
DevTools on this set.**

### Research findings

**DevKit Web has no API we can call directly.**
- Every `*.html` under `partner-doc.vidaa.com/vdocs/` answers 302 → `www.vidaa.com/oauth/authorize`
  (WordPress login with reCAPTCHA). Static assets (`manifest.json`, images) are public, but the hashed
  JS bundle names are unknown, so the backend protocol could not be read.
- The order is: partner OAuth session → SPA loads → TV connection code entered inside the SPA.
- Lead, unconfirmed: `devkit.vidaahub.com` is an AWS API Gateway (`{"message":"Not Found"}` on
  every guessed path). Probably the cloud relay between the PC page and the TV.
- Consequence: a human has to sign in in a real browser. Automation can only take over that browser
  afterwards.

**The TV can expose Chrome DevTools, the route for logs and Inspect, but on our U9 set it is closed.**
- Current official page: <https://partner-doc.vidaa.com/vdocs/development/devtools.html> (behind the
  partner login). Its port table:
  - **U4 and above: 9226**
  - U2.5: 9222

  It recommends Chrome's `chrome://inspect` → *Configure* → `<tv-ip>:9226` over opening the port by
  HTTP, and says the DevTools frontend should be a Chromium matching the WEBRUNTIME version. It also
  says some models do not open the port by default ("contact VIDAA"), and that TV system logs (as
  opposed to the app console) are exported only with VIDAA, through the PEM.
- Official *WebApp Development Guide for VIDAA* §9 ("Enable remote devtools"): open
  `http://<tv-ip>:9226` from a Chromium browser on the LAN (9222, sometimes 9224, on MT5658/5659 and
  MSD6586). It provides the console, DOM, network, timeline and heap tools. U4-era production sets need
  `hisense://debug` → **debug_on** + a power cycle. Some models keep it closed ("contact us").
  The guide's original URL now 404s. Wayback copy:
  `https://web.archive.org/web/2023id_/https://www.vidaa.com/wp-content/uploads/2020/12/WebApp_Development_Guide_for_VIDAA.pdf`
- BlackBox QA (<https://www.blackboxqa.ca/hisense-debugging>) describes the current QA flow: with
  DevKit installed and the app sideloaded, `http://<tv-ip>:9226` shows "Inspectable WebContents", one
  entry per app → Chrome Inspect.
- It is the same CDP we already use for the Tizen / LG stress test, so `/json` lists the page targets
  and a WebSocket gives `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Log.entryAdded`,
  `Runtime.evaluate`.
- Risk: U9 firmware is reported to reject `hisense://debug`
  (<https://github.com/NoobyGains/stremio-vidaa-tv/issues/36>). Whether 9226 is open with DevKit on
  our sets is **not verified**.
- Engine: Chromium-based throughout (Chrome 77 on U4, 88 on VIDAA 6, 100–120 on VIDAA 7, 111 on VIDAA 9).

**There is no close button and no close API.**
- DevKit Web shows none. The documented `Hisense_*` JS APIs are info/settings only.
- The guide (§5.1 / §5.4) says an app exits via `window.close()`, and Exit/Menu are system keys that
  close the foreground app.
- So Close is either `KEY_EXIT` over MQTT (below; works without DevTools) or
  `Runtime.evaluate("window.close()")` on the app's CDP target (needs 9226).

**MQTT (port 36669, "RemoteNOW") is the automation channel on U9**, and it is open on our TV.
Our TV's UPnP descriptor (`http://<tv-ip>:18400/MediaServer/rendererdevicedesc.xml`, `modelDescription`)
reports **`transport_protocol=3290`**, which is the "modern" (VIDAA 2.0, 2024+) profile. Working
2024–2026 implementations: stevene1919/hisense_vidaa (most active), warrenrees/pyvidaa (best write-up,
`VIDAA_PROTOCOL_ANALYSIS.md`), and Empi9245/Sidee (tested on U09.60 `V0000.09.60A.Q0707`).

- **Transport:** TLS 1.3 to 36669. The server cert is `CN=127.0.0.1` signed by a self-signed
  `CN=RemoteCA, O=hh` (seen on our TV). Skip the name check; optionally pin RemoteCA. MQTT 3.1.1,
  clean session, QoS 0. **One connection per client id:** a second one kicks the first.
- **Client certificate is mandatory.** Without it, TLS succeeds but CONNECT returns rc=5, and the TV
  says the app is "no longer compatible".
  - The cert that works is `CN=VidaaAppAndroidV01` (valid 2024–2034). It comes from the official
    *VIDAA Smart TV* Android APK (`com.universal.remote.multi`). Inside the APK it is a `.p12` under
    `res/` (the name is obfuscated per build, e.g. `El.p12`), with password
    `186e990688070325a1c4b0ce275d2388`. It uses legacy PBE, so it needs `openssl pkcs12 -legacy`.
  - Some repos publish the key. **We do not commit it:** it is Hisense's private key. Either ask VIDAA
    for a client cert through the PEM, or have QA supply the `.p12` locally.
- **Credentials (modern profile),** from pyvidaa's live captures:
  ```
  PATTERN = "38D65DC30F45109A369A86FCE866A85B"   # MD5("&vidaa#^app").upper()
  SALT    = "h!i@s#$v%i^d&a*a"
  XOR     = 6239759785777146216
  uuid    = random MAC-shaped string, generated once and persisted (tokens are bound to it)
  ts      = TV clock: the HTTP Date header of the UPnP descriptor above
  client_id = f"{uuid}$his${MD5(PATTERN+'$'+uuid)[:6]}_vidaacommon_001"
  username  = f"his${ts ^ XOR}"
  password  = MD5(f"{ts}${MD5(f'his{sum(digits(ts)) % 10}{SALT}')[:6]}")   # MD5 hex uppercase
  ```
  Test vector: `56:b8:88:4e:f7:19`, ts `1766974704` gives `…$his$256DBF_vidaacommon_001`,
  `his$6239759786168176024` and `C3BA44782E18ABF4892AC44D79A622D2`.
- **Pairing (once per uuid):**
  1. Subscribe to `/remoteapp/mobile/CID/ui_service/data/{authentication,authenticationcode,…}` and
     `…/platform_service/data/tokenissuance`.
  2. Publish `/remoteapp/tv/ui_service/CID/actions/vidaa_app_connect`.
  3. The TV shows a 4-digit PIN. Send it with `actions/authenticationcode` as `{"authNum":1234}`.
  4. Publish `platform_service/CID/data/gettoken`. The reply carries the access and refresh tokens and
     their lifetimes (read them from the payload).

  Later sessions connect with `password = accesstoken`. A deep power-off wipes the tokens, so the
  client then has to re-pair.
- **Commands** (`/remoteapp/tv/<service>/CID/actions/<x>`):
  - `ui_service/applist`: the reply is JSON entries `{appId,name,url,urlType,storeType,isunInstalled,…}`.
    It can exceed rumqttc's 10 KB default, so raise the packet limit.
  - `ui_service/launchapp`: echo the applist entry plus `"urlType":37,"appName","appUrl"`.
  - `remote_service/sendkey`: `KEY_EXIT` / `KEY_HOME` / `KEY_RETURNS` / arrows / `KEY_OK` / `KEY_POWER`.
    **Sources disagree on the payload:** plain text, or `{"KeyName":…}`. Try both on our TV.
  - App state is pushed on the retained `/remoteapp/mobile/broadcast/ui_service/state` (`statetype`
    `app` + `name`, `remote_launcher` = home screen, `fake_sleep_0` = standby).
  - Sidee installs hosted web-app tiles with `ui_service/uievent`
    `{"type":"app_install","app_info":{"Title","StoreType":99,"Id","Image","URL",…}}`.
- **What MQTT does not do:**
  - There is no close action. Close is `KEY_EXIT`.
  - No working uninstall. `uninstallapp` exists in an old APK action table but gets no answer on VIDAA 9.
    Uninstall is the launcher tile's Remove.
  - No logs.
- **Unverified on our TV:** whether `launchapp` starts a DevKit-sideloaded app. It should, if DevKit
  registers a launcher tile; Suitest says those get the id `debug-<AppId>`.

**Rejected or deferred:**
- vidaa-edge / `Hisense_installApp`: needs DNS-spoofing `vidaahub.com`, and newer firmware removed it.
- weinre: deprecated.
- vConsole / Eruda: draw on the TV screen.
- Chii through a rewriting proxy: full DevTools on any firmware, but the app then runs on our
  origin (storage, DRM licence and CORS risk). Only if 9226 is closed.

### Design

**CDP** is the Chrome DevTools Protocol, the JSON-over-WebSocket protocol that DevTools itself uses
to control a Chromium browser. It lets you run JS in a page, click, read the console and watch the
network. Playwright and Puppeteer are wrappers around it.

**Driving DevKit Web: raw CDP, not Playwright or Selenium.**
- Playwright would mean shipping Node + Playwright (~100 MB+) as a sidecar.
- Selenium needs a chromedriver that matches the installed Chrome.
- Playwright's own `connectOverCDP` is just "launch Chrome with `--remote-debugging-port`, then speak
  CDP". We already speak CDP (Tizen/LG stress) and already have `tokio-tungstenite`, so we do that
  directly, with no new dependency.

```
[Connect DevKit] ─► Rust launches Chrome/Edge/Chromium:
                      --remote-debugging-port=<free port>
                      --user-data-dir=<app-data>/vidaa-devkit-profile   (persistent: OAuth survives)
                      --no-first-run  https://partner-doc.vidaa.com/vdocs/more/devkitweb.html
                  ─► user signs in + types the TV's connection code (the only manual step)
                  ─► app polls the page until the App Sideload form exists
                  ─► Browser.setWindowBounds {windowState:"minimized"}, refocus our window
                  ─► every action = Runtime.evaluate(<driver JS>) on that page target
```

- **Browser discovery:** standard install paths for Chrome, Edge, Chromium and Brave on
  macOS / Windows / Linux. Safari has no CDP. If none is found, say so plainly.
- **Logged in or not** is read from the page, not assumed. A session that drops (expired code, TV
  disconnected) surfaces as "Reconnect DevKit" rather than a silent failure.
- **Never automate the sign-in or the connection code.** The user types both.

**One driver file holds every DevKit selector**, so a VIDAA redesign is a one-file fix. The page is Vue 2
+ Element-UI, so setting `input.value` is not enough: dispatch an `input` event so Vue's `v-model` sees it.

| Action | Selector (from the live DOM) |
|---|---|
| Tabs | `.el-tabs__item` by text: `Index`, `App Sideload`, `Logger` |
| Installed apps | `.appManageLeft .itemWrapper` → `.appName`, `.appUrl`, `img.icon[src]` |
| AppUrl input | `label[for=url] + .el-form-item__content input` |
| Launch | `.urlInput button.el-button--primary` |
| Type (720P / **1080P** / HbbTV / Vewd / NetRange) | click `label[for=resolution] + … .el-select`, then `li.el-select-dropdown__item` by text |
| AppName | `label[for=name] + .el-form-item__content input` |
| IconUrl | `label[for=IconUrl] + .el-form-item__content input` |
| configUrl (Ads, Pay&Account, IOT, NavigateTo, Game, CrossDomain, All) | same pattern as Type |
| Install / Clear | last form item: `button.el-button--primary` / `button.el-button--default` |

**Where each operation comes from:**

| Operation | Primary | Fallback | Depends on |
|---|---|---|---|
| List installed apps | MQTT `applist` | DevKit Web, Installed Apps panel | client cert + pairing |
| Install | DevKit Web form (official; presets from the URL table; Type `1080P`) | MQTT `uievent` `app_install` (community, one implementation) | — |
| Launch | MQTT `launchapp` with the applist entry | DevKit Web, AppUrl + Launch | the launchapp check on our TV |
| Close | MQTT `sendkey KEY_EXIT`, confirmed by the state topic going to `remote_launcher` | TV CDP `window.close()` | client cert / 9226 |
| Uninstall | none programmatic; the launcher tile's Remove | ask VIDAA (PEM) | — |
| Running app / standby | MQTT retained `broadcast/ui_service/state` | — | client cert |
| Inspect | open the target's DevTools frontend (`devtoolsFrontendUrl` from `/json/list`), as `chrome://inspect` does | `http://<tv-ip>:9226` | 9226 opened by VIDAA |
| Live logs | TV CDP: `Runtime.enable`, `Log.enable` → `DeviceLogService` | DevKit Web **Logger** tab | 9226 / phase 0 |
| Environment / version | `appEnvironment()` on the app URL; the version from the hosted bundle's `APP_VERSION`, as `lg-hosted-app-version.service.ts` does | — | — |

**Debug mode on U9: what does not work, so nobody retries it.**
- `hisense://debug` and its `debug_on` button were removed in 2023+ firmware. AVForums reports it on
  U7; NoobyGains/stremio-vidaa-tv#36 reports it on a U9 `V0002.09.60C`.
- The "1234 in About" developer unlock has no effect on U9.
- There is no ADB: VIDAA is not Android. The Chinese "海信开发者模式 ADB" guides are for Hisense
  Android TVs.
- CDP on 9223 only worked on 2016-era firmware.
- The DNS-spoofed `Hisense_installApp` "succeeds" on U9 but adds no tile.
- Repeated probes of our TV, with FreeTV in the foreground, found none of 9222–9230 open. Opening it is VIDAA's call (see
  the PEM questions).

**Questions for VIDAA through the PEM.** Send them with the TV's MAC, Device Code and Device ID from
the DevKit home screen.
1. The DevTools port is closed on 43E70QEVS (MTK9603_EU_A, U09.60, V0000.09.60W.Q0612): TCP 9222–9230
   are refused even with a DevKit-sideloaded app in the foreground. Which port does MTK9603/9.60 use,
   and what secure key, debug firmware or DevKit setting opens it?
2. What is the remote-debug procedure on U9 now that `hisense://debug` / `debug_on` is gone? Can an
   app enable it through `Hisense_setDebugPort()`?
3. How do we uninstall a DevKit-sideloaded app? Is there an API (DevKit Web or otherwise) to install,
   launch, close and uninstall from automated QA?
4. What does the DevKit **Logger** tab capture (app `console.log`, errors, network)? Can it export?
5. Can you issue a client certificate for local RemoteNOW MQTT (36669) control of our own test sets?
6. Is there an emulator or local SDK, or is DevKit on a device the only path?

### Phases

**Phase 0: checks on a real TV.** These need a person with the TV.
1. ~~DevTools port probe~~: done, closed. Send the PEM questions.
2. MQTT spike, once QA has the client `.p12`. Run a throwaway script (pyvidaa or Sidee, not shipped):
   pair with the PIN, then confirm on our TV that:
   - `applist` lists the DevKit-installed FreeTV builds (record their `appId` / `url` / `storeType`)
   - `launchapp` starts one
   - `sendkey KEY_EXIT` closes it (and which payload form works)
   - the state topic reports both transitions

   This decides whether Launch and Close go over MQTT or through DevKit Web.
3. In DevKit Web with DevTools → Network: open the Logger tab while FreeTV runs and record what it
   shows. Note the main JS bundle URL from Sources.
4. ~~Record the TV model and VIDAA version~~: done (see "Our test TV").

**Phase 1: platform skeleton.**
- Add `'vidaa'` to `Platform` (`device-provider.interface.ts`) and `LogPlatform` (`device-log.model.ts`).
- Lazy `/vidaa` module with `apps` / `info` / `devices`, mirroring `tizen.module.ts`.
- Enable the VIDAA card in `platform-selector.component.html`, and add a VIDAA chip in the
  platform switcher of the Tizen, Android TV and LG shells.
- `VidaaStateService`: saved TVs `{name, ip}` in localStorage, keys `smart-tv-qa-vidaa-*`.
- Info tab: model and firmware from the UPnP descriptor; `transport_protocol` decides the auth profile.

**Phase 2a: MQTT control (if the phase 0 spike passes).**
- New Rust plugin `vidaa` (`plugins/vidaa.rs`) using `rumqttc` with `TlsConfiguration::Rustls`:
  - a verifier that accepts RemoteCA without the name check
  - client auth from PEM
  - `set_max_packet_size(1<<20, 1<<20)`
  - one long-lived connection per TV
- Credential derivation with unit tests on the vectors above.
- Commands: `vidaa_pair`, `vidaa_submit_pin`, `vidaa_list_apps`, `vidaa_launch`, `vidaa_send_key`, and
  `vidaa_state` as an event channel.
- Tokens and uuid stored per TV in the app data dir, not localStorage.
- The cert is loaded from a `.p12` QA picks once. It is converted in-app with the known password and
  never committed.
- UI:
  - Pair (PIN dialog)
  - the app list with environment badge and version
  - **Launch / Close** per row, the same buttons as Tizen
  - a small remote (arrows, OK, Back, Home, Exit)

**Phase 2b: DevKit Web bridge (install; and launch/list if MQTT is unavailable).**
- `vidaa_devkit_open` / `_status` / `_close` / `_install`, plus `_list` / `_launch` as fallbacks. This is
  the CDP-driven Chrome described above, with the driver JS beside it via `include_str!`.
- Install with one-click PreProd / UAT / Prod presets, plus a custom URL, through the progress dialog.

For either plugin, list every command in all three places (see
[Adding a Tauri Command](#adding-a-tauri-command--three-places-not-one)), and extend `acl_tests` to it.

**Phase 3: TV DevTools (once VIDAA opens the port).**
- Inspect button.
- A persistent CDP log stream into `DeviceLogService`, plus a log viewer component (filter, search,
  copy). Nothing consumes `DeviceLogService` today, so the same viewer can later serve Tizen
  (`sdb dlog`) and Android TV (`logcat`).
- The stress test, reusing the Tizen CDP check. Until then, stress can run launch → wait → state
  topic says `app` → `KEY_EXIT`, without the title check.
- Until 9226 opens: the DevKit Logger tab, if phase 0 shows it carries the console.

**Phase 4: docs and tests.**
- Rust unit tests for credential derivation, browser discovery and CDP target selection.
- Update this section with what phase 0 found.

### Risks

- **DevKit Web markup changes:** contained in the one driver file. Every driver call reports which
  selector failed.
- **Sessions expire:** detect it and offer Reconnect. Never retry the connection code.
- **No Chromium-family browser installed:** explicit message. Safari cannot be driven.
- **9226 closed on our firmware** (repeated probes confirm it): ask VIDAA via the PEM to open it. Until then, full console logs need the DevKit Logger, Chii, or a debug flag from the FreeTV team.
- **MQTT client certificate:** Hisense's own key, extracted from their app. Don't commit or redistribute
  it; prefer a cert from VIDAA. Hisense can rotate it: the 2018 one is already rejected.
- **MQTT tokens vanish on a deep power-off:** detect rc=4/5, try a refresh once, then ask to re-pair.
- **DevTools frontend version mismatch:** VIDAA asks for a Chromium matching the TV's WEBRUNTIME. Our own log stream speaks raw CDP (`Runtime` / `Log` domains, stable across versions), so this only affects the Inspect window.
- **A DevKit-sideloaded app may not get the URL as its CDP target title:** match targets by URL first,
  then by title.

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

## Session History

### June 2026 Session

#### Samsung Tizen — Signed WGT Install
The build system produces double-packaged WGTs with files at both root (unsigned) and `.buildResult/` (signed). TV rejects the unsigned root with `[118, -12]`.

**Pipeline in `samsung_tizen.rs → tizen_install_signed`:**
1. **Graceful disconnect** — `sdb disconnect <ip>:26101` tells TV daemon to release session
2. **Kill server** — `sdb kill-server` drops TizenBrew reverse tunnel
3. **Wait 1s** — TV port needs time to free
4. **Connect with retry** — `sdb connect` up to 4 attempts, 1.5s apart
5. **Match certificate** — read the TV's DUID, pick the profile issued for it
6. **Repack** — strip root duplicates, keep only `.buildResult/` content, remove old signatures
7. **Sign** — `tizen package -t wgt -s <profile>`
8. **Install** — `tizen install -n file.wgt -s <ip>:26101`
9. **Disconnect** — cleanup

**`[118, -12]` has two causes, not one.** Besides the unsigned root above, a distributor certificate
is issued for a fixed list of TV DUIDs — signing with a profile that does not cover the target TV
yields the *same* "Unsigned file error" on a package that is signed correctly. The app keeps one
global cert profile for all devices, so picking a different TV in the dropdown used to silently sign
with the previous TV's certificate. Step 5 now reads the DUID (`read_duid`) and cross-references the
`<TestDevice>` entries in each profile's `device-profile.xml` (`parse_cert_profiles`), overriding the
saved profile when it does not cover the TV and failing with the DUID when nothing does.

**Key insight:** TizenBrew creates a reverse tunnel (TV→Mac). `kill-server` alone only kills the Mac side — the TV still holds the session. Must `sdb disconnect` first for the TV to release the port immediately.

#### Progress Dialog — Visual Step List
`src/app/shared/components/progress-dialog/`

Replaced bare progress bar with a step list during long operations:
- `○` pending (dimmed) → `⟳` active (spinning blue) → `✓` done (green) → `✕` failed (red)
- API: `dialog.setSteps([...])` then `dialog.update(msg, pct, stepKey)`

#### Samsung Tizen — Stress Test
In `src/app/tizen/apps/tizen-apps.component.ts`:
- **Stress button** next to Inspect on each app
- Each cycle: launch via `sdb.debug()` (gets CDP port without restart) → wait 30s → WebSocket CDP eval for `h1.metadata__title` → kill → wait 10s
- Results table: cycle, Live/VOD badge, title, channel, action buttons, FOUND/MISSING

**Two critical fixes discovered:**
1. Must call `sdb.debug()` at launch time (not after waiting) — `debug` restarts the app
2. Tizen's `webSocketDebuggerUrl` uses `localhost` — must rewrite to TV's IP before WebSocket connect

#### Other Fixes
- LG WebOS app buttons: fixed wrapping (5 buttons: Inspect/Launch/Kill/Stress/Remove stayed on one row by switching from `grid` with hardcoded 4 columns to `flex`)
- Dead code removed: `extract-icons.ts`, `samsung-tizen.service.ts`, `permissions/vidaa/`, `permissions/samsung-tizen/`, `icon.png` (root), `scripts/generate-lg-badge-previews.js`
- Workspace file renamed: `FreeTV-QA-Tool.code-workspace` → `Smart-TV-QA-Tool.code-workspace`
- `.gitignore` updated: added `*.wgt`, `*.apk`, `.history/`, session notes

---

See also `README.md` (user-facing setup).
