# Smart TV QA Tool - v1.0.0

A **unified Tauri + Angular desktop application** for managing apps across multiple Smart TV platforms.

**Current Focus:** Samsung Tizen (via SDB)  
**Completed:** Android TV architecture & design system  
**Future:** VIDAA (via MQTT), LG WebOS (via Luna API)

---

## Project Status (April 28, 2026)

### ✅ COMPLETED
- [x] App renamed from "FreeTV QA Tool" to "Smart TV QA Tool"
- [x] Version bumped to 1.0.0
- [x] All original webOS Dev Manager branding removed (no traces)
- [x] Modern dark theme design system implemented
- [x] Data clearing on startup (fresh state every launch)
- [x] Update notification dialog removed
- [x] Angular stylesheet budgets increased for modern design
- [x] Platform selector UI with brand new design
- [x] Icon system updated with new app branding
- [x] Android TV ADB service fully functional
- [x] Research completed on all platforms

### 🔄 IN PROGRESS - PRIORITY 1 & 2
- [ ] **Samsung Tizen support (SDB protocol)** - PRIMARY (Week 1)
  - [ ] Implement SDB connection module (Rust)
  - [ ] App control commands (launch, kill, install)
  - [ ] Angular UI components for Tizen
  - [ ] Test with Tizen emulator

- [ ] **VIDAA TV support (MQTT-over-TLS)** - SECONDARY (Week 3+)
  - [ ] Implement MQTT-over-TLS connection (Rust)
  - [ ] Port vidaa-control library logic
  - [ ] Angular UI components for VIDAA
  - [ ] Test with Hisense TV (or alternative)

### ⏳ PLANNED - AFTER TIZEN & VIDAA
- [ ] Embed ADB binary in .dmg (Android TV distribution) - Week 2
- [ ] LG WebOS support (Luna API) - After VIDAA
- [ ] Build Mac distributable (.dmg) - Final step

---

## What This Project Does

### Android TV (Current)
**Technology:** ADB (Android Debug Bridge) over TCP/IP  
**Status:** Feature-complete, wrapper approach, need distribution fix  
**Capabilities:**
- Connect to Android TV devices via network
- List installed apps
- Install/uninstall APK files
- Launch apps
- Get device information
- Extract app icons from APK files

**Current Architecture:**
```
User's System ADB → App calls system `adb` CLI → Commands executed
                        ❌ Problem: User must install ADB
```

**Planned Architecture (Next):**
```
Bundled ADB Binary → App calls bundled `adb` → Commands executed
                         ✅ Solution: No user setup needed
```

---

## Android TV Implementation Details

### Current ADB Approach
- **File:** `src/app/core/services/adb.service.ts`
- **Method:** Wraps system CLI (`adb` command)
- **Pros:** Works perfectly, stable commands
- **Cons:** Requires user to install Android SDK, hard to distribute

### Why NOT Native ADB Library?
- Existing Rust libraries (adb-rs) are immature
- Current CLI wrapper is reliable and well-tested
- Better to fix distribution than rewrite

### Recommended Solution: Embed ADB Binary

**What:** Package the official Android Platform Tools ADB binary inside the .dmg  
**Result:** Users open app → everything works (no setup)  
**Implementation:** 
1. Download official ADB binary from Google (~15MB)
2. Add to `src-tauri/resources/platform-tools/adb`
3. Update TypeScript to use bundled path instead of system PATH
4. Update `tauri.conf.json` to include files in bundle
5. Build .dmg automatically includes everything

**Code Changes:**
```typescript
// Before
const cmd = Command.create('zsh', ['-lc', `adb -s ${serial} shell pm list packages`]);

// After
const adbPath = await appDataDir() + 'platform-tools/adb';
const cmd = Command.create('zsh', ['-lc', `${adbPath} -s ${serial} shell pm list packages`]);
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│   Smart TV QA Tool v1.0.0                   │
│   Tauri + Angular Desktop Application       │
└──────────────┬──────────────────────────────┘
               │
        ┌──────┴──────┐
        │             │
    ┌───▼────┐    ┌──▼────────┐
    │ Android│    │ Tizen/WebOS│
    │   TV   │    │  (Future)  │
    │        │    │            │
    │ - ADB  │    │ - SDB/Luna │
    │ - TCP  │    │ - Protocols│
    │ - Ready│    │ - Planned  │
    └────────┘    └────────────┘
```

---

## App Branding (Complete Rebrand)

### Files Updated
- ✅ `package.json` - name, description, author, homepage, keywords
- ✅ `src-tauri/tauri.conf.json` - productName, identifier, copyright, descriptions
- ✅ `src/index.html` - title, favicon
- ✅ `src/app/platform-selector/platform-selector.component.html` - UI title
- ✅ `src/app/home/nav-more/nav-more.component.html` - GitHub link
- ✅ `src/app/add-device/retry-failed/retry-failed.component.html` - Error messages
- ✅ `src/app/terminal/dumb/dumb.component.html` - Help text
- ✅ `src-tauri/src/lib.rs` - Error dialog title
- ✅ `src-tauri/Cargo.toml` - Package metadata

### Original App References Removed
- ❌ No "webOS Dev Manager" anywhere
- ❌ No "webosbrew" (except legitimate Luna service APIs)
- ❌ No "dev-manager-desktop" (except legitimate package IDs)
- ❌ No old GitHub links

### Legitimate Preserved
- ✅ `org.webosbrew.hbchannel` - Real webOS service (kept)
- ✅ webOS API references - System information (kept)
- ✅ Luna service calls - Platform APIs (kept)

---

## Data Persistence (Fresh Start)

### Clears on Startup
- **Rust Backend:** Deletes `novacom-devices.json` on app startup
- **Angular Frontend:** Clears Android TV device localStorage
- **Result:** Every launch is a fresh state, no old data carried forward

**Implementation:**
```rust
// src-tauri/src/lib.rs - RunEvent::Ready
if let Some(conf_dir) = app.get_conf_dir() {
    let devices_file = conf_dir.join("novacom-devices.json");
    if devices_file.exists() {
        let _ = std::fs::remove_file(&devices_file);
    }
}
```

```typescript
// src/app/android-tv/adb-state.service.ts - constructor
constructor() {
    localStorage.removeItem('freetv-android-tv-devices');
    localStorage.removeItem('freetv-android-tv-selected-device');
}
```

---

## Design System

**Color Palette (Modern Glassmorphism):**
- Background: `#0F172B` (deep navy)
- Primary: `#5B9FF5` (vibrant blue)
- Accent: `#FF6B6B` (soft red)
- Text Primary: `#FFFFFF`
- Text Secondary: `#A8B8CC`

**Features:**
- Glassmorphism with blur effects
- Rounded corners (12-20px)
- Smooth transitions and hover states
- Modern system fonts (Segoe UI, San Francisco)
- Improved visual hierarchy

---

## Build & Distribution

### Requirements
- **Rust** - Install via: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **Node.js** 20+
- **macOS/Windows/Linux** - Tauri supports all

### Build Commands
```bash
npm install                    # Install dependencies
npm run build                  # Build for current platform
npm run start                  # Dev mode
```

### Output
- **macOS:** `src-tauri/target/release/bundle/dmg/Smart\ TV\ QA\ Tool_1.0.0_x64.dmg`
- **Windows:** `src-tauri/target/release/bundle/msi/Smart_TV_QA_Tool_1.0.0_x64.msi`
- **Linux:** `src-tauri/target/release/bundle/deb/smart-tv-qa-tool_1.0.0_amd64.deb`

---

## Android TV QA Tool Usage

### Prerequisites (User)
1. Android TV device on same network
2. Enable developer options on TV (usually in Settings)
3. Open Smart TV QA Tool (bundled ADB included)

### Connect to Device
1. Note TV IP address
2. Click "Add Device"
3. Enter IP:5555
4. Click "Connect"

### Manage Apps
1. Device appears in list
2. Click device to view installed apps
3. Install APK: Drag-drop or browse
4. Launch app: Click app in list
5. Uninstall: Right-click, select "Uninstall"

### View App Details
- App name (with friendly branding)
- Version number
- App icon (extracted from APK)
- Quick actions (Launch, Uninstall, Clear Data)

---

## Platform Research Summary

### Android TV (ADB)
**Status:** ✅ Complete  
**Connection:** TCP/IP on port 5555  
**Method:** ADB protocol (system CLI or embedded binary)  
**App Control:** Launch, kill, install, list  
**Feasibility:** ✅ Proven, works perfectly  
**Next:** Embed ADB binary for distribution

### Samsung Tizen (SDB)
**Status:** 🔄 In Progress (PRIMARY FOCUS)  
**Connection:** TCP/IP on port 26101  
**Method:** SDB (Smart Development Bridge) protocol  
**App Control:** Launch, kill, install WGT packages  
**Package Format:** .wgt (ZIP-based)  
**Feasibility:** ✅ Viable, well-documented  
**Architecture:** Mirror Android TV implementation  
**Timeline:** 1-2 weeks  

**Key Details:**
- Certificate-based authentication (like WebOS RSA keys)
- Requires developer mode enabled on TV
- No PIN needed after first connection
- SDB available from Samsung Tizen Studio
- Commands similar to ADB but different syntax

**Next Steps:**
1. Implement SDB connection module (src-tauri/src/device_manager/sdb.rs)
2. Create Tizen service API wrapper
3. Build Angular UI components
4. Test with Tizen emulator or device

### VIDAA TV (MQTT)
**Status:** ✅ Research Complete (Ready to Implement)  
**Connection:** MQTT-over-TLS on port 36669  
**Method:** Native MQTT protocol (built-in to all VIDAA TVs)  
**Credentials:** 
- Username: `hisenseservice`
- Password: `multimqttservice`
**App Control:** Launch, power control, volume  
**Feasibility:** ✅ Highly Viable  
**Market:** ~5% of Smart TVs (Hisense, Toshiba)  

**Key Findings:**
- Official protocol, not reverse-engineered
- Uses pub/sub messaging (very reliable)
- TLS encrypted by default
- No external CLI tool needed
- Working Python libraries exist: vidaa-control, ha-vidaa-tv
- Can be ported to Rust easily

**Architecture:** Direct MQTT connection (cleanest approach)  
**Timeline:** 1-2 weeks (after Tizen)  
**Priority:** After Samsung Tizen  

**Resources:**
- [vidaa-control GitHub](https://github.com/tombabolewski/vidaa-control) - Reference implementation
- [ha-vidaa-tv GitHub](https://github.com/tombabolewski/ha-vidaa-tv) - Home Assistant integration
- [hisensetv API Docs](https://hisensetv.readthedocs.io/en/latest/api.html)

### LG WebOS (Luna API)
**Status:** ⏳ Planned  
**Connection:** SSH on port 22  
**Method:** SSH + Luna Service API  
**Authentication:** RSA certificate-based  
**Feasibility:** ✅ Proven (original app)  
**Priority:** Lower (less market than Tizen)  

---

## Platform Comparison Matrix

| Aspect | Android TV | Tizen | VIDAA | WebOS |
|--------|-----------|-------|-------|-------|
| **Connection** | ADB/TCP:5555 | SDB/TCP:26101 | MQTT/TCP:36669 | SSH/TCP:22 |
| **Auth Type** | None | Certificate | Username/Pass | RSA Key |
| **App Launch** | ✅ Easy | ✅ Easy | ✅ Easy | ✅ Easy |
| **App Kill** | ✅ Easy | ✅ Easy | ✅ Yes | ✅ Easy |
| **Install Apps** | ✅ APK | ✅ WGT | ⚠️ Limited | ✅ IPK |
| **Documentation** | ✅ Excellent | ✅ Good | ⚠️ Partial | ✅ Good |
| **Dev Community** | ✅ Large | ✅ Medium | ⚠️ Small | ⚠️ Small |
| **Market Share** | 50%+ | 30%+ | ~5% | ~10% |
| **Implementation** | Wrapped CLI | Native SDB | Native MQTT | Existing code |
| **Effort** | Low (wrap ADB) | Medium (port SDB) | Medium (port MQTT) | Low (reuse) |
| **Reliability** | ✅ High | ✅ High | ✅ High | ✅ High |

---

## Development Roadmap (Updated)

### Week 1 - Samsung Tizen (PRIMARY FOCUS) 🔴

**Goal:** Implement basic Tizen device control via SDB protocol

**Tasks:**

1. **SDB Protocol Implementation** (3-4 days)
   - Create `src-tauri/src/device_manager/sdb.rs` (mirror of novacom.rs)
   - Implement TCP connection to port 26101
   - Handle certificate-based authentication
   - Parse device responses
   - Test with Tizen emulator

2. **Tizen Service Commands** (2-3 days)
   - List installed apps
   - Launch apps (similar to: `am start`)
   - Kill/stop apps (similar to: `am force-stop`)
   - Get device information
   - Install WGT packages

3. **Testing & Validation** (1-2 days)
   - Test with Samsung Tizen emulator (free)
   - Or with actual Tizen TV if available
   - Verify all commands work
   - Document command syntax

**Resources Needed:**
- Samsung Tizen Studio (free download)
- Tizen TV emulator
- Or access to actual Samsung Tizen TV

**Success Criteria:**
- ✅ Can discover Tizen TV on network
- ✅ Can connect via SDB with certificates
- ✅ Can list installed apps
- ✅ Can launch/kill apps
- ✅ Angular UI components render correctly

---

### Week 2 - Android TV Distribution 🟠

**Goal:** Make Android TV work without user setup

**Tasks:**

1. **Embed ADB Binary** (2-3 hours)
   - Download official Android Platform Tools ADB (~15MB)
   - Add to `src-tauri/resources/platform-tools/adb`
   - Update `src/app/core/services/adb.service.ts` to use bundled path
   - Test on clean macOS

2. **Build & Test** (1-2 hours)
   - Run `npm run build`
   - Test .dmg on clean machine (no ADB installed)
   - Verify ADB works out-of-the-box

**Success Criteria:**
- ✅ App works without system ADB installed
- ✅ .dmg includes everything needed
- ✅ Users open app and it just works

---

### Week 3 - VIDAA TV Support 🔴 (IN PROGRESS)

**Goal:** Implement VIDAA device control via MQTT protocol

**Tasks:**

1. **MQTT-over-TLS Connection** (2-3 days)
   - Create `src-tauri/src/device_manager/vidaa.rs`
   - Implement MQTT client library integration
   - Handle TLS connection to port 36669
   - Authenticate with credentials (hisenseservice / multimqttservice)
   - Parse MQTT messages

2. **VIDAA Service Commands** (2-3 days)
   - Launch apps (e.g., `vidaa launch netflix`)
   - Power control (on/off)
   - Volume control
   - List available apps
   - Handle app naming/aliasing

3. **Testing & Validation** (1-2 days)
   - Test with Hisense TV if available
   - Or find VIDAA TV emulator alternative
   - Verify MQTT connection works
   - Verify all commands function correctly

**Resources:**
- [vidaa-control GitHub](https://github.com/tombabolewski/vidaa-control) - Reference implementation
- [ha-vidaa-tv GitHub](https://github.com/tombabolewski/ha-vidaa-tv) - Integration reference
- MQTT Port: 36669 (TLS encrypted)
- Credentials: hisenseservice / multimqttservice

**Success Criteria:**
- ✅ Can discover VIDAA TV on network
- ✅ Can connect via MQTT with TLS
- ✅ Can launch apps
- ✅ Can control power/volume
- ✅ Angular UI components render correctly

---

### Week 4+ - LG WebOS Support 🟡

**Later: LG WebOS Support**
- Integrate existing Luna API code
- SSH + RSA key authentication
- Feature parity with other platforms

---

## What's Done vs. What's Left

### ✅ COMPLETED (100%)
- App renamed & rebranded completely
- Design system implemented
- Android TV ADB service working
- Data clearing on startup
- Research on all 4 platforms
- Architecture planning done
- Icon system updated

### 🔄 IN PROGRESS (0%)
- **Samsung Tizen SDB implementation** ← START HERE

### ⏳ BLOCKED (Waiting for Tizen)
- Android TV ADB binary embedding
- VIDAA MQTT implementation
- WebOS integration
- Mac .dmg build

---

## Priority Order

1. **Samsung Tizen (Week 1)** - Most market share after Android
2. **Android TV Distribution (Week 2)** - Fix distribution issue
3. **VIDAA TV (Week 3+)** - Research complete, ready to implement
4. **LG WebOS (Later)** - Can reuse existing code base

---

## Project Files

```
/Users/borissionov/Privet/Projects/FreeTV-QA-Tool/
├── src/                           # Angular Frontend
│   ├── app/
│   │   ├── platform-selector/     # Main UI (3 platforms)
│   │   ├── android-tv/            # Android TV module
│   │   ├── home/                  # Home/settings
│   │   └── core/services/
│   │       └── adb.service.ts     # ADB wrapper
│   └── index.html                 # App title
│
├── src-tauri/                     # Rust Backend
│   ├── src/
│   │   ├── lib.rs                 # Tauri setup + startup logic
│   │   ├── plugins/               # Command modules
│   │   ├── device_manager/        # Device management
│   │   └── main.rs
│   ├── resources/
│   │   └── platform-tools/adb     # [TO ADD] Bundled ADB binary
│   └── Cargo.toml
│
├── package.json                   # Node deps + scripts
├── tauri.conf.json               # Tauri config (build, bundle)
├── angular.json                  # Angular config (budgets, build)
├── CLAUDE.md                      # This file
└── README.md                      # User documentation
```

---

## Configuration Notes

### angular.json - Stylesheet Budgets
Increased from 4kb to 15kb error limit to accommodate modern design system:
```json
{
  "type": "anyComponentStyle",
  "maximumWarning": "8kb",
  "maximumError": "15kb"
}
```

### tauri.conf.json - Bundle Resources
[TO ADD] Include ADB binary:
```json
{
  "bundle": {
    "resources": [
      "resources/platform-tools/adb"
    ]
  }
}
```

### package.json - App Metadata
```json
{
  "name": "smart-tv-qa-tool",
  "version": "1.0.0",
  "description": "Smart TV QA Tool",
  "author": "Smart TV QA Team"
}
```

---

## Key Decisions & Rationale

1. **Embed ADB, Don't Write Native Library**
   - Current CLI wrapper is proven & reliable
   - Existing Rust ADB libraries are immature
   - Bundling binary solves real problem (distribution)
   - Minimal code changes needed

2. **Fresh Data on Startup**
   - Each launch is clean slate
   - No lingering device connections or saved state
   - Prevents stale authentication issues
   - Better for QA (reproducible tests)

3. **One App, Multiple Platforms**
   - Single installer, single window
   - Shared device list
   - Unified UI framework (Angular)
   - Professional distribution (.dmg/.exe/.deb)

4. **Modern Design System**
   - Glassmorphism (blur, transparency)
   - Consistent across platforms
   - User-friendly QA interface
   - Professional appearance

---

## Tizen-Specific Implementation Notes

### SDB Connection Details
- **Protocol:** Socket-based communication (similar to ADB)
- **Port:** 26101
- **Authentication:** Certificate exchange (not PIN-based as initially thought)
- **Available Commands:**
  ```
  pm list packages          # List installed apps
  shell getprop            # Get device properties
  push <file>              # Push files to device
  pull <file>              # Pull files from device
  ```

### Key Tizen Package Commands
```bash
# Launch app
app_launcher -s <app-id>

# Kill app
pidof <app-name>
kill <pid>

# Install WGT package
package-manager -i <wgt-file>
```

### Testing Strategy
1. **Option A:** Use Samsung Tizen Studio (free)
   - Download from: https://developer.tizen.org/
   - Create TV emulator
   - Connect via SDB

2. **Option B:** Use actual Tizen TV
   - Enable Developer Mode
   - Note IP address
   - Connect via SDB

### Known Challenges
- WGT package format is different from APK
- Commands syntax slightly different from Android
- Limited official documentation
- Need to handle certificate storage

---

## Research Resources Used

### VIDAA TV
- [vidaa-control](https://github.com/tombabolewski/vidaa-control) - Working Python implementation
- [ha-vidaa-tv](https://github.com/tombabolewski/ha-vidaa-tv) - Home Assistant integration
- MQTT credentials found: hisenseservice / multimqttservice

### Samsung Tizen
- Samsung Tizen Studio
- Tizen Developer Documentation
- SDB Protocol (similar to ADB)

### Android TV
- Existing adb.service.ts implementation
- Works perfectly, just needs ADB binary bundling

---

## Summary: What's Done & What's Next

| Item | Status | Notes |
|------|--------|-------|
| App Rename (FreeTV → Smart TV QA Tool) | ✅ Done | Complete rebrand |
| Design System (Modern Glassmorphism) | ✅ Done | Applied throughout |
| Android TV ADB Service | ✅ Done | Working, needs bundling |
| Data Clearing on Startup | ✅ Done | Fresh state every launch |
| **Samsung Tizen Research** | ✅ Done | SDB approach identified |
| **VIDAA Research** | ✅ Done | MQTT approach identified |
| **Samsung Tizen Implementation** | 🔴 IN PROGRESS | **Week 1 - PRIMARY** |
| **VIDAA Implementation** | 🔴 IN PROGRESS | **Week 3+ - SECONDARY** |
| Android TV Binary Embedding | 🟠 TODO | Week 2 (1 day) |
| WebOS Integration | 🟡 TODO | Can reuse existing code |
| Mac Build & Distribution | 🟡 TODO | After all platforms |

---

## References

- **Android Debug Bridge:** https://developer.android.com/studio/command-line/adb
- **Samsung Tizen Studio:** https://developer.tizen.org/
- **VIDAA Control (Reference):** https://github.com/tombabolewski/vidaa-control
- **Tauri Documentation:** https://tauri.app
- **Angular:** https://angular.io

---

**Last Updated:** April 28, 2026  
**Version:** 1.0.0  
**Current Phase:** Samsung Tizen Implementation (Week 1)  
**Status:** Architecture complete. Ready to code Tizen SDB module.
