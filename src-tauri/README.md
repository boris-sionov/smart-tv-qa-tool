# Smart TV QA Tool — Rust Backend

This directory contains the Tauri Rust backend for the Smart TV QA Tool.

## Plugins

| Plugin | File | Purpose |
|--------|------|---------|
| `adb-manager` | `plugins/adb.rs` | Android TV: ADB commands via bundled sidecar |
| `adb-manager` | `plugins/samsung_tizen.rs` | Samsung Tizen: SDB + tz CLI orchestration |
| `adb-manager` | `plugins/lg_remote.rs` | LG: remote control commands |
| `remote-command` | `plugins/cmd.rs` | LG: SSH remote exec |
| `remote-shell` | `plugins/shell.rs` | LG: SSH PTY shells |
| `remote-file` | `plugins/file.rs` | LG: SFTP file operations |
| `dev-mode` | `plugins/devmode.rs` | LG: developer mode token management |
| `local-file` | `plugins/local_file.rs` | Local filesystem operations |

## Building

```bash
# From the project root
npm run build
```

### Windows — Additional Dependencies

The SSH library requires OpenSSL on Windows. Install via vcpkg:

```powershell
vcpkg install libssh:x64-windows openssl:x64-windows
```

Or use the `vendored-openssl` Cargo feature (used in CI) which compiles OpenSSL from source:

```bash
npm run build -- --features=vendored-openssl
```

### macOS / Linux

No additional dependencies required beyond the standard Tauri prerequisites.
See [Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/) for details.

## Capabilities

All Tauri permissions are declared in `capabilities/app.json`.
Plugin permission lists are in `permissions/<plugin-name>/default.toml`.
