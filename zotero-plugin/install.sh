#!/bin/bash
# Build and auto-install the ZotData Sync plugin to Zotero
set -e

cd "$(dirname "$0")"

# Build XPI
bash build.sh

XPI="build/zot-data-0.1.0.xpi"

# Find Zotero profile extensions directory
PROFILE_DIR=$(find ~/Library/Application\ Support/Zotero/Profiles -maxdepth 1 -type d -name "*.default" | head -1)
EXT_DIR="$PROFILE_DIR/extensions"

if [ -z "$EXT_DIR" ]; then
    echo "ERROR: Could not find Zotero profile extensions directory"
    exit 1
fi

echo "Profile: $PROFILE_DIR"
echo "Extensions: $EXT_DIR"

# Remove old installed plugin
rm -f "$EXT_DIR/zot-data-sync@yourserver.com.xpi"

# Copy new XPI
cp "$XPI" "$EXT_DIR/zot-data-sync@yourserver.com.xpi"
echo "Installed: $EXT_DIR/zot-data-sync@yourserver.com.xpi"
ls -lh "$EXT_DIR/zot-data-sync@yourserver.com.xpi"

echo ""
echo "Done! Restart Zotero to load the new plugin."
echo "To restart: open Zotero, close it, then re-open."
