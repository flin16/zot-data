#!/bin/bash
# setup.sh — bootstrap zot-data from scratch
# Usage:
#   ./setup.sh            start with Docker MariaDB (default)
#   ./setup.sh --host-db  use existing host MariaDB

set -e
cd "$(dirname "$0")"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
say()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn() { echo -e "${YELLOW}[warn]${NC} $*"; }
die()  { echo -e "${RED}[error]${NC} $*"; exit 1; }

# ── Parse flags ─────────────────────────────────────────────────────────────
USE_HOST_DB=false
while [ $# -gt 0 ]; do
    case "$1" in
        --host-db) USE_HOST_DB=true; shift ;;
        *) die "Unknown flag: $1 (try --host-db)" ;;
    esac
done

# ── Load config ─────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
    cp .env.example .env
    say "Generated .env with defaults"
fi
set -a; source .env; set +a

DB_PORT="${DB_PORT:-3306}"
PROXY="${HTTP_PROXY:-}"

say "Mode: $($USE_HOST_DB && echo 'host MariaDB' || echo 'Docker MariaDB')"

# ── 1. System deps (check only, don't install) ──────────────────────────────
say "1/5 Checking system dependencies..."

missing=""
for cmd in docker; do
    command -v "$cmd" >/dev/null 2>&1 || missing="$missing $cmd"
done
# docker-compose can be v1 binary or v2 plugin
docker compose version >/dev/null 2>&1 || missing="$missing docker-compose"

if [ -n "$missing" ]; then
    warn "Missing:$missing"
    warn ""
    warn "Install instructions:"
    warn "  Arch:    sudo pacman -S docker docker-compose"
    warn "  Debian:  sudo apt install docker.io docker-compose-v2"
    warn "  Ubuntu:  sudo snap install docker"
    warn "  RHEL:    sudo dnf install docker docker-compose"
    warn ""
    warn "Then: sudo systemctl start docker"
    die "Install the packages above and re-run"
fi

# ── 2. Port check ───────────────────────────────────────────────────────────
say "2/5 Checking port $DB_PORT..."

if ss -tlnp | grep -q ":$DB_PORT "; then
    PROC_INFO=$(sudo ss -tlnp | grep ":$DB_PORT " | head -1)
    if $USE_HOST_DB; then
        say "  Host MariaDB detected on port $DB_PORT — using it"
    else
        warn "Port $DB_PORT is occupied: $PROC_INFO"
        warn ""
        warn "Options:"
        warn "  a) Use the existing database:  ./setup.sh --host-db"
        warn "     (make sure zotero user exists — see --host-db notes below)"
        warn "  b) Stop the host DB and use Docker MariaDB:"
        warn "       sudo systemctl stop mariadb   # Arch / Debian"
        warn "       sudo systemctl stop mysql     # Debian / Ubuntu"
        die "Choose an option above"
    fi
else
    if $USE_HOST_DB; then
        die "No MariaDB on port $DB_PORT. Start it first, or run without --host-db"
    fi
    say "  Port $DB_PORT is free"
fi

# ── 3. Redis ────────────────────────────────────────────────────────────────
say "3/5 Checking Redis..."

REDIS_OK=false
for svc in valkey redis redis-server; do
    if systemctl -q is-active "$svc" 2>/dev/null; then
        say "  $svc is running"
        REDIS_OK=true
        break
    fi
done

if ! $REDIS_OK; then
    warn "Redis not running — stream server will be affected"
    warn "Install:"
    warn "  Arch:    sudo pacman -S valkey && sudo systemctl start valkey"
    warn "  Debian:  sudo apt install redis-server && sudo systemctl start redis-server"
    warn "  macOS:   brew install redis && brew services start redis"
    warn ""
    warn "Continuing anyway (API + MinIO will work, only streaming won't)"
fi

# ── 4. Docker daemon ────────────────────────────────────────────────────────
say "4/5 Configuring Docker..."

# Ensure docker can be used (sudo or docker group)
if ! docker ps >/dev/null 2>&1; then
    if ! groups | grep -q docker; then
        sudo usermod -aG docker "$USER" 2>/dev/null || true
        say "  Added $USER to docker group (re-login to take effect)"
    fi
fi

# Docker daemon config for host-network containers
if [ ! -f /etc/docker/daemon.json ]; then
    echo '{"iptables":false}' | sudo tee /etc/docker/daemon.json >/dev/null
    say "  Created /etc/docker/daemon.json (iptables off for host networking)"
fi

# Proxy for Docker daemon + containerd
if [ -n "$PROXY" ]; then
    say "  Proxy detected: $PROXY"
    for svc in docker containerd; do
        DROPIN="/etc/systemd/system/${svc}.service.d/proxy.conf"
        if [ ! -f "$DROPIN" ]; then
            sudo mkdir -p "$(dirname "$DROPIN")"
            sudo tee "$DROPIN" >/dev/null << EOF
[Service]
Environment="HTTP_PROXY=$PROXY"
Environment="HTTPS_PROXY=$PROXY"
Environment="NO_PROXY=localhost,127.0.0.1"
EOF
            say "  Added proxy to $svc"
        fi
    done
    sudo systemctl daemon-reload
    sudo systemctl restart containerd docker
fi

sudo systemctl start docker 2>/dev/null || true
sudo systemctl start containerd 2>/dev/null || true

# ── 5. Build & start ────────────────────────────────────────────────────────
say "5/5 Build and start..."

COMPOSE_CMD="docker compose"
COMPOSE_PROFILE=""

if $USE_HOST_DB; then
    say "  Starting with host MariaDB..."
else
    COMPOSE_PROFILE="--profile docker-db"
    say "  Starting with Docker MariaDB..."
fi

# Try without sudo first (docker group), fall back to sudo
compose_pre() {
    if docker ps >/dev/null 2>&1; then
        $COMPOSE_CMD "$@"
    else
        sudo $COMPOSE_CMD "$@"
    fi
}

if ! compose_pre build; then
    die "Build failed — check network or proxy settings"
fi

compose_pre down 2>/dev/null || true
compose_pre $COMPOSE_PROFILE up -d

say "Waiting for services..."
for i in $(seq 1 40); do
    if curl -sf "http://localhost:${ZOTERO_API_PORT:-23231}/" >/dev/null 2>&1; then
        say "API ready after ${i}s"
        break
    fi
    if [ "$i" -eq 40 ]; then
        warn "API not responding — check logs: docker compose logs app"
    fi
    sleep 1
done

# ── Done ─────────────────────────────────────────────────────────────────────
DB_MODE="$($USE_HOST_DB && echo 'host MariaDB' || echo 'Docker MariaDB')"
echo ""
echo "======================================================"
echo "  zot-data started"
echo "======================================================"
echo "  DB:       $DB_MODE (port ${DB_PORT:-3306})"
echo "  API:      http://localhost:${ZOTERO_API_PORT:-23231}/"
echo "  MinIO:    http://localhost:${MINIO_PORT:-9000}/"
echo "  Console:  http://localhost:${MINIO_CONSOLE_PORT:-9001}/"
echo "  Stream:   http://localhost:${STREAM_PORT:-8082}/"
echo ""
echo "  Register: http://localhost:${ZOTERO_API_PORT:-23231}/auth/register.php"
echo "  Login:    http://localhost:${ZOTERO_API_PORT:-23231}/auth/login.php"
echo "  Groups:   http://localhost:${ZOTERO_API_PORT:-23231}/auth/groups.php"
echo ""
echo "  Default admin: admin / adminpass"
echo "======================================================"

APIPORT="${ZOTERO_API_PORT:-23231}"
echo ""
say "Next: open http://localhost:$APIPORT/auth/register.php to create your account"
if $USE_HOST_DB; then
    warn ""
    warn "Host MariaDB checklist:"
    warn "  1. Create the zotero user with grants (if not done already):"
    warn "     CREATE USER 'zotero'@'%' IDENTIFIED BY 'zotropass';"
    warn "     GRANT ALL ON zotero.* TO 'zotero'@'%';"
    warn "     GRANT ALL ON ids.*    TO 'zotero'@'%';"
    warn "     GRANT ALL ON www.*    TO 'zotero'@'%';"
    warn "  2. Remove STRICT_TRANS_TABLES from sql_mode:"
    warn "     Check: mysql -e 'SELECT @@sql_mode;' | grep STRICT"
    warn "     Edit  /etc/mysql/mariadb.conf.d/ (or /etc/my.cnf.d/) and restart"
fi
