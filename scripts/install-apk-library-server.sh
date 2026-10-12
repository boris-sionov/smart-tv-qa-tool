#!/bin/sh
# Sets up the APK library server ("Install from library") on freetv-server, from this Mac.
#
#   sh scripts/install-apk-library-server.sh [user@host]      default: freetv@freetv-server
#
# No sudo: the server runs as the SSH user, started at boot from that user's crontab, and is
# bound to the machine's Tailscale address only — not the LAN, not the internet. Safe to re-run;
# it replaces the server script and restarts it.
set -e
TARGET="${1:-freetv@freetv-server}"
HERE="$(cd "$(dirname "$0")" && pwd)"

ssh "$TARGET" 'mkdir -p ~/apk-library/apks'
scp -q "$HERE/apk-library-server.py" "$TARGET:apk-library/server.py"

ssh "$TARGET" 'sh -s' <<'REMOTE'
set -e
cat > ~/apk-library/run.sh <<'EOF'
#!/bin/sh
# Keeps the APK library server up on this machine's Tailscale address. Early in boot Tailscale
# has no address yet, so this waits and retries rather than binding to everything.
while true; do
  ADDR="$(tailscale ip -4 2>/dev/null | head -1)"
  if [ -n "$ADDR" ]; then
    python3 ~/apk-library/server.py "$ADDR" 8090 >> ~/apk-library/server.log 2>&1
  fi
  sleep 10
done
EOF
chmod +x ~/apk-library/run.sh

# Start at boot, once.
( crontab -l 2>/dev/null | grep -v 'apk-library/run.sh'; echo '@reboot ~/apk-library/run.sh' ) | crontab -

# (Re)start now.
pkill -f 'apk-library/run.sh' 2>/dev/null || true
pkill -f 'apk-library/server.py' 2>/dev/null || true
nohup ~/apk-library/run.sh > /dev/null 2>&1 &
sleep 2
REMOTE

if curl -fsS -m 5 "http://${TARGET#*@}:8090/" > /dev/null; then
  echo "APK library is up at http://${TARGET#*@}:8090/"
else
  echo "Installed, but http://${TARGET#*@}:8090/ does not answer yet — check ~/apk-library/server.log on the server." >&2
  exit 1
fi
