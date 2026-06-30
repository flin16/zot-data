-- Auto-created by MariaDB Docker entrypoint on first run
CREATE DATABASE IF NOT EXISTS zotero CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS ids    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS www    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Grant permissions to the zotero user (created via MARIADB_USER env var)
-- '%' covers all hosts with host networking (127.0.0.1, LAN IPs, etc.)
GRANT ALL PRIVILEGES ON zotero.* TO 'zotero'@'%';
GRANT ALL PRIVILEGES ON ids.*    TO 'zotero'@'%';
GRANT ALL PRIVILEGES ON www.*    TO 'zotero'@'%';
FLUSH PRIVILEGES;
