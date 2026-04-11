#!/bin/bash
# setup.sh — 在宿主机上初始化 MariaDB 数据库和用户
# 用法: sudo ./setup.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

# Load .env if exists
if [ -f "$ENV_FILE" ]; then
    set -a
    source "$ENV_FILE"
    set +a
fi

MYSQL_USER="${MYSQL_USER:-zotero}"
MYSQL_PASS="${ZOTERO_MYSQL_PASS:-zotropass}"
MYSQL_DB="${MYSQL_DATABASE:-zotero}"

echo "[setup] Creating databases and user..."
sudo mysql -e "
  CREATE DATABASE IF NOT EXISTS \`$MYSQL_DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  CREATE DATABASE IF NOT EXISTS ids CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  CREATE DATABASE IF NOT EXISTS www CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

  CREATE USER IF NOT EXISTS '$MYSQL_USER'@'localhost' IDENTIFIED BY '$MYSQL_PASS';
  CREATE USER IF NOT EXISTS '$MYSQL_USER'@'%' IDENTIFIED BY '$MYSQL_PASS';

  GRANT ALL PRIVILEGES ON \`$MYSQL_DB\`.* TO '$MYSQL_USER'@'localhost';
  GRANT ALL PRIVILEGES ON ids.* TO '$MYSQL_USER'@'localhost';
  GRANT ALL PRIVILEGES ON www.* TO '$MYSQL_USER'@'localhost';
  GRANT ALL PRIVILEGES ON \`$MYSQL_DB\`.* TO '$MYSQL_USER'@'%';
  GRANT ALL PRIVILEGES ON ids.* TO '$MYSQL_USER'@'%';
  GRANT ALL PRIVILEGES ON www.* TO '$MYSQL_USER'@'%';

  FLUSH PRIVILEGES;
"

echo "[setup] Done. Databases and user '$MYSQL_USER' created."
echo "[setup] Run 'docker compose up --build -d' to start the server."
