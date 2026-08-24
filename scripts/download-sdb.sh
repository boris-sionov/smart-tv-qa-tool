#!/usr/bin/env bash
# Downloads the SDB (Smart Development Bridge) binary from Samsung's Tizen SDK server
# and places it in src-tauri/binaries/ with the correct Tauri sidecar naming convention.
# Run this once before `npm run start` or `npm run build`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARIES_DIR="$SCRIPT_DIR/../src-tauri/binaries"
TMP_DIR="$(mktemp -d)"

TARGET="$(rustc -Vv 2>/dev/null | grep '^host:' | awk '{print $2}')"
if [[ -z "$TARGET" ]]; then
  echo "ERROR: could not determine Rust target triple (is rustc installed?)"
  exit 1
fi
echo "Target triple: $TARGET"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    # Intel binary; runs under Rosetta 2 on Apple Silicon
    URL="https://download.tizen.org/sdk/tizenstudio/official/binary/sdb_4.2.36_macos-64.zip"
    ;;
  Linux)
    # No ARM64 package available upstream; x86_64 binary is placed at the target triple path
    URL="https://download.tizen.org/sdk/tizenstudio/official/binary/sdb_4.2.36_ubuntu-64.zip"
    ;;
  *)
    echo "ERROR: Unsupported OS: $OS"
    exit 1
    ;;
esac

echo "Downloading SDB from $URL ..."
ZIP="$TMP_DIR/sdb.zip"
curl -L --fail --progress-bar -o "$ZIP" "$URL"

echo "Extracting ..."
unzip -q "$ZIP" -d "$TMP_DIR"

SDB_SRC="$(find "$TMP_DIR" -name "sdb" -type f | head -1)"
if [[ -z "$SDB_SRC" ]]; then
  echo "ERROR: Could not find sdb binary in downloaded package."
  rm -rf "$TMP_DIR"
  exit 1
fi

mkdir -p "$BINARIES_DIR"
DST="$BINARIES_DIR/sdb-$TARGET"
cp "$SDB_SRC" "$DST"
chmod +x "$DST"

rm -rf "$TMP_DIR"

echo ""
echo "Done! SDB binary placed at:"
echo "  $DST"
echo ""
echo "You can now run: npm run start"
