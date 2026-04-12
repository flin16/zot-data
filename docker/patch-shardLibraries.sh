#!/bin/bash
# One-time patch: register all existing group libraries in shardLibraries.
# This fixes "foreign key constraint fails" errors when uploading items.
# Run once on the server container: docker exec <container> /patch-shardLibraries.sh
set -e

MYSQL_HOST="${MYSQL_HOST:-host.docker.internal}"
MYSQL_USER="${MYSQL_USER:-zotero}"
MYSQL_PASS="${ZOTERO_MYSQL_PASS:-zotropass}"
MYSQL_DB="${MYSQL_DATABASE:-zotero}"

mysql_u() {
    mysql -h"$MYSQL_HOST" -u"$MYSQL_USER" --password="$MYSQL_PASS" --skip-ssl "$@"
}

echo "[patch] Registering all libraries in shardLibraries..."

# Get all shard IDs
for shard_id in $(mysql_u "$MYSQL_DB" -N -e "SELECT shardID FROM shards"); do
    echo "[patch] Shard $shard_id:"
    # Insert all libraries not yet in this shard
    mysql_u "$MYSQL_DB" -e "
        INSERT IGNORE INTO shardLibraries (shardID, libraryID)
        SELECT $shard_id, libraryID FROM libraries;
    "
    # Show what was inserted
    mysql_u "$MYSQL_DB" -N -e "
        SELECT CONCAT('  libraryID=', libraryID, ' registered on shard ', shardID)
        FROM shardLibraries WHERE shardID = $shard_id;
    "
done

echo "[patch] Done. shardLibraries now:"
mysql_u "$MYSQL_DB" -N -e "SELECT CONCAT('  Shard ', shardID, ' -> libraryID ', libraryID) FROM shardLibraries ORDER BY shardID, libraryID;"
