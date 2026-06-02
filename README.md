# Smart TV QA Tool

> A unified desktop app for QA engineers to manage, install, inspect, and stress-test apps across multiple Smart TV platforms — from one window.

Built with **Tauri 2** (Rust backend) + **Angular 17** frontend. Runs natively on macOS, Windows, and Linux.

---

## Supported Platforms

| Platform | Status | Connection | App Format |
|----------|--------|------------|------------|
| 🟦 **Samsung Tizen** | ✅ Full | SDB TCP:26101 | WGT / TPK |
| 🤖 **Android TV** | ✅ Full | ADB TCP:5555 | APK |
| ⬛ **LG WebOS** | ✅ Full | SSH:22/9922 | IPK |
| 🟧 **VIDAA (Hisense)** | 🔜 Planned | MQTT-TLS:36669 | — |

---

## Features

### All Platforms
- 📋 **App list** — view all installed developer apps with version numbers
- ▶️ **Launch / Kill** — start and stop apps instantly
- 📦 **Install** — sideload packages directly from your Mac/PC
- 🗑️ **Uninstall** — remove apps from the device
- 🔍 **Inspect** — open Chrome DevTools remote debugger for the running app
- 🔁 **Stress test** — automated launch/kill cycles with CDP verification that content loads (`h1.metadata__title`)
- ℹ️ **Device info** — model, OS version, firmware details

### Samsung Tizen Extras
- **Signed WGT install** — automatically repacks double-packaged builds, signs with your certificate, and installs via `tizen` CLI
- **Certificate wizard** — guided setup to pick your `.p12` from `~/SamsungCertificate/`
- **TizenBrew protocol** — supports `vd_appinstall`, `vd_applist`, `was_execute` for sideloading on retail TVs

### LG WebOS Extras
- **File manager** — browse and transfer files over SFTP
- **Terminal** — SSH PTY shell directly in the app
- **Dev mode management** — renew developer session tokens

---

## Screenshots

> _Coming soon — TV must be connected to generate screenshots_

---

## Requirements

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 20+ | `.nvmrc` is set to `20` |
| Rust | 1.92+ | Install via [rustup](https://rustup.rs) |
| Tizen Studio | Latest | For Samsung: provides `sdb` and `tizen` CLI |
| ADB | Any | For Android TV (downloaded automatically via setup script) |

---

## Setup

### 1. Clone and install dependencies

```bash
git clone https://github.com/boris-sionov/smart-tv-qa-tool.git
cd smart-tv-qa-tool
npm install
```

### 2. Download platform binaries

```bash
# macOS / Linux
npm run setup

# Windows (PowerShell)
npm run setup:win
```

This downloads the ADB and SDB binaries into `src-tauri/binaries/`.

### 3. Run in development mode

```bash
npm run start
```

Starts Angular dev server on port `4281` with hot-reload and launches the Tauri window.

### 4. Build for production

```bash
npm run build
```

**Output locations:**
- macOS: `src-tauri/target/release/bundle/dmg/Smart TV QA Tool_*.dmg`
- Windows: `.../msi/Smart_TV_QA_Tool_*.msi`
- Linux: `.../deb/smart-tv-qa-tool_*.deb`

---

## Platform Setup Guides

### Samsung Tizen

1. Enable **Developer Mode** on your TV:
   - Settings → Support → Developer Mode → On
   - Enter your Mac/PC IP address
   - Reboot the TV

2. Install **Tizen Studio** (provides `sdb` and `tizen` CLI):
   - Download from [developer.samsung.com/smarttv](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html)

3. Open Smart TV QA Tool → Samsung Tizen → **Manage** → Add device

4. For signed installs: go to **Manage** → configure your certificate (browse `~/SamsungCertificate/`)

### Android TV

1. Enable **Developer Options** on your Android TV:
   - Settings → Device Preferences → About → Build (click 7×)
   - Enable ADB over Network

2. Open Smart TV QA Tool → Android TV → **Manage** → Add device (enter TV IP)

3. ADB binary is downloaded automatically by `npm run setup`

### LG WebOS

1. Enable **Developer Mode** via the [LG Developer Mode app](https://webostv.developer.lge.com/develop/getting-started/developer-mode-app) on your TV

2. Open Smart TV QA Tool → LG → **Manage** → Add device

---

## Project Structure

```
smart-tv-qa-tool/
├── src/
│   └── app/
│       ├── platform-selector/       # Startup platform chooser
│       ├── tizen/                   # Samsung Tizen UI module
│       │   ├── apps/                #   app list, install, stress test
│       │   ├── devices/             #   device management
│       │   └── wizard/              #   add device + cert setup
│       ├── android-tv/              # Android TV UI module
│       ├── apps/                    # LG WebOS app management
│       ├── lg/                      # LG WebOS shell
│       ├── files/                   # LG file manager
│       ├── terminal/                # LG SSH terminal
│       ├── debug/                   # LG debug tools
│       ├── shared/components/       # Reusable UI components
│       │   └── progress-dialog/     #   step-list progress UI
│       └── core/services/           # Platform service layer
│           ├── sdb.service.ts       #   Samsung Tizen (DeviceProvider)
│           ├── adb.service.ts       #   Android TV (DeviceProvider)
│           └── device-provider.factory.ts
│
├── src-tauri/
│   └── src/
│       ├── plugins/
│       │   ├── samsung_tizen.rs     # Tizen: repack/sign/install/debug
│       │   ├── adb.rs               # Android TV: ADB orchestration
│       │   ├── lg_remote.rs         # LG: remote control
│       │   ├── cmd.rs               # LG: SSH remote exec
│       │   ├── shell.rs             # LG: SSH PTY shells
│       │   └── file.rs              # LG: SFTP file ops
│       ├── device_manager/          # SSH device config + key management
│       ├── session_manager/         # SSH connection pooling
│       └── lib.rs                   # Tauri init + plugin registration
│
├── scripts/
│   ├── download-adb.sh              # Downloads ADB binary (macOS/Linux)
│   ├── download-adb.ps1             # Downloads ADB binary (Windows)
│   ├── download-sdb.sh              # Downloads SDB binary (macOS/Linux)
│   └── download-sdb.ps1             # Downloads SDB binary (Windows)
│
├── CLAUDE.md                        # Claude Code project instructions
├── AGENTS.md                        # Developer / agent reference
└── Smart-TV-QA-Tool.code-workspace  # VS Code workspace
```

---

## Architecture

All platform operations go through Tauri `invoke()` to Rust — the UI never calls CLIs directly.

```
Angular UI
    │  invoke('plugin:adb-manager|<command>')
    ▼
Tauri Rust Backend
    ├── samsung_tizen.rs  ─── sdb / tizen CLI
    ├── adb.rs            ─── bundled ADB sidecar
    └── cmd/shell/file.rs ─── SSH + SFTP (LG)
```

All platform services implement the `DeviceProvider` interface, resolved at runtime via `DeviceProviderFactory.get(platform)`.

---

## Development Notes

```bash
# Angular CLI (sets required Tauri env vars)
npm run ng -- generate component foo
npm run ng -- test

# Check Rust compilation
cargo check --manifest-path src-tauri/Cargo.toml
```

The `.nvmrc` pins Node 20. If you use nvm: `nvm use` in the project root.

The `.npmrc` pins exact dependency versions (`save-exact=true`) for reproducible builds.

---

## Roadmap

- [ ] Fix device info display across all platforms
- [ ] VIDAA TV (Hisense) — MQTT-over-TLS implementation
- [ ] Screenshot capture from TV (SDB shell + CDP)
- [ ] LG WebOS `WebOSProvider` in platform factory
- [ ] Persistent device state (no wipe on app restart)
- [ ] Mac `.dmg` distribution build

---

## Credits

| Component | Origin |
|-----------|--------|
| LG WebOS backend | Forked from [`webosbrew/dev-manager-desktop`](https://github.com/webosbrew/dev-manager-desktop) |
| Samsung Tizen | Built from scratch using SDB + tz CLI |
| Android TV | Ported from an internal Python/PySide6 QA tool |
| VIDAA research | Based on [`tombabolewski/vidaa-control`](https://github.com/tombabolewski/vidaa-control) |

---

## License

See [LICENSE](LICENSE).
