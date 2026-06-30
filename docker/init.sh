#!/bin/bash
set -e

cd /var/www/html/misc

MYSQL_HOST="${MYSQL_HOST:-127.0.0.1}"
MYSQL_PORT="${MYSQL_PORT:-${DB_PORT:-3306}}"
MYSQL_USER="${DB_USER:-zotero}"
MYSQL_PASS="${DB_PASS:-zotropass}"
MYSQL_DB="${DB_NAME:-zotero}"

# Helper: run mysql
mysql_u() {
    mysql -h"$MYSQL_HOST" -P"$MYSQL_PORT" -u"$MYSQL_USER" --password="$MYSQL_PASS" --skip-ssl "$@"
}

# Wait for MySQL to be ready (handles both Docker and host MariaDB)
echo "[init] Waiting for MySQL at $MYSQL_HOST:$MYSQL_PORT..."
for i in $(seq 1 30); do
    if mysql_u -e "SELECT 1" >/dev/null 2>&1; then
        echo "[init] MySQL ready after ${i}s"
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo "[init] ERROR: MySQL not reachable after 30s"
        exit 1
    fi
    sleep 1
done

# Init schema only on first run
if ! mysql_u "$MYSQL_DB" -e "SELECT 1 FROM libraries LIMIT 1" >/dev/null 2>&1; then
    echo "[init] Loading schema into $MYSQL_DB..."
    mysql_u "$MYSQL_DB" -e "SOURCE master.sql;"
    mysql_u "$MYSQL_DB" -e "SOURCE coredata.sql;"
    mysql_u "$MYSQL_DB" -e "SOURCE shard.sql;"
    mysql_u "$MYSQL_DB" -e "SOURCE triggers.sql;"

    # Route all shards to the same DB (single-host mode)
    mysql_u "$MYSQL_DB" -e "
        INSERT IGNORE INTO shardHosts VALUES (1, '$MYSQL_HOST', $MYSQL_PORT, 'up');
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
    # Columns: libraryID, libraryType, lastUpdated, version, storageUsage
    mysql_u "$MYSQL_DB" -e "
        INSERT IGNORE INTO shardLibraries (libraryID, libraryType, lastUpdated, version, storageUsage) VALUES
            (1, 'user',     NOW(), 0, 0),
            (2, 'group',    NOW(), 0, 0);
    "

    echo "[init] Loading schema into ids..."
    mysql_u ids -e "SOURCE ids.sql;" 2>/dev/null || true

    echo "[init] Loading schema into www..."
    mysql_u www -e "SOURCE www.sql;" 2>/dev/null || mysql_u www -e "
        CREATE TABLE IF NOT EXISTS users (
            userID int(10) unsigned NOT NULL auto_increment,
            username varchar(255) NOT NULL,
            email varchar(255) DEFAULT NULL,
            password varchar(255) NOT NULL,
            role varchar(50) NOT NULL DEFAULT 'normal',
            PRIMARY KEY (userID),
            UNIQUE KEY username (username)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        CREATE TABLE IF NOT EXISTS GDN_User (
            UserID int(10) unsigned NOT NULL,
            Banned tinyint(1) NOT NULL DEFAULT 0,
            PRIMARY KEY (UserID)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        CREATE TABLE IF NOT EXISTS users_meta (
            userID int(10) unsigned NOT NULL,
            metaKey varchar(255) NOT NULL,
            metaValue text,
            PRIMARY KEY (userID, metaKey)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        CREATE TABLE IF NOT EXISTS users_email (
            userID int(10) unsigned NOT NULL,
            email varchar(255) NOT NULL,
            validated tinyint(1) NOT NULL DEFAULT 0,
            dateAdded datetime DEFAULT NULL,
            PRIMARY KEY (userID, email)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    "

    # Fix www.users password column (bcrypt hash can be 60 chars)
    mysql_u "$MYSQL_DB" -e "ALTER TABLE www.users MODIFY COLUMN password varchar(255) NOT NULL;" 2>/dev/null || true

    # Create www admin user (needed for OAuth login to work)
    AUTH_SALT="${AUTH_SALT:-dev-salt-change-in-production}"
    ADMIN_HASH=$(echo -n "${AUTH_SALT}${ADMIN_PASS}" | sha1sum | cut -d' ' -f1)
    mysql_u www -e "INSERT IGNORE INTO users (userID, username, password, role) VALUES (1, '$ADMIN_USER', '$ADMIN_HASH', 'normal');" 2>/dev/null || true

    echo "[init] Admin: $ADMIN_USER / $ADMIN_PASS"
else
    echo "[init] Database already initialized, skipping."
fi

# Apply schema updates (new item types, fields) — run after DB is ready
php /init-schema.php || echo "[init] Schema update skipped (non-fatal)"

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
