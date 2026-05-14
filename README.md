# zot-data — Self-hosted Zotero Data Server

A fully self-contained [Zotero Data Server](https://github.com/zotero/dataserver) deployment with Docker, plus a Python sync client.

> ⚠ **This project is in active development.** Breaking changes may occur.

---

## Architecture

```
┌─────────────┐     ┌───────────────────┐     ┌──────────┐
│  Zotero     │────▶│  Reverse Proxy    │────▶│  MinIO   │
│  Client     │     │  (Caddy / nginx)  │     │  :9000   │
│  (desktop)  │     │                   │     └──────────┘
└─────────────┘     │  zot.example.com──│───▶ app :8080
                    │  s3.example.com───│───▶ MinIO :9000
                    │  stream.example   │───▶ stream :8082
                    └───────────────────┘
                           │
                    ┌──────┴──────┐
                    │  MySQL      │
                    │  Redis      │
                    └─────────────┘
```

### Components

| Service | Base Image | Role |
|---------|-----------|------|
| **app** | `php:8.2-apache` | Zotero API server (items, collections, sync, auth) |
| **minio** | `minio/minio` | S3-compatible storage for attachments |
| **stream** | `node:22-alpine` | WebSocket real-time sync notifications (optional) |

### Dependencies (host)

- **MySQL / MariaDB** — stores all Zotero data (items, collections, groups, users)
- **Redis** — request limiter + WebSocket pub/sub for stream server
- **Reverse proxy** — Caddy, nginx, or similar for TLS termination and routing
- **MinIO client** (`mc`) — used by init script for bucket creation

## Quick Start

### 1. Database setup

```sql
CREATE DATABASE zotero;
CREATE DATABASE ids;
CREATE DATABASE www;
CREATE USER 'zotero'@'127.0.0.1' IDENTIFIED BY 'zotropass';
GRANT ALL ON zotero.* TO 'zotero'@'127.0.0.1';
GRANT ALL ON ids.* TO 'zotero'@'127.0.0.1';
GRANT ALL ON www.* TO 'zotero'@'127.0.0.1';
```

Add the admin user (password: `adminpass`):

```sql
INSERT INTO www.users (userID, username, password, role)
VALUES (1, 'admin', SHA1(CONCAT('dev-salt-change-in-production', 'adminpass')), 'normal');
```

### 2. Start services

```bash
cd docker
cp .env.example .env
# Edit .env if needed

docker compose up -d
```

The init script will:
- Load the Zotero schema into MySQL
- Create default admin user + group
- Create MinIO buckets (`zotero`, `zotero-fulltext`)

### 3. Configure reverse proxy

Example Caddy config (`docker/example.caddy`):

```
zot.example.com {
    reverse_proxy 127.0.0.1:8080
}
s3.example.com {
    reverse_proxy 127.0.0.1:9000
}
stream.example.com {
    reverse_proxy 127.0.0.1:8082
}
```

### 4. Configure Zotero client

In Zotero desktop preferences → Sync:
- Uncheck "Use Zotero's servers"
- Server: `https://zot.example.com/`
- Username: `admin`
- Password: `adminpass` (or your configured password)

Or use an API key by logging in at `https://zot.example.com/auth/login`.

## Python Sync Client

For syncing from an existing Zotero SQLite database:

```bash
cd python
pip install -r requirements.txt
cp zotero_sync_config.json config.json
# Edit config.json
python zotero_sync_client.py
```

### Config

```json
{
    "api_url": "https://zot.example.com",
    "username": "admin",
    "password": "adminpass",
    "user_id": 1,
    "local_db": "/path/to/zotero.sqlite",
    "minio_endpoint": "s3.example.com",
    "minio_secure": true,
    "sync_attachments": true,
    "library_filter": "group"
}
```

Options:
- `library_filter`: `"all"`, `"user"`, or `"group"` (default: `"group"`)
- `--dry-run`: preview without uploading

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_USER` | `zotero` | MySQL username |
| `DB_PASS` | `zotropass` | MySQL password |
| `DB_NAME` | `zotero` | MySQL database |
| `ADMIN_USERNAME` | `admin` | Default admin username |
| `ADMIN_PASSWORD` | `adminpass` | Default admin password |
| `AUTH_SALT` | `dev-salt-change-in-production` | Salt for password hashing |
| `S3_PUBLIC_ENDPOINT` | `http://localhost:9000` | Public S3 endpoint for presigned URLs |
| `AWS_ACCESS_KEY_ID` | `minioadmin` | MinIO access key |
| `AWS_SECRET_ACCESS_KEY` | `minioadmin` | MinIO secret key |
| `REDIS_HOST` | `127.0.0.1` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | — | Redis password |

## Client Preferences

On the Zotero desktop client, add to `prefs.js`:

```js
user_pref("extensions.zotero.api.url", "https://zot.example.com/");
user_pref("extensions.zotero.streaming.url", "wss://stream.example.com/");
```

To disable WebSocket (falls back to polling):

```js
user_pref("extensions.zotero.streaming.enabled", false);
```

## What's Patched

The dataserver is cloned from the [official repository](https://github.com/zotero/dataserver) at build time. Patches are applied via `docker/patch-header.php`:

| File | Change |
|------|--------|
| `ApiController.php` | Add `currentUser()` action, `retractions()` endpoint |
| `GroupsController.php` | Send `Last-Modified-Version` for `format=versions` |
| `Password.inc.php` | Use `www` database instead of `zotero_www` |
| `Storage.inc.php` | Use `www` database for storage quota query |
| `Item.inc.php` | Default annotation `sortIndex` when null/empty |
| `header.inc.php` | Redis/S3/MinIO config from env vars |
| `routes.inc.php` | Add `/users/current` route |
| `.htaccess` | Add `auth/login` → `login.php` rewrite |

## License

AGPL-3.0. This project wraps the [Zotero Data Server](https://github.com/zotero/dataserver) (also AGPL-3.0).
