# zot-data

Self-hosted Zotero data server.

- **docker/** — Docker setup: clones [zotero/dataserver](https://github.com/zotero/dataserver) from GitHub, applies environment patches, starts PHP + Apache + MinIO
- **python/** — Minimal sync client: reads local Zotero SQLite → uploads to self-hosted server

## docker/ — 一键启动

```bash
cd docker
cp .env.example .env   # 编辑 MYSQL_HOST 指向你的数据库主机
./start.sh
```

macOS 上 `MYSQL_HOST=host.docker.internal` 即可访问宿主机 MySQL。

**不包含 MySQL**，需自行准备（本地安装、Docker service、远程服务器均可）。首次启动时自动初始化数据库 schema 和 admin 账号。

## python/ — 同步

```bash
cd python
# 安装依赖（用 uv，不污染系统）
uv run --with requests --with minio python3 zotero_sync_client.py --config zotero_sync_config.json
```

认证方式：`admin` / `ADMIN_PASSWORD`（HTTP Basic Auth），在 `zotero_sync_config.json` 中配置。
