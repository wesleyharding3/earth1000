#!/bin/bash
# install.sh — one-time setup for the Earth00 video worker on macOS.
#
# What it does:
#   1. Installs npm deps (puppeteer) into ~/Library/Application Support/earth00-worker
#   2. Copies videoWorker.js to that same dir
#   3. Prompts for renderHost + appHost + token, writes ~/.earth00-worker.json
#   4. Generates ~/Library/LaunchAgents/com.earth00.videoworker.plist with
#      absolute paths substituted in
#   5. Loads the launchd agent (starts the worker)
#   6. Prints status check command
#
# Re-run safe: existing config/installs are overwritten cleanly.

set -e

WORKER_HOME="$HOME/Library/Application Support/earth00-worker"
PLIST_PATH="$HOME/Library/LaunchAgents/com.earth00.videoworker.plist"
LOG_PATH="$HOME/Library/Logs/earth00-worker.log"
CONFIG_PATH="$HOME/.earth00-worker.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "FATAL: 'node' not found on PATH. Install Node.js first:"
  echo "  brew install node"
  exit 1
fi
echo "==> Using node: $NODE_BIN"

mkdir -p "$WORKER_HOME"
mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$HOME/Library/Logs"

echo "==> Copying videoWorker.js to $WORKER_HOME"
cp "$SCRIPT_DIR/videoWorker.js" "$WORKER_HOME/videoWorker.js"

echo "==> Installing puppeteer into $WORKER_HOME (will download Chromium ~170MB)"
cd "$WORKER_HOME"
cat > package.json <<'JSON'
{
  "name": "earth00-worker",
  "version": "1.0.0",
  "private": true,
  "main": "videoWorker.js",
  "dependencies": { "puppeteer": "^24.0.0" }
}
JSON
npm install --omit=dev --silent

# ── Config prompt ──────────────────────────────────────────────────────
if [ -f "$CONFIG_PATH" ]; then
  echo ""
  echo "==> Found existing config at $CONFIG_PATH — keeping it."
  echo "    (delete it and re-run to reconfigure)"
else
  echo ""
  echo "==> Configuring worker. Press Enter to accept defaults."
  read -r -p "  Render API base URL [https://earth-wjr6.onrender.com]: " RENDER_HOST
  RENDER_HOST="${RENDER_HOST:-https://earth-wjr6.onrender.com}"
  read -r -p "  Desktop app base URL [https://earth00.com]: " APP_HOST
  APP_HOST="${APP_HOST:-https://earth00.com}"
  read -r -p "  Worker token (must match VIDEO_WORKER_TOKEN on Render): " TOKEN
  if [ -z "$TOKEN" ]; then
    echo "FATAL: token cannot be empty."
    exit 1
  fi
  cat > "$CONFIG_PATH" <<EOF
{
  "renderHost": "$RENDER_HOST",
  "appHost":    "$APP_HOST",
  "token":      "$TOKEN"
}
EOF
  chmod 600 "$CONFIG_PATH"
  echo "==> Wrote $CONFIG_PATH (mode 600)"
fi

# ── Plist generation ───────────────────────────────────────────────────
echo "==> Writing launchd plist to $PLIST_PATH"
sed \
  -e "s|{{NODE_BIN}}|$NODE_BIN|g" \
  -e "s|{{WORKER_SCRIPT}}|$WORKER_HOME/videoWorker.js|g" \
  -e "s|{{HOME}}|$HOME|g" \
  "$SCRIPT_DIR/com.earth00.videoworker.plist" > "$PLIST_PATH"

# ── Unload existing (if any) then load fresh ──────────────────────────
echo "==> Reloading launchd agent"
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load   "$PLIST_PATH"

echo ""
echo "✓ Earth00 video worker installed and running."
echo ""
echo "  Status:   launchctl list | grep earth00"
echo "  Logs:     tail -f $LOG_PATH"
echo "  Stop:     launchctl unload $PLIST_PATH"
echo "  Re-run:   bash $SCRIPT_DIR/install.sh"
echo ""
echo "  The worker polls every 60 seconds. Watch the log to see it pick"
echo "  up jobs when the picker cron drops new threads."
