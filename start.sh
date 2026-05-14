#!/bin/bash
set -e

# Start all zot-data services for local development
# Assumes MySQL, Redis are already running on the host.

cd "$(dirname "$0")"

# Load .env if exists
if [ -f .env ]; then
    set -a
    . .env
    set +a
fi

# Defaults
: "${DB_USER:=zotero}"
: "${DB_PASS:=zotropass}"
: "${DB_NAME:=zotero}"
: "${ADMIN_USERNAME:=admin}"
: "${ADMIN_PASSWORD:=adminpass}"
: "${AUTH_SALT:=dev-salt-change-in-production}"
: "${MINIO_ROOT_USER:=minioadmin}"
: "${MINIO_ROOT_PASSWORD:=minioadmin}"
: "${REDIS_HOST:=127.0.0.1}"
: "${REDIS_PASSWORD:=verfuh-mogvuT-8rembo}"
: "${S3_PUBLIC_ENDPOINT:=http://s3.0und.com}"

echo "Starting zot-data services..."

# MinIO
echo "[1/3] MinIO..."
docker rm -f minio-test 2>/dev/null || true
docker run -d --name minio-test \
  --network host \
  -e MINIO_ROOT_USER="$MINIO_ROOT_USER" \
  -e MINIO_ROOT_PASSWORD="$MINIO_ROOT_PASSWORD" \
  -v minio_data:/data \
  minio/minio server /data --console-address ":9001"

# Wait for MinIO
for i in $(seq 1 10); do
    if curl -sf http://127.0.0.1:9000/minio/health/live >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

# Create MinIO buckets
docker run --rm --network host --entrypoint sh minio/mc \
  -c "mc alias set local http://127.0.0.1:9000 $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD && \
      mc mb --ignore-existing local/zotero && \
      mc mb --ignore-existing local/zotero-fulltext" 2>/dev/null || true

# Dataserver
echo "[2/3] Data server..."
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
  -e S3_ENDPOINT=127.0.0.1:9000 \
  -e S3_PUBLIC_ENDPOINT="$S3_PUBLIC_ENDPOINT" \
  -e AWS_ACCESS_KEY_ID="$MINIO_ROOT_USER" \
  -e AWS_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD" \
  -e REDIS_HOST="$REDIS_HOST" \
  -e REDIS_PASSWORD="$REDIS_PASSWORD" \
  docker-app

# Wait for dataserver
for i in $(seq 1 15); do
    if curl -sf http://127.0.0.1:8080/ >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

# Stream server
echo "[3/3] Stream server..."
docker rm -f stream-test 2>/dev/null || true
docker run -d --name stream-test \
  --network host \
  -e STREAM_PORT=8082 \
  -e REDIS_HOST="$REDIS_HOST" \
  -e REDIS_PORT=6379 \
  -e REDIS_PASSWORD="$REDIS_PASSWORD" \
  -e API_URL=http://localhost:8080/ \
  docker-stream

echo ""
echo "All services running:"
echo "  Dataserver:  http://localhost:8080/"
echo "  MinIO:       http://localhost:9000/"
echo "  Stream:      http://localhost:8082/"
echo "  API test:    curl -u admin:adminpass http://localhost:8080/users/1/items?limit=1"
