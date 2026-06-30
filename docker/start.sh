#!/bin/bash
# start.sh — quick start (first run? use ./setup.sh)
# Usage: ./start.sh [--host-db]
set -e
cd "$(dirname "$0")"

HOST_DB_FLAG=""
while [ $# -gt 0 ]; do
    case "$1" in
        --host-db) HOST_DB_FLAG="--host-db"; shift ;;
        *) echo "Unknown flag: $1"; exit 1 ;;
    esac
done

if [ ! -f .env ]; then
    echo "First run? Use ./setup.sh $HOST_DB_FLAG"
    exec ./setup.sh $HOST_DB_FLAG
fi

set -a; source .env; set +a

COMPOSE_PROFILE=""
if [ -z "$HOST_DB_FLAG" ]; then
    COMPOSE_PROFILE="--profile docker-db"
    echo "Mode: Docker MariaDB"
else
    echo "Mode: host MariaDB"
fi

echo "Building and starting..."

compose_run() {
    if docker ps >/dev/null 2>&1; then
        docker compose "$@"
    else
        sudo docker compose "$@"
    fi
}

compose_run build
compose_run $COMPOSE_PROFILE up -d

echo ""
echo "zot-data started"
echo "  API:      http://localhost:${ZOTERO_API_PORT:-23231}/"
echo "  Register: http://localhost:${ZOTERO_API_PORT:-23231}/auth/register.php"
