#!/bin/bash
# Build the ZotData Sync XPI plugin
set -e
cd "$(dirname "$0")"
VERSION=$(node -e "console.log(require('./manifest.json').version)" 2>/dev/null) || \
  VERSION=$(grep '"version"' manifest.json | sed 's/.*"version": "\([^"]*\)".*/\1/')
OUT="build/zot-data-${VERSION}.xpi"
rm -f "$OUT"
cd "$(dirname "$0")"
zip -r "$OUT" \
    manifest.json \
    bootstrap.js \
    zot-data-sync.js \
    prefs.js \
    locale/ \
    resources/ \
    -x "*/~/*" \
    -x "*/build/*"
echo "Built: $OUT"
ls -lh "$OUT"
