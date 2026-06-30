#!/bin/bash
# start.sh — 快速启动（首次运行请用 ./setup.sh）
# 用法: ./start.sh [--host-db]
set -e
cd "$(dirname "$0")"

HOST_DB_FLAG=""
while [ $# -gt 0 ]; do
    case "$1" in
        --host-db) HOST_DB_FLAG="--host-db"; shift ;;
        *) echo "未知参数: $1"; exit 1 ;;
    esac
done

if [ ! -f .env ]; then
    echo "首次运行? 请使用 ./setup.sh $HOST_DB_FLAG"
    exec ./setup.sh $HOST_DB_FLAG
fi

set -a; source .env; set +a

COMPOSE_PROFILE=""
if [ -z "$HOST_DB_FLAG" ]; then
    COMPOSE_PROFILE="--profile docker-db"
    echo "模式: Docker MariaDB"
else
    echo "模式: 宿主机 MariaDB"
fi

echo "构建并启动..."
sudo docker compose build && sudo docker compose $COMPOSE_PROFILE up -d

echo ""
echo "✅ zot-data 已启动"
echo "   API: http://localhost:${ZOTERO_API_PORT:-23231}/"
echo "   注册: http://localhost:${ZOTERO_API_PORT:-23231}/auth/register.php"
