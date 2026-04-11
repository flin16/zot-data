#!/bin/bash
# start.sh — 一键启动 zot-data 服务
# 用法: cd docker && ./start.sh

set -e
cd "$(dirname "$0")"

echo "==> 检查 Docker Desktop..."
if ! docker info > /dev/null 2>&1; then
    echo "Docker 未运行，请先启动 Docker Desktop。"
    exit 1
fi

if [ ! -f .env ]; then
    cp .env.example .env
    echo "已生成 .env，请编辑后重新运行。"
    echo "需要配置 MYSQL_HOST 指向有 Zotero 数据库的主机。"
    exit 1
fi

source .env
MYSQL_HOST="${MYSQL_HOST:-host.docker.internal}"

if [ "$MYSQL_HOST" = "host.docker.internal" ]; then
    if ! nc -z localhost 3306 2>/dev/null; then
        echo "MYSQL_HOST=host.docker.internal 但本机 3306 不可访问。"
        echo "请确保 MySQL 在本机运行，或将 MYSQL_HOST 改为服务器地址。"
        exit 1
    fi
fi

echo "==> 构建并启动 (app + minio)..."
docker compose up -d --build

ZOTERO_PORT="${ZOTERO_API_PORT:-8080}"
MINIO_PORT="${MINIO_PORT:-9000}"

echo ""
echo "✅ 已启动"
echo "   API:     http://localhost:${ZOTERO_PORT}/"
echo "   MinIO:   http://localhost:${MINIO_PORT}/  (minioadmin/minioadmin)"
echo ""
echo "   同步:    cd ../python && uv run --with requests --with minio python3 zotero_sync_client.py"
