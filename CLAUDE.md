# FreeTV Multi-Platform Device Manager

## What This Project Is

A **unified Tauri + Angular desktop application** for managing FreeTV apps across three TV platforms:
- **LG WebOS** — SSH + Luna services (mostly complete)
- **Android TV** — ADB over TCP/IP (feature-complete, needs integration)
- **Samsung Tizen** — SDB (Smart Development Bridge) — **to be built**

One app, three platforms, one device list.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│    Unified Tauri + Angular Frontend (Single Desktop App) │
│         Platform Selector Screen → Shared Device List    │
└─────────┬──────────────────────┬─────────────────────┬───┘
          │                      │                     │
   ┌──────▼──────────┐    ┌──────▼──────────┐   ┌────▼────────┐
   │  LG WebOS       │    │ Android TV      │   │ Samsung      │
   │  Manager        │    │ Manager         │   │ Tizen        │
   │                 │    │                 │   │ Manager      │
   │ - SSH/Luna      │    │ - ADB (Rust)    │   │ - SDB (Rust) │
   │ - Plugin: webos │    │ - Plugin: adb   │   │ - Plugin: sdb│
   │ - ~95% done     │    │ - Port from     │   │ - New build  │
   │                 │    │   PySide6       │   │ - 0% done    │
   └─────────────────┘    └─────────────────┘   └─────────────┘
           ↓                      ↓                     ↓
           └──────────────────────┴─────────────────────┘
                  Rust Backend Plugins
                  (src-tauri/src/plugins/)
```

**One App. Three Platforms. One UI Framework.**

---

## Project Locations

| Platform | Current Source | Status | Target Stack | Action |
|---|---|---|---|---|
| **LG WebOS** | `/Users/borissionov/Privet/Projects/dev-manager-desktop` | 95% ✅ | Tauri + Angular | Move to unified repo, no changes |
| **Android TV** | `/Users/borissionov/PycharmProjects/AndroidQATool` | 100% ✅ (logic) | Tauri + Angular | Port ADB logic to Rust backend |
| **Samsung Tizen** | *Not started* | 0% | Tauri + Angular | Build from scratch (SDB in Rust) |
| **QA AI Tool** | `/Users/borissionov/PycharmProjects/FreeTVQATool` | 100% ✅ | Python Streamlit | Separate project (not part of device manager) |

---

## High-Level Integration Plan

### Phase 1: LG WebOS (Nearly Done)
- ✅ Device connection (SSH)
- ✅ App list with icons
- ✅ Install / Launch / Remove / Clear Data
- ✅ Inspect button (opens port 9998)
- ✅ Change App Icon
- ✅ Open RCU / debug panel

### Phase 2: Integrate Android TV
Move the working PySide6 app into the Tauri backend as a **platform service**:
- Android TV connection logic → backend module
- ADB calls → backend Rust plugin (like file.rs, cmd.rs)
- UI stays unified Angular frontend
- Reuse device list + app management patterns from LG

### Phase 3: Build Samsung Tizen (New)
1. Set up Samsung Tizen emulator (from Tizen Studio)
2. Implement SDB protocol:
   - Device discovery
   - App listing
   - Install (WGT packages)
   - Launch / Kill
   - Clear data
3. Wire into unified Angular UI
4. Test with emulator (no hardware needed initially)

---

## Android TV Integration Strategy: Port to Tauri + Angular

The PySide6 app at `/Users/borissionov/PycharmProjects/AndroidQATool` is **production-ready**. We will **port the ADB logic to Rust** and integrate into the unified Tauri backend.

### Why This Approach

- ✅ **Single unified app** — one installer, one window, one UX
- ✅ **Shared device list** — manage all three platforms from one place
- ✅ **Consistent UI** — all platforms use Angular components
- ✅ **Professional packaging** — .app/.exe/.deb works for all
- ✅ **Easier long-term** — one codebase = easier maintenance for Samsung Tizen

### What Needs to Happen

1. **Port ADB logic** (`core/adb_manager.py` → Rust plugin)
   - ~300 lines of Python, straightforward to translate
   - Each ADB command becomes a Rust function in `src-tauri/src/plugins/android-tv/adb.rs`
   - Example:
     ```python
     # Python
     subprocess.run(['adb', 'connect', f'{ip}:5555'])
     
     # Rust
     Command::new("adb").args(&["connect", &format!("{}:5555", ip)]).output()?
     ```

2. **Integrate Appium** (already HTTP-based, minimal changes)
   - `AppiumManager` logic can mostly stay the same
   - Just call the Tauri backend instead of local Python

3. **Create Android TV Angular components**
   - Reuse patterns from LG manager
   - Device connection, app list, actions grid

4. **No changes to LG WebOS** — leave it as-is

### Effort & Timeline

- **Porting ADB logic**: 1-2 days
- **Appium integration**: ~4 hours
- **Angular UI components**: 1 day
- **Testing**: 1 day
- **Total**: 3-5 days for a fully integrated Android TV manager

---

## Samsung Tizen — Getting Started

### Tools Needed
1. **Tizen Studio** (free, from Samsung)
   - Includes `sdb` (Smart Development Bridge — like ADB for Tizen)
   - Includes TV emulator (or use remote test lab cloud devices)

2. **tizen CLI** (npm install -g tizen)
   - Package apps as `.wgt` files
   - Deploy to devices

### Device Connection (SDB)
```bash
sdb connect <ip>:26101        # Connect to Tizen TV
sdb devices                   # List connected devices
sdb -s <ip>:26101 shell ...   # Run commands
sdb -s <ip>:26101 push <file> <remote>  # Install WGT
```

### Key SDB Commands (Tizen Equivalent of ADB)
| Operation | ADB (Android) | SDB (Tizen) |
|---|---|---|
| Connect | `adb connect <ip>:5555` | `sdb connect <ip>:26101` |
| List devices | `adb devices` | `sdb devices` |
| Install | `adb install <apk>` | `sdb push <wgt> /opt/usr/apps/` |
| Launch | `adb shell am start <pkg>/<act>` | `sdb shell 0 execute <app-id>` |
| Kill | `adb shell am force-stop <pkg>` | `sdb shell 0 execute 0 kill <app-id>` |
| Shell | `adb shell` | `sdb shell` |

### Tizen Emulator Setup
```bash
# Download Tizen Studio
# Create TV emulator: Tools → Emulator Manager → Create
# Run emulator: Press "Launch"
# Device will appear in sdb devices
# Connect with SDB on 127.0.0.1:26101
```

---

## Code Structure for Unified App

```
FreeTV-MultiPlatform-Manager/
├── src/                                     # Angular Frontend (Unified UI)
│   └── app/
│       ├── platform-selector/              # Landing page (3 platform cards)
│       │   ├── platform-selector.component.ts
│       │   ├── platform-selector.component.html
│       │   └── platform-selector.component.scss
│       │
│       ├── shared/
│       │   ├── components/                 # Reusable UI components
│       │   │   ├── device-card/
│       │   │   ├── action-button/
│       │   │   └── log-panel/
│       │   └── services/
│       │       └── device.service.ts       # Shared device management
│       │
│       └── platforms/
│           ├── webos/                      # LG Manager (existing dev-manager-desktop)
│           │   ├── device-list/
│           │   ├── app-manager/
│           │   └── ...
│           ├── android-tv/                 # Android TV Manager (NEW)
│           │   ├── device-list/
│           │   ├── app-manager/
│           │   ├── rcu-dialog/
│           │   └── ...
│           └── tizen/                      # Samsung Tizen Manager (NEW)
│               ├── device-list/
│               ├── app-manager/
│               └── ...
│
├── src-tauri/                              # Rust Backend (Multi-Platform Plugins)
│   └── src/
│       ├── plugins/                        # Command modules
│       │   ├── webos.rs                   # Luna + SSH calls (existing)
│       │   │
│       │   ├── android_tv.rs              # ADB wrapper (ported from PySide6)
│       │   │   ├── adb_commands.rs        # Core ADB operations
│       │   │   ├── appium.rs              # Appium integration
│       │   │   └── rcu.rs                 # Remote control commands
│       │   │
│       │   └── tizen.rs                   # SDB wrapper (new)
│       │       ├── sdb_commands.rs        # Core SDB operations
│       │       └── tizen.rs               # Tizen-specific commands
│       │
│       ├── conn_pool/                     # Connection management
│       ├── device_manager/                # Shared device utilities
│       └── lib.rs                         # Tauri setup + route handlers
│
├── package.json
├── tauri.conf.json
├── Cargo.toml
└── ...
```

**Key Principle**: All three platforms share the same Angular UI framework and connect through Tauri plugins in the backend.

---

## Device List — Shared Across Platforms

One unified device list showing:
- Device name + IP
- Platform icon (LG | Android | Tizen)
- Connection status (🟢 Connected | 🔴 Disconnected)
- Last used time
- Quick action buttons (Connect, Open Manager, Disconnect)

Clicking a device opens the **platform-specific manager** for that device.

---

## Development Roadmap (Unified Codebase)

### Phase 1: Prepare Foundation (Week 1)
- ✅ Document architecture (DONE)
- ✅ Create platform selector component (DONE)
- [ ] Set up unified Tauri + Angular monorepo
- [ ] Copy dev-manager-desktop as base
- [ ] Create plugin folder structure in Rust backend

### Phase 2: Port Android TV to Tauri (Week 1-2, ~3-5 days)
- [ ] Port `adb_manager.py` → `src-tauri/src/plugins/android_tv/adb.rs`
- [ ] Port `rcu_manager.py` → Rust RCU commands
- [ ] Port `appium_manager.py` → Appium integration
- [ ] Create Android TV Angular components (device list, app manager, RCU dialog)
- [ ] Wire into router: `/platforms/android-tv`
- [ ] Test with real Android TV device ✅ Works perfectly

### Phase 3: Build Samsung Tizen from Scratch (Week 2-3, ~5-7 days)
- [ ] Set up Tizen emulator (or use Samsung RTL cloud devices)
- [ ] Implement SDB protocol in Rust (`src-tauri/src/plugins/tizen/sdb.rs`)
- [ ] Create Tizen Angular components (reuse patterns from Android TV)
- [ ] Wire into router: `/platforms/tizen`
- [ ] Test with emulator + real device if available ✅ Success

### Phase 4: Unified Device Management (Week 3)
- [ ] Build shared device list (all 3 platforms)
- [ ] Implement platform-aware connection UI
- [ ] Cross-platform device tagging and persistence
- [ ] Shared logging across all platforms

### Phase 5: Polish & Package (Week 4+)
- [ ] Comprehensive error handling
- [ ] Add app icon display for all platforms
- [ ] Add inspect/DevTools support (port forwarding)
- [ ] Package as .app/.exe/.deb for macOS/Windows/Linux
- [ ] Documentation + deployment guide

---

## No Changes to LG WebOS

LG is left **exactly as-is**:
- All existing code stays untouched
- Just gets moved into the unified monorepo
- Plugin stays at `src-tauri/src/plugins/webos.rs`
- Components stay in `src/app/platforms/webos/`

---

## Key Files to Reference

| File | Purpose |
|---|---|
| `/Users/borissionov/Privet/Projects/dev-manager-desktop/CLAUDE.md` | LG WebOS app docs |
| `/Users/borissionov/PycharmProjects/AndroidQATool/CLAUDE.md` | Android TV app docs |
| `/Users/borissionov/PycharmProjects/AndroidQATool/core/adb_manager.py` | ADB logic to port |
| `/Users/borissionov/PycharmProjects/AndroidQATool/core/appium_manager.py` | Appium wrapper to adapt |

---

## Testing Strategy

### Android TV
- Real device: use any Android TV / Google TV device on local network
- Or: Android emulator (from Android Studio) with ADB over TCP

### Samsung Tizen
- **Tizen Emulator** (free, from Tizen Studio) — sufficient for dev
- Or: Samsung Remote Test Lab (cloud-based real devices, free limited tier)
- Or: physical Samsung Smart TV in dev mode

### LG WebOS
- Real LG TV with dev mode enabled
- Or: check if LG offers emulator / simulator

---

## Important Notes

- **Unified Approach**: One Tauri + Angular app for all three platforms. No PySide6, no separate apps.
- **LG WebOS**: ✅ Feature-complete. Will be moved into unified repo **with zero code changes**. Left exactly as-is.
- **Android TV**: ✅ Logic is battle-tested in PySide6 app. ADB commands (~300 lines) will be ported to Rust. Expected effort: 3-5 days.
- **Samsung Tizen**: Starting from scratch with SDB (Tizen's equivalent to ADB). Tizen emulator requires no hardware. Expected effort: 5-7 days.
- **Shared Infrastructure**: 
  - All platforms use Tauri plugins in the backend
  - All platforms use Angular components in the frontend
  - Shared device list, logging, error handling
  - One installer, one window, professional UX

---

## Who Built What

- **LG WebOS app**: Existing `/dev-manager-desktop` project (Tauri + Angular)
- **Android TV app**: `/PycharmProjects/AndroidQATool` (Python PySide6) — can be ported or integrated
- **Samsung Tizen**: Needs to be built from scratch (recommend Rust in Tauri for consistency)
- **QA AI Tool**: `/PycharmProjects/FreeTVQATool` — separate project (Streamlit), not part of device manager
