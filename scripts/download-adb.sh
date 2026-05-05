#!/usr/bin/env bash
# Downloads the ADB binary from Android platform-tools and places it in
# src-tauri/binaries/ with the correct Tauri sidecar naming convention.
# Run this once before `npm run tauri dev` or `npm run tauri build`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARIES_DIR="$SCRIPT_DIR/../src-tauri/binaries"
TMP_DIR="$(mktemp -d)"

# Detect target triple from rustc
TARGET="$(rustc -Vv 2>/dev/null | grep '^host:' | awk '{print $2}')"
if [[ -z "$TARGET" ]]; then
  echo "ERROR: could not determine Rust target triple (is rustc installed?)"
  exit 1
fi
echo "Target triple: $TARGET"

# Pick the right platform-tools zip
OS="$(uname -s)"
case "$OS" in
  Darwin)  URL="https://dl.google.com/android/repository/platform-tools-latest-darwin.zip" ;;
  Linux)   URL="https://dl.google.com/android/repository/platform-tools-latest-linux.zip" ;;
  MINGW*|MSYS*|CYGWIN*) URL="https://dl.google.com/android/repository/platform-tools-latest-windows.zip" ;;
  *)
    echo "ERROR: unsupported OS: $OS"
    exit 1
    ;;
esac

echo "Downloading platform-tools from $URL ..."
ZIP="$TMP_DIR/platform-tools.zip"
curl -L --progress-bar -o "$ZIP" "$URL"

echo "Extracting ..."
unzip -q "$ZIP" -d "$TMP_DIR"

# The binary is platform-tools/adb  (or adb.exe on Windows)
SRC="$TMP_DIR/platform-tools/adb"
[[ -f "$SRC" ]] || SRC="$TMP_DIR/platform-tools/adb.exe"

DST="$BINARIES_DIR/adb-$TARGET"
cp "$SRC" "$DST"
chmod +x "$DST"

# Clean up
rm -rf "$TMP_DIR"

echo ""
echo "Done! ADB binary placed at:"
echo "  $DST"
echo ""
echo "You can now run: npm run tauri dev"
