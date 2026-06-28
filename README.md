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

## Prerequisites

You need these running on your **host machine** (not in Docker):

- **MySQL / MariaDB** — create the databases beforehand (the init script populates them)
- **Redis** — optional, only if you want the stream server
- **Reverse proxy** — Caddy, nginx, or similar, to provide TLS and route subdomains

> Docker containers use `network_mode: host`, so they connect to MySQL and Redis at `127.0.0.1` on the host.

## Quick Start

### Step 1: Create the MySQL databases

```sql
CREATE DATABASE zotero;
CREATE DATABASE ids;
CREATE DATABASE www;
CREATE USER 'zotero'@'127.0.0.1' IDENTIFIED BY 'zotropass';
GRANT ALL ON zotero.* TO 'zotero'@'127.0.0.1';
GRANT ALL ON ids.* TO 'zotero'@'127.0.0.1';
GRANT ALL ON www.* TO 'zotero'@'127.0.0.1';
```

### Step 2: Copy and edit config

```bash
cd docker
cp .env.example .env
# Edit .env — at minimum set your database password and domain
```

### Step 3: Build and start Docker services

```bash
docker compose up -d
```

This builds the app image (clones dataserver from GitHub, applies patches, installs deps) and starts three services:

| Container | What it does |
|-----------|-------------|
| `app` | Zotero API server on port **8080** |
| `minio` | S3 file storage on port **9000** |
| `stream` | WebSocket server on port **8082** (optional) |

On first start, the init script inside the `app` container will:
1. Load the Zotero schema into MySQL (creates all tables in `zotero`, `ids`, `www`)
2. Create the default admin user in `www.users` so the OAuth login page works
3. Create MinIO buckets (`zotero`, `zotero-fulltext`)

No manual SQL needed — the admin user is created automatically with the username and password from your `.env` file.

### Step 4: Verify the API is running

```bash
curl http://localhost:8080/
# → "Nothing to see here."   (means it works)

# Get an API key via the login page:
# Open http://localhost:8080/auth/login in your browser,
# or use the test endpoint:
curl -X POST http://localhost:8080/keys/sessions \
    -d "username=admin&password=adminpass"
# → Returns a session token — complete the login via the returned loginURL
```

### Step 5: Configure your reverse proxy (Caddy / nginx)

The `docker/example.caddy` file is a reference, not something Docker uses. Add this to your real Caddyfile:

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

Then reload Caddy: `sudo systemctl reload caddy`

### Step 6: Configure Zotero client

Zotero desktop stores configuration in `prefs.js`. The file location depends on your OS:

| OS | Path |
|----|------|
| **macOS** | `~/Library/Zotero/profiles/xxxxxx.default/prefs.js` |
| **Windows** | `%APPDATA%\Zotero\Zotero\Profiles\xxxxxx.default\prefs.js` |
| **Linux** | `~/.zotero/zotero/xxxxxx.default/prefs.js` |

Add these lines, then (re)start Zotero:

```js
user_pref("extensions.zotero.api.url", "https://zot.example.com/");
user_pref("extensions.zotero.streaming.url", "wss://stream.example.com/");
```

To disable WebSocket streaming (falls back to polling — no functional difference):

```js
user_pref("extensions.zotero.streaming.enabled", false);
```

**Zotero sync UI method** (alternative to editing prefs.js):

1. Open Zotero → Edit → Settings → Sync
2. Uncheck **Use Zotero's servers**
3. Enter your server URL: `https://zot.example.com/`
4. Enter your username and password
5. Click **Login** — your browser will open the OAuth page at your server
6. After logging in, an API key is automatically created and stored

> ⚠ The sync UI method may not work reliably on all Zotero versions. If the login fails, use the `prefs.js` method instead and obtain an API key via `https://zot.example.com/auth/login`.

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
