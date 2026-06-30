# zot-data — Self-hosted Zotero Data Server

A fully self-contained [Zotero Data Server](https://github.com/zotero/dataserver) deployment with Docker, plus a Python sync client.

> ⚠ **Active development.** Breaking changes may occur.

---

## Quick Start

```bash
git clone https://github.com/flin16/zot-data.git
cd zot-data/docker
./setup.sh        # one-command setup & start
```

Then open [http://localhost:23231/auth/register.php](http://localhost:23231/auth/register.php) to create your account.

### What setup.sh does

| Step | What |
|------|------|
| 1/5 | Check system deps (Docker, docker-compose) |
| 2/5 | Check port 3306 — error if occupied (or requires `--host-db`) |
| 3/5 | Check Redis is running |
| 4/5 | Configure Docker (docker group, proxy, daemon) |
| 5/5 | Build images, start containers, init database |

### Services started

| Container | Port | Role |
|-----------|------|------|
| **app** | `:23231` | Zotero API server |
| **mariadb** | `:3306` | Database (auto-initialized with schema) |
| **minio** | `:9000` | S3 attachment storage |
| **stream** | `:8082` | WebSocket real-time sync (needs Redis) |

---

## Prerequisites

Only **Redis** needs to be running on the host (for the stream server):

```bash
# Arch
sudo pacman -S valkey && sudo systemctl start valkey

# Debian/Ubuntu
sudo apt install redis-server && sudo systemctl start redis
```

Everything else (MariaDB, MinIO, Apache/PHP) runs in Docker.

---

## Usage Modes

### Default: Docker MariaDB (recommended)

```bash
cd docker && ./setup.sh
```

MariaDB runs in a Docker container with isolated volume (`mariadb_data`). No host database is touched.

### Host MariaDB

```bash
cd docker && ./setup.sh --host-db
```

Use your existing host MariaDB instead of Docker. You must create the databases and user first:

```sql
CREATE DATABASE zotero CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE ids    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE www    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'zotero'@'%' IDENTIFIED BY 'zotropass';
GRANT ALL ON zotero.* TO 'zotero'@'%';
GRANT ALL ON ids.*    TO 'zotero'@'%';
GRANT ALL ON www.*    TO 'zotero'@'%';
```

> **Note:** Ensure `sql_mode` does NOT include `STRICT_TRANS_TABLES` (breaks Zotero zero-dates).

---

## The Login Flow

Zotero uses a session-based OAuth-like flow:

1. In Zotero client settings, enter your server URL (e.g. `http://192.168.1.82:23231/`)
2. Click **Login** — your browser opens a login page at your server
3. Enter your username and password (register at `/auth/register.php` first)
4. The server completes the session; Zotero client receives its API key automatically

No manual API key entry needed in the client.

### Getting an API key manually

For API access (scripts, curl, Python client):

```bash
# Register a new user
curl -X POST http://localhost:23231/auth/register.php \
  -d "username=myuser&password=mypass123&password2=mypass123"
# → Shows your API Key: <code>abc123def456</code>

# Or log in to see existing key
http://localhost:23231/auth/login.php
```

Then use the key for API calls:

```bash
curl -H "Zotero-API-Key: abc123def456" http://localhost:23231/users/1/items/top
```

---

## Group Management

A web UI is available at `/auth/groups.php`:

| Action | How |
|--------|-----|
| **Create group** | Name + owner + type + permissions |
| **Add members** | Select user, choose role (member/admin) |
| **Change roles** | Dropdown — instant save |
| **Remove members** | Click ✕ (last owner is protected) |
| **Update settings** | Type, library editing/reading, file editing |

Group types: `Private`, `PublicClosed`, `PublicOpen`.

---

## Migrating from an Existing Zotero Library

> **Important:** Back up your old SQLite BEFORE logging into the new server in your Zotero client. Once you log in, the client syncs and overwrites the local database — your old items are gone.

If you have an existing Zotero library with lots of items, migrate them before connecting your client to the new server:

1. **Back up the old database** (before logging into the new server):
   ```bash
   cp ~/Zotero/zotero.sqlite ~/Zotero/zotero-backup.sqlite
   ```

2. **Run the migration script**. It reads the backup, converts each item to API format, POSTs them to the server, and uploads attachment files to MinIO:
   ```bash
   cd python
   cp zotero_sync_config.json config.json
   # Edit config.json — set local_db, server URL, and credentials
   uv run --with requests --with minio python3 zotero_sync_client.py --config config.json
   ```

3. **Now log into the new server** from your Zotero client — your items are already there.

This script is a **one-time migration tool**, not for daily sync.

### How it works

| Step | What |
|------|------|
| Read | Opens the old SQLite, extracts all items, collections, notes, tags |
| Convert | `ItemConverter` transforms local-format metadata to dataserver API format |
| Upload | POSTs each item to `/users/{id}/items` (with retries) |
| Attachments | Computes MD5 hash of each attached file, uploads to MinIO bucket by hash key |
| Groups | Matches group names against server groups, syncs into the correct library |

### Config

```json
{
    "api_url": "http://localhost:23231",
    "username": "admin",
    "password": "adminpass",
    "local_db": "~/Zotero/zotero-backup.sqlite",
    "minio_endpoint": "localhost:9000",
    "minio_secure": false,
    "sync_attachments": true,
    "library_filter": "group"
}
```

Options:
- `library_filter`: `"all"`, `"user"`, or `"group"` (default: `"group"`)
- `--dry-run`: preview without uploading

---

## Reverse Proxy (optional)

For TLS and a friendly domain name:

```
# Caddy
zot.example.com { reverse_proxy 127.0.0.1:23231 }
s3.example.com   { reverse_proxy 127.0.0.1:9000 }
stream.example   { reverse_proxy 127.0.0.1:8082 }
```

## Zotero Client Configuration

Edit `prefs.js` (see [Zotero docs](https://www.zotero.org/support/prefs.js)):

```js
user_pref("extensions.zotero.api.url", "https://zot.example.com/");
user_pref("extensions.zotero.streaming.url", "wss://stream.example.com/");
```

Or via Zotero UI: **Edit → Settings → Sync** → uncheck "Use Zotero's servers" → enter your server URL → **Login**.

> The Login button opens your server's login page. After authenticating, the client gets its API key automatically. No manual key entry needed.

---

## Environment Variables

`.env` file is auto-generated by `setup.sh`. Key variables:

| Variable | Default | Notes |
|----------|---------|-------|
| `DB_HOST` | `127.0.0.1` | MariaDB host |
| `DB_PORT` | `3306` | MariaDB port |
| `ADMIN_USERNAME` | `admin` | Default admin user |
| `ADMIN_PASSWORD` | `adminpass` | Change in production! |
| `S3_PUBLIC_ENDPOINT` | `http://localhost:9000` | Public MinIO URL |
| `HTTP_PROXY` | — | Optional build-time proxy |

---

## What's Patched

The dataserver is cloned from [zotero/dataserver](https://github.com/zotero/dataserver) at build time. Patches via `docker/patch-header.php`:

| Change | File |
|--------|------|
| Redis/S3/MinIO config from env vars | `header.inc.php` |
| `/users/current` endpoint | `ApiController.php` |
| `format=versions` support | `GroupsController.php` |
| www database routing | `Password.inc.php`, `Storage.inc.php` |
| Annotation sortIndex fallback | `Item.inc.php` |
| Connection env-configurable | `dbconnect.inc.php` |

---

## License

AGPL-3.0. Wraps the [Zotero Data Server](https://github.com/zotero/dataserver) (also AGPL-3.0).
