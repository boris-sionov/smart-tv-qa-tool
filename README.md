# Smart TV QA Tool

A desktop QA utility for managing Smart TV apps across multiple TV platforms from one Tauri + Angular application.

The project is currently based on the webOS Dev Manager codebase, with a new platform selector and an Android TV manager added on top. The goal is one desktop app for LG webOS, Android TV, and later Samsung Tizen.

## Current Status

| Platform | Status | Notes |
| --- | --- | --- |
| LG webOS | Working base | Existing webOS manager features are preserved under the `/lg` route. |
| Android TV | Partially integrated | Angular UI exists under `/android-tv`; ADB commands currently run through the Tauri shell plugin. |
| Samsung Tizen | Not implemented | Placeholder appears in the platform selector as an in-progress platform. |

## Tech Stack

- Tauri 2 desktop shell
- Angular 18 frontend
- Rust backend for existing webOS/device plugins
- Bootstrap and ng-bootstrap UI components
- ADB for Android TV communication

## App Structure

```text
src/
  app/
    platform-selector/     Platform chooser shown at startup
    home/                  LG/webOS application shell
    apps/                  LG/webOS app management
    files/                 LG/webOS file manager
    terminal/              LG/webOS terminal
    debug/                 LG/webOS debug tools
    info/                  LG/webOS device info
    android-tv/            Android TV manager UI
    core/services/         Frontend service wrappers

src-tauri/
  src/
    plugins/               Existing Tauri backend plugins
    device_manager/        webOS device configuration and SSH helpers
    conn_pool/             SSH connection pooling
    remote_files/          Remote file protocol support
```

## Routes

- `/` - platform selector
- `/lg` - LG webOS manager
- `/lg/apps` - LG app management
- `/lg/files` - LG file manager
- `/lg/terminal` - LG terminal
- `/lg/debug` - LG debug tools
- `/lg/info` - LG device info
- `/android-tv` - Android TV manager
- `/android-tv/apps` - Android TV app list and APK install flow
- `/android-tv/info` - Android TV device information
- `/android-tv/devices` - Android TV saved devices

## Android TV Integration

Android TV code currently lives in:

- `src/app/android-tv/`
- `src/app/core/services/adb.service.ts`
- `src/assets/app-icons/`

The current Android TV implementation can:

- save Android TV devices by name, IP, and port
- connect with `adb connect`
- list sideloaded packages
- install APK files
- launch apps
- force-stop apps
- uninstall apps
- read basic device properties

Important current limitation: ADB is called from the Angular frontend through Tauri's shell plugin using `/bin/zsh`. The intended long-term architecture is to move this into a Rust backend plugin, similar to the existing webOS backend plugins.

## Requirements

- Node.js 20+
- npm
- Rust toolchain
- Tauri prerequisites for your OS
- `adb` available in PATH for Android TV features

## Development

Install dependencies:

```bash
npm install
```

Run the app in development mode:

```bash
npm run start
```

This runs icon extraction, starts the Angular dev server on port `4281`, and launches Tauri.

Run Angular directly:

```bash
npm run ng serve
```

Build the desktop app:

```bash
npm run build
```

## Known Build Note

The Angular production build currently reaches bundling but fails on strict `anyComponentStyle` budget limits in `angular.json`. This is a budget configuration issue, not a TypeScript compilation failure.

The affected SCSS files include several LG and Android TV components whose styles are larger than the current 4 KB production error threshold.

## Repository Notes

- `AGENTS.md` contains Codex project instructions.
- `CLAUDE.md` contains Claude project instructions.
- Generated folders such as `node_modules`, `dist`, `target`, `.angular`, and `src-tauri/gen` are ignored.

## Roadmap

- Fix Android TV device communication parity with the original PySide6 app.
- Move Android TV ADB logic from frontend shell commands into a Rust Tauri plugin.
- Add Android TV remote-control actions.
- Add Appium integration for Android TV QA flows.
- Add Samsung Tizen support through SDB.
- Build a shared multi-platform device list.
