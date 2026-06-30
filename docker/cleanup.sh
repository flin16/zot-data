#!/bin/bash
# cleanup.sh — stop and optionally remove all zot-data containers and data
# Usage:
#   ./cleanup.sh          stop containers, keep volumes (data preserved)
#   ./cleanup.sh --all    stop containers + delete volumes (full teardown)

set -e
cd "$(dirname "$0")"

REMOVE_VOLUMES=false
while [ $# -gt 0 ]; do
    case "$1" in
        --all|-a) REMOVE_VOLUMES=true; shift ;;
        *) echo "Usage: ./cleanup.sh [--all]"; exit 1 ;;
    esac
done

compose_run() {
    if docker ps >/dev/null 2>&1; then
        docker compose "$@"
    else
        sudo docker compose "$@"
    fi
}

echo "Stopping containers..."
compose_run --profile docker-db down 2>/dev/null || compose_run down 2>/dev/null || true
# Catch any orphaned containers from earlier versions
sudo docker rm -f docker-app-1 docker-mariadb-1 docker-minio-1 docker-stream-1 2>/dev/null || true

if $REMOVE_VOLUMES; then
    echo "Removing volumes..."
    sudo docker volume rm docker_mariadb_data docker_minio_data 2>/dev/null || true
    echo "Done. Everything is gone — next ./setup.sh starts fresh."
else
    echo "Done. Containers stopped, data volumes kept."
    echo "Use ./cleanup.sh --all to also delete database and file data."
fi
