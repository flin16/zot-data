# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Self-hosted Zotero data server with two components:
- **docker/**: PHP/Apache server (cloned from `zotero/dataserver`) + MinIO, with MariaDB/Redis on the host
- **python/**: Minimal sync client that reads a local Zotero SQLite and uploads to the self-hosted server

## Docker (API Server)

```bash
cd docker
cp .env.example .env   # edit MYSQL_HOST for your environment
./start.sh            # build image, init DB, start containers
```

Key ports: `23231` (API), `9000` (MinIO S3 API), `9001` (MinIO console).

The official `zotero/dataserver` is cloned at build time and patched by `patch-header.php`. Patches include:
- `shardHosts.address` varchar 15→64 ( accommodates `host.docker.internal`)
- Relative `require()` → `__DIR__`-based (Apache path resolution fix)
- Redis/S3/MinIO env var injection in `header.inc.php`
- Shard DB credentials from env vars instead of config file
- `loginURL` uses `$_SERVER['HTTP_HOST']` instead of hardcoded `localhost`
- `/users/current` endpoint added via `ApiController::currentUser()`

`init.sh` runs on container start: clones the DB schema if first run, creates admin account, starts Apache.

## Python Sync Client

```bash
cd python
uv run --with requests --with minio python3 zotero_sync_client.py --config zotero_sync_config.json
```

Auth: HTTP Basic (`admin` / `ADMIN_PASSWORD`). Default config at `zotero_sync_config.json`. `ZOTERO_PASSWORD` env var overrides it.

Sync flow: reads local `~/Zotero/zotero.sqlite` → converts items via `ItemConverter` → POSTs to server API → uploads attachments to MinIO (by MD5 hash key).

Default `--library-filter` is `group` (only syncs group libraries). Override with `--library-filter all` or `--library-filter user`.

## Architecture

```
Zotero Client (Mac)
  → https://zot.0und.com  (Caddy → Docker :23231)
       ├── PHP/Apache (zotero/dataserver, port 80)
       │      ├── MariaDB  (host.docker.internal:3306)  ← DB: zotero, www, ids
       │      ├── Redis    (host.docker.internal:6379)
       │      └── MinIO    (Docker internal :9000)
       └── MinIO S3 API   (s3.0und.com → Docker :9000)

Local Mac Zotero
  → python/zotero_sync_client.py
       ├── reads ~/Zotero/zotero.sqlite
       ├── posts items → https://zot.0und.com
       └── uploads attachments → s3.0und.com (MinIO)
```

Session-based login: Zotero client `POST /keys/sessions` → gets `loginURL` → user visits URL → submits password → `UPDATE loginSessions SET status='completed'` → client completes sync.

## Environment Variables (docker/.env)

| Variable | Default | Notes |
|---|---|---|
| `MYSQL_HOST` | `host.docker.internal` | Host machine MariaDB |
| `MYSQL_USER` | `zotero` | |
| `ZOTERO_MYSQL_PASS` | `zotropass` | |
| `ADMIN_USERNAME` | `admin` | |
| `ADMIN_PASSWORD` | `adminpass` | |
| `MINIO_ROOT_USER` | `minioadmin` | MinIO AND Python client must match |
| `MINIO_ROOT_PASSWORD` | `minioadmin` | MinIO AND Python client must match |
| `S3_PUBLIC_ENDPOINT` | `http://localhost:9000` | Public S3 URL (e.g. Caddy proxied) |
| `ZOTERO_API_PORT` | `23231` | External port for API |
