#!/bin/bash
set -e

cd /var/www/html/misc

MYSQL_HOST="${MYSQL_HOST:-host.docker.internal}"
MYSQL_USER="${MYSQL_USER:-zotero}"
MYSQL_PASS="${ZOTERO_MYSQL_PASS:-zotropass}"
MYSQL_DB="${MYSQL_DATABASE:-zotero}"

# Helper: run mysql
mysql_u() {
    mysql -h"$MYSQL_HOST" -u"$MYSQL_USER" --password="$MYSQL_PASS" --skip-ssl "$@"
}

# Init schema only on first run
if ! mysql_u "$MYSQL_DB" -e "SELECT 1 FROM libraries LIMIT 1" >/dev/null 2>&1; then
    echo "[init] Loading schema into $MYSQL_DB..."
    mysql_u "$MYSQL_DB" -e "SOURCE master.sql;"
    mysql_u "$MYSQL_DB" -e "SOURCE coredata.sql;"
    mysql_u "$MYSQL_DB" -e "SOURCE shard.sql;"
    mysql_u "$MYSQL_DB" -e "SOURCE triggers.sql;"

    # Route all shards to the same DB (single-host mode)
    mysql_u "$MYSQL_DB" -e "
        INSERT IGNORE INTO shardHosts VALUES (1, '$MYSQL_HOST', 3306, 'up');
        -- Fix truncated hostname (host.docker.internal truncated to varchar(15))
        UPDATE shardHosts SET address='$MYSQL_HOST' WHERE shardHostID=1;
        INSERT IGNORE INTO shards VALUES (1, 1, '$MYSQL_DB', 'up', '1');
        INSERT IGNORE INTO shards VALUES (2, 1, '$MYSQL_DB', 'up', '1');
    "

    # Default admin user
    ADMIN_USER="${ADMIN_USERNAME:-admin}"
    ADMIN_PASS="${ADMIN_PASSWORD:-adminpass}"
    mysql_u "$MYSQL_DB" -e "
        INSERT IGNORE INTO libraries VALUES (1, 'user', NOW(), 0, 1, 0);
        INSERT IGNORE INTO libraries VALUES (2, 'group', NOW(), 0, 2, 0);
        INSERT IGNORE INTO users VALUES (1, 1, '$ADMIN_USER');
        INSERT IGNORE INTO \`groups\` VALUES (1, 2, 'Default Group', 'default', 'Private', 'members', 'all', 'members', '', '', 0, NOW(), NOW(), 1);
        INSERT IGNORE INTO groupUsers VALUES (1, 1, 'owner', NOW(), NOW());
    "

    # Register libraries in shardLibraries so foreign keys resolve
    mysql_u "$MYSQL_DB" -e "
        INSERT IGNORE INTO shardLibraries (shardID, libraryID) VALUES (1, 1);
        INSERT IGNORE INTO shardLibraries (shardID, libraryID) VALUES (2, 2);
    "

    echo "[init] Loading schema into ids..."
    mysql_u ids -e "SOURCE ids.sql;" 2>/dev/null || true

    echo "[init] Loading schema into www..."
    mysql_u www -e "SOURCE www.sql;" 2>/dev/null || true

    echo "[init] Admin: $ADMIN_USER / $ADMIN_PASS"
else
    echo "[init] Database already initialized, skipping."
fi

# MinIO bucket setup
S3_EP="${S3_ENDPOINT:-}"
if [ -n "$S3_EP" ]; then
    S3_HOST="${S3_EP%%:*}"
    S3_PORT="${S3_EP##*:}"
    S3_PORT="${S3_PORT:-9000}"
    KEY="${AWS_ACCESS_KEY_ID:-minioadmin}"
    SECRET="${AWS_SECRET_ACCESS_KEY:-minioadmin}"
    echo "[init] Creating MinIO buckets..."
    mc alias set local "http://${S3_HOST}:${S3_PORT}" "$KEY" "$SECRET" 2>/dev/null || true
    mc mb --ignore-existing local/zotero 2>/dev/null || true
    mc mb --ignore-existing local/zotero-fulltext 2>/dev/null || true
fi

echo "[init] Starting Apache..."
apache2-foreground
