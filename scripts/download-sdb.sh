#!/usr/bin/env bash
# Downloads the SDB (Smart Development Bridge) binary from Samsung's Tizen SDK server
# and installs it to ~/tizen-studio/tools/sdb (the default location the app looks in).
#
# Run this once before using the Samsung Tizen features.
# If download fails, install Tizen Studio from:
#   https://developer.samsung.com/tizen/overview.html

set -euo pipefail

TMP_DIR="$(mktemp -d)"
INSTALL_DIR="$HOME/tizen-studio/tools"
SDB_DST="$INSTALL_DIR/sdb"

OS="$(uname -s)"
ARCH="$(uname -m)"

# Pick download URL based on OS
# Samsung provides SDB as part of the Tizen SDK platform tools package
case "$OS" in
  Darwin)
    # macOS — Intel binary runs under Rosetta on Apple Silicon
    URL="https://download.tizen.org/sdk/tizenstudio/official/binary/sdb_4.2.12_macos.zip"
    ;;
  Linux)
    if [[ "$ARCH" == "aarch64" ]]; then
      URL="https://download.tizen.org/sdk/tizenstudio/official/binary/sdb_4.2.12_ubuntu-arm64.zip"
    else
      URL="https://download.tizen.org/sdk/tizenstudio/official/binary/sdb_4.2.12_ubuntu-64.zip"
    fi
    ;;
  *)
    echo "ERROR: Unsupported OS: $OS"
    echo "Install Tizen Studio manually from https://developer.samsung.com/tizen/overview.html"
    exit 1
    ;;
esac

echo "Downloading SDB from $URL ..."
ZIP="$TMP_DIR/sdb.zip"

if ! curl -L --fail --progress-bar -o "$ZIP" "$URL"; then
  echo ""
  echo "ERROR: Download failed."
  echo ""
  echo "Please install Tizen Studio manually:"
  echo "  https://developer.samsung.com/tizen/overview.html"
  echo ""
  echo "After installing, SDB will be at: ~/tizen-studio/tools/sdb"
  rm -rf "$TMP_DIR"
  exit 1
fi

echo "Extracting ..."
unzip -q "$ZIP" -d "$TMP_DIR"

# Find the sdb binary in the extracted contents
SDB_SRC="$(find "$TMP_DIR" -name "sdb" -type f | head -1)"
if [[ -z "$SDB_SRC" ]]; then
  echo "ERROR: Could not find sdb binary in downloaded package."
  rm -rf "$TMP_DIR"
  exit 1
fi

mkdir -p "$INSTALL_DIR"
cp "$SDB_SRC" "$SDB_DST"
chmod +x "$SDB_DST"

rm -rf "$TMP_DIR"

echo ""
echo "Done! SDB installed at: $SDB_DST"
echo ""
echo "Verify with: $SDB_DST version"
"$SDB_DST" version 2>/dev/null || echo "(run the above command manually to verify)"
echo ""
echo "You can now use Samsung Tizen features in the app."
