#!/usr/bin/env bash
# Render the README mockups (assets/mockups/*.html) to PNG with headless Chrome.
# No extensions (so no password-manager overlays) and no extra dependencies.
#   ./scripts/screenshots.sh
# Override the browser with CHROME=/path/to/chrome if needed.
set -euo pipefail

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

shot() {
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=2 --window-size="$2" \
    --screenshot="$ROOT/assets/$1.png" "file://$ROOT/assets/mockups/$1.html" >/dev/null 2>&1
  echo "rendered assets/$1.png"
}

shot chat 560,640
shot join 460,440
shot annotated 900,680
