#!/bin/sh
set -e

# Build redis URL (password optional)
REDIS_PASS="${REDIS_PASSWORD}"
if [ -n "$REDIS_PASS" ]; then
    REDIS_URL="${REDIS_PASS}@${REDIS_HOST:-localhost}:${REDIS_PORT:-6379}"
else
    REDIS_URL="${REDIS_HOST:-localhost}:${REDIS_PORT:-6379}"
fi

cat > /usr/src/app/config/local.json << EOF
{
  "httpPort": ${STREAM_PORT:-8081},
  "redis": {
    "url": "redis://${REDIS_URL}"
  },
  "apiURL": "${API_URL:-https://api.zotero.org/}"
}
EOF

echo "Stream server config:"
cat /usr/src/app/config/local.json

exec node /usr/src/app/index.js