#!/bin/bash
set -e

# Start all zot-data services for local development.
# Assumes MySQL + Redis are already running on the host.
#
# Config: cp docker/.env.example .env, edit, then ./start.sh

cd "$(dirname "$0")"

# ── Load config ──────────────────────────────────────────────────────────────
if [ -f .env ]; then
    set -a
    . .env
    set +a
elif [ -f docker/.env ]; then
    set -a
    . docker/.env
    set +a
fi

# Defaults — override via .env values above
: "${DOMAIN:=localhost}"
: "${API_URL:=http://localhost:8080}"
: "${S3_PUBLIC_ENDPOINT:=http://localhost:9000}"
: "${STREAM_URL:=ws://localhost:8082}"
: "${DB_USER:=zotero}"
: "${DB_PASS:=zotropass}"
: "${DB_NAME:=zotero}"
: "${ADMIN_USERNAME:=admin}"
: "${ADMIN_PASSWORD:=adminpass}"
: "${AUTH_SALT:=dev-salt-change-in-production}"
: "${MINIO_ROOT_USER:=minioadmin}"
: "${MINIO_ROOT_PASSWORD:=minioadmin}"
: "${MINIO_PORT:=9000}"
: "${MINIO_CONSOLE_PORT:=9001}"
: "${REDIS_HOST:=127.0.0.1}"
: "${REDIS_PORT:=6379}"
: "${REDIS_PASSWORD:=}"
: "${STREAM_PORT:=8082}"
: "${ZOTERO_API_PORT:=8080}"

echo "Starting zot-data for domain: $DOMAIN"
echo " API:  $API_URL"
echo " S3:   $S3_PUBLIC_ENDPOINT"
echo " Stream: $STREAM_URL"

# ── MinIO ─────────────────────────────────────────────────────────────────────
echo ""
echo ">>> MinIO..."
docker rm -f minio-test 2>/dev/null || true
docker run -d --name minio-test \
  --network host \
  -e MINIO_ROOT_USER="$MINIO_ROOT_USER" \
  -e MINIO_ROOT_PASSWORD="$MINIO_ROOT_PASSWORD" \
  -v minio_data:/data \
  minio/minio server /data --console-address ":$MINIO_CONSOLE_PORT"

for i in $(seq 1 10); do
    if curl -sf http://127.0.0.1:$MINIO_PORT/minio/health/live >/dev/null 2>&1; then break; fi
    sleep 1
done
docker run --rm --network host --entrypoint sh minio/mc \
  -c "mc alias set local http://127.0.0.1:$MINIO_PORT $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD \
      && mc mb --ignore-existing local/zotero \
      && mc mb --ignore-existing local/zotero-fulltext" 2>/dev/null || true
echo "  MinIO ready on port $MINIO_PORT"

# ── Dataserver ────────────────────────────────────────────────────────────────
echo ""
echo ">>> Data server..."
docker rm -f app-test 2>/dev/null || true
docker run -d --name app-test \
  --network host \
  -e DB_HOST=127.0.0.1 \
  -e DB_USER="$DB_USER" \
  -e DB_PASS="$DB_PASS" \
  -e DB_NAME="$DB_NAME" \
  -e ADMIN_USERNAME="$ADMIN_USERNAME" \
  -e ADMIN_PASSWORD="$ADMIN_PASSWORD" \
  -e AUTH_SALT="$AUTH_SALT" \
  -e S3_ENDPOINT=127.0.0.1:$MINIO_PORT \
  -e S3_PUBLIC_ENDPOINT="$S3_PUBLIC_ENDPOINT" \
  -e AWS_ACCESS_KEY_ID="$MINIO_ROOT_USER" \
  -e AWS_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD" \
  -e REDIS_HOST="$REDIS_HOST" \
  -e REDIS_PORT="$REDIS_PORT" \
  -e REDIS_PASSWORD="$REDIS_PASSWORD" \
  docker-app

for i in $(seq 1 15); do
    if curl -sf http://127.0.0.1:$ZOTERO_API_PORT/ >/dev/null 2>&1; then break; fi
    sleep 1
done
echo "  Dataserver ready on port $ZOTERO_API_PORT"

# ── Stream server ─────────────────────────────────────────────────────────────
echo ""
echo ">>> Stream server..."
docker rm -f stream-test 2>/dev/null || true
docker run -d --name stream-test \
  --network host \
  -e STREAM_PORT="$STREAM_PORT" \
  -e REDIS_HOST="$REDIS_HOST" \
  -e REDIS_PORT="$REDIS_PORT" \
  -e REDIS_PASSWORD="$REDIS_PASSWORD" \
  -e API_URL=http://127.0.0.1:$ZOTERO_API_PORT/ \
  docker-stream

echo "  Stream ready on port $STREAM_PORT"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  All zot-data services running          ║"
echo "╠══════════════════════════════════════════╣"
echo "║  Dataserver  http://localhost:$ZOTERO_API_PORT/    ║"
echo "║  MinIO       http://localhost:$MINIO_PORT/        ║"
echo "║  Stream      http://localhost:$STREAM_PORT/       ║"
echo "║                                            ║"
echo "║  Login:  $API_URL/auth/login     ║"
echo "║  S3:     $S3_PUBLIC_ENDPOINT          ║"
echo "╚══════════════════════════════════════════╝"
