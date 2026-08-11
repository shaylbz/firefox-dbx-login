#!/usr/bin/env bash
# Assemble a Chrome (MV3) build from the shared source files.
# Firefox loads the repo root directly (MV2 manifest.json); Chrome loads the
# folder produced here, where manifest.chrome.json is renamed to manifest.json.
set -euo pipefail
cd "$(dirname "$0")"

OUT="build/chrome"
rm -rf "$OUT"
mkdir -p "$OUT"

# Shared logic + UI (identical across browsers).
cp config.js background.js sw.js \
   content-databricks.js content-aws.js content-definity.js \
   gmail-extract.js gmail-link-extract.js \
   options.html options.js popup.html popup.js \
   "$OUT"/

# The MV3 manifest becomes the folder's manifest.json.
cp manifest.chrome.json "$OUT/manifest.json"

echo "Chrome build ready: $OUT"
echo "Load it via chrome://extensions -> Developer mode -> Load unpacked -> $OUT"
