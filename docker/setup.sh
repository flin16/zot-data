#!/bin/bash
# setup.sh — 一键初始化 zot-data 环境并启动服务
# 用法:
#   ./setup.sh          — 默认启动 Docker MariaDB
#   ./setup.sh --host-db — 改用宿主机 MariaDB（需先启动 host mariadb）

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
        *) die "未知参数: $1 (可用: --host-db)" ;;
    esac
done

# ── Load config ─────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
    cp .env.example .env
    say "已生成 .env 文件，使用默认配置"
fi
set -a; source .env; set +a

DB_PORT="${DB_PORT:-3306}"
PROXY="${HTTP_PROXY:-}"

say "模式: $($USE_HOST_DB && echo '宿主机 MariaDB' || echo 'Docker MariaDB')"

# ── 1. Check system packages ────────────────────────────────────────────────
say "1/5 检查系统依赖..."

missing=""
for pkg in docker docker-compose; do
    pacman -Q "$pkg" >/dev/null 2>&1 || missing="$missing $pkg"
done
if [ -n "$missing" ]; then
    say "安装缺失的包:$missing"
    sudo pacman -S --noconfirm $missing || die "包安装失败"
fi

# ── 2. Port conflict check (only in Docker DB mode) ─────────────────────────
say "2/5 检查端口冲突..."

if $USE_HOST_DB; then
    # Host DB mode: ensure MariaDB is reachable
    if ! ss -tlnp | grep -q ":$DB_PORT "; then
        warn "端口 $DB_PORT 上未检测到 MariaDB（宿主机模式）"
        warn "请确保宿主机 MariaDB 已启动:"
        warn "  sudo systemctl start mariadb"
        die "MariaDB 未运行"
    fi
    say "  检测到宿主机 MariaDB (端口 $DB_PORT)"
else
    # Docker DB mode: port must be free
    if ss -tlnp | grep -q ":$DB_PORT "; then
        PROC=$(sudo ss -tlnp | grep ":$DB_PORT " | head -1)
        warn "端口 $DB_PORT 已被占用: $PROC"
        warn "宿主机 MariaDB 正在运行。如需使用宿主机模式:"
        warn "  ./setup.sh --host-db"
        warn ""
        warn "如需释放端口给 Docker MariaDB:"
        warn "  sudo systemctl stop mariadb"
        warn "  sudo systemctl disable mariadb"
        die "请先处理端口冲突"
    fi
    say "  端口 $DB_PORT 空闲"
fi

# ── 3. Redis / Valkey ──────────────────────────────────────────────────────
say "3/5 检查 Redis..."

if systemctl -q is-active valkey 2>/dev/null; then
    say "  Valkey (Redis) 已运行"
elif systemctl -q is-active redis 2>/dev/null; then
    say "  Redis 已运行"
else
    warn "  Redis 未运行，stream server 可能受影响"
    warn "  安装: sudo pacman -S valkey && sudo systemctl start valkey"
fi

# ── 4. Docker ───────────────────────────────────────────────────────────────
say "4/5 配置 Docker..."

# Ensure user is in docker group
if ! groups "$USER" | grep -q docker; then
    sudo usermod -aG docker "$USER"
    say "  已将 $USER 加入 docker 组（重新登录后生效）"
fi

# Docker daemon config (skip iptables for host-network containers)
if [ ! -f /etc/docker/daemon.json ]; then
    echo '{"iptables":false}' | sudo tee /etc/docker/daemon.json >/dev/null
fi

# Proxy for Docker daemon + containerd
if [ -n "$PROXY" ]; then
    say "  检测到代理配置: $PROXY"
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
        fi
    done
    sudo systemctl daemon-reload
    sudo systemctl restart containerd docker
fi

if ! systemctl -q is-active docker 2>/dev/null; then
    sudo systemctl start docker
fi
if ! systemctl -q is-active containerd 2>/dev/null; then
    sudo systemctl start containerd
fi

# ── 5. Build & Start ───────────────────────────────────────────────────────
say "5/5 构建并启动..."

COMPOSE_CMD="sudo docker compose"
COMPOSE_PROFILE=""

if $USE_HOST_DB; then
    COMPOSE_PROFILE=""
    say "  启动服务（使用宿主机 MariaDB）..."
else
    COMPOSE_PROFILE="--profile docker-db"
    say "  启动服务（使用 Docker MariaDB）..."
fi

if ! $COMPOSE_CMD build; then
    die "构建失败，请检查网络或代理设置"
fi

$COMPOSE_CMD down 2>/dev/null || true
$COMPOSE_CMD $COMPOSE_PROFILE up -d

# Wait for app health (init.sh may need a moment for MySQL wait loop)
say "等待服务启动..."
for i in $(seq 1 35); do
    if curl -sf http://localhost:${ZOTERO_API_PORT:-23231}/ >/dev/null 2>&1; then
        break
    fi
    if [ "$i" -eq 35 ]; then
        warn "API 未能在预期时间内响应，请检查容器日志: sudo docker compose logs app"
    fi
    sleep 1
done

# ── Done ─────────────────────────────────────────────────────────────────────
DB_MODE="$($USE_HOST_DB && echo '宿主机 MariaDB' || echo 'Docker MariaDB')"
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║          zot-data 已启动                             ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  DB:       $DB_MODE (port ${DB_PORT:-3306})"
echo "║  API:      http://localhost:${ZOTERO_API_PORT:-23231}/"
echo "║  MinIO:    http://localhost:${MINIO_PORT:-9000}/"
echo "║  Console:  http://localhost:${MINIO_CONSOLE_PORT:-9001}/"
echo "║  Stream:   http://localhost:${STREAM_PORT:-8082}/"
echo "║                                                      ║"
echo "║  注册:     http://localhost:${ZOTERO_API_PORT:-23231}/auth/register.php"
echo "║  登录:     http://localhost:${ZOTERO_API_PORT:-23231}/auth/login.php"
echo "║  群组:     http://localhost:${ZOTERO_API_PORT:-23231}/auth/groups.php"
echo "║                                                      ║"
echo "║  默认管理员: admin / adminpass                        ║"
echo "╚══════════════════════════════════════════════════════╝"

APIPORT="${ZOTERO_API_PORT:-23231}"
echo ""
say "下一步: 打开 http://localhost:$APIPORT/auth/register.php 注册你的账号"
say "然后把获取的 API Key 填入 Zotero 客户端的同步设置"
if $USE_HOST_DB; then
    say "（注意: 宿主机 MariaDB 的 sql_mode 需要去掉 STRICT_TRANS_TABLES）"
    say "  检查: mysql -e \"SELECT @@sql_mode;\" | grep -q STRICT"
    say "  修复: 编辑 /etc/my.cnf.d/ 下的配置，去掉 STRICT_TRANS_TABLES 后重启 MariaDB"
fi