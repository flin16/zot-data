# Zotero Data Server 开发日志

## 目标
在 Linux 服务器上用 Docker 搭建 Zotero Data Server，让远程 Mac 上的 Zotero 客户端通过 `http://yourserver.com` 同步数据。

## 架构
- **服务器**: Linux 6.18，IP `10.0.0.210`，Caddy 反向代理 + Cloudflare DNS + TLS
- **Docker**: `php:8.2-apache` + MinIO（可选）
- **数据库**: 宿主机 MariaDB（`host.docker.internal:3306`）
- **缓存**: 宿主机 Redis（`host.docker.internal:6379`）
- **S3 存储**: MinIO Docker（`minio:9000`）
- **外部访问**: `https://yourserver.com` → Caddy → `localhost:8080`（Docker）

## 数据库
- `zotero` 主库 + `ids` + `www`
- 分片表全指向同一台 MariaDB（单主机模式）
- `shardHosts.address` 存储 `host.docker.internal`（18字符，原始 `varchar(15)` 会截断）

## 部署记录

### 1. Docker 配置
- `docker-compose.yml`: PHP/Apache + MinIO，MariaDB/Redis 走宿主机
- `Dockerfile`: php:8.2-apache，安装 Redis/MinIO client、Composer、NFS/ionCube
- `init.sh`: 自动初始化数据库（`libraries` 表是否存在判断首次运行）
- `patch-header.php`: 构建时打所有源码补丁

### 2. 源码补丁（patch-header.php）
按执行顺序：
1. `misc/master.sql`: `shardHosts.address` `varchar(15)` → `varchar(64)`
2. `htdocs/index.php`: `require('config/routes.inc.php')` → `require('../include/config/routes.inc.php')`
3. `include/config/routes.inc.php`: `require('mvc/Router.inc.php')` → `require(__DIR__ . '/../mvc/Router.inc.php')`
4. `include/Core.inc.php`: 声明 `public static $AWS_PUBLIC = null`
5. `include/config/config.inc.php`: `REDIS_HOSTS` host 改为 `'redis'` 占位符
6. `include/header.inc.php`: Redis host 运行时覆盖（`getenv('REDIS_HOST') ?: 'host.docker.internal'`）
7. `include/header.inc.php`: S3/MinIO env var 支持、env 凭据、ES 条件初始化、`AWS_PUBLIC` presigned URL
8. `include/DB.inc.php`: shard 连接凭据从 `MYSQL_USER`/`ZOTERO_MYSQL_PASS` 环境变量读取
9. `controllers/LoginSessionsController.php`: `loginURL` 使用请求 `Host` 头，不硬编码 `localhost`
10. `model/auth/Password.inc.php`: www DB 名从 `zotero_www_dev` 改为 `www`

### 3. .htaccess 配置
- `htdocs/.htaccess`:
  - `auto_prepend_file` → `/var/www/html/include/header.inc.php`
  - 注释掉 IP 访问控制（允许所有 IP）
  - 新增 RewriteRule: `^auth/(login|register)$` → `auth/$1.php`（解决扩展名省略路由问题）
- `htdocs/auth/.htaccess`:
  - `auto_prepend_file` → `/var/www/html/htdocs/auth/prepend.php`（绕过全局 header.inc.php）
  - `prepend.php`: 空白文件，只设 `error_reporting`

### 4. auth 登录页面
放在 `htdocs/auth/` 下（独立于 MVC 路由）：
- `login.php`: 显示登录表单，POST 验证 `www.users`，完成后 `UPDATE loginSessions SET status='completed', userID=?`
- `register.php`: 自注册，创建 `www.users` + `zotero.users` + `libraries` + 生成 API Key

### 5. 会话流程（session-based login）
1. Zotero 客户端 `POST /keys/sessions`（username/password）→ 返回 `sessionToken` + `loginURL`
2. 客户端打开 `loginURL`（用户浏览器访问 `http://yourserver.com/auth/login?session=TOKEN`）
3. 用户填密码提交 → `POST /auth/login` → `UPDATE loginSessions SET status='completed'`
4. 客户端随后用该 sessionToken 完成后续同步

## 已知问题及修复
| 问题 | 修复 |
|------|------|
| `shardHosts.address` varchar(15) 截断 `host.docker.internal` | ALTER TABLE + 改 master.sql |
| `shardLibraries` 表 INSERT 列顺序错误（`shardID, libraryID` vs `libraryID, libraryType, ...`） | 修正为正确的列名顺序 |
| `zotero-schema` git submodule 在 Docker build 时报 "dubious ownership" | 改用直接 `git clone` 替代 submodule |
| `Schema::updateDatabase()` 从未被调用，DB schema version=0，缺 `eventPlace` 等 19 个字段 | 新增 `init-schema.php`，在 `init.sh` 首次启动时调用 |
| `eventPlace`、`conferenceName` 等字段服务器端不存在 | 调用 `Schema::updateDatabase()` 后解决 |
| shard 连接无凭据（`host`/`port`/`user`/`pass` 全部 null） | DB.inc.php 从环境变量读取 |
| `.user.ini` 被 mod_php 忽略 | 改用 `.htaccess` + `php_value` |
| `require('../mvc/...')` 相对路径在 Apache 下失败 | 改用 `__DIR__` |
| `/auth/login` 扩展名省略 404 | 根目录 `.htaccess` RewriteRule 映射 |
| IP 10.0.0.x 被 deny 规则拦截 | 注释掉 `.htaccess` 中 deny 规则 |
| `loginURL` 返回 `localhost` | 改用 `$_SERVER['HTTP_HOST']` |
| `www` DB 名为 `zotero_www_dev` | 改为 `www` |
| `/users/current` 404（Zotero API 标准端点缺失） | 新增 `ApiController::currentUser()` + `/users/current` 路由 |
| session 完成后的 key 无 library 权限 | `login.php` POST 时同时写入 `keyPermissions`（library + write）|
| patch-header.php 中 `\t` 被 str_replace 级联转义 | 改用 `sprintf()` 格式字符串替代含 `\t` 的 heredoc |

## 测试账号
- Username: `admin`
- Password: `adminpass`
- API Key: `REMOVED`

## Python Sync Client

`python/zotero_sync_client.py` — 读取本地 `~/Zotero/zotero.sqlite`，上传 items 到自建服务器 + 附件到 MinIO。

### 同步流程修复记录

#### math 组 libraryID 映射
- 本地 SQLite `libraryID`（math=3）与服务器 group 的 `libraryID` 不一致
- 修复：新增 `_resolve_server_library_id()` 调用 `GET /users/{id}/groups` 按 group name 匹配
- `POST /groups/{server_group_id}/items` 用服务器端真实 ID，非本地 libraryID

#### 手动插入 math 组
math 组在服务器端不存在，手动插入：
```sql
INSERT INTO libraries (libraryID, libraryType, lastUpdated, version, storageUsage)
    VALUES (3, 'group', NOW(), 0, 0);
INSERT INTO `groups` (groupID, libraryID, name, ...) VALUES (2, 3, 'math', ...);
INSERT INTO groupUsers (groupID, libraryID, status, ...) VALUES (2, 3, 'owner', ...);
INSERT INTO shardLibraries (libraryID, libraryType, lastUpdated, version, storageUsage)
    VALUES (3, 'group', NOW(), 0, 0);
```

#### POST 请求格式
- `{"items": [...]}` 格式：API 接受嵌套格式，`post_items()` 自动包装

#### 非 API 字段过滤
本地 DB 中有些字段服务器不接受，统一在 `ItemConverter` 中过滤：
- `repository`、`citationKey`、`archiveID` → `NON_API_FIELDS`
- `preprint` item type 不被服务器接受 → 映射为 `document`（`ITEM_TYPE_MAP_EXTRA`）

#### Item version
新 item 的 `version` 必须为 0，不能用本地 version

#### 响应解析（HTTP 200 ≠ 成功）
Zotero API `POST /items` 返回 HTTP 200，但 `failed` 段可能包含被拒 item：
- `successful` + `success` 段：真正成功的 key
- `failed` 段中 `code == 412`：服务器已有（已同步），也加入成功列表
- 只将真正成功的 item key 写入 `syncedItems`

#### 附件同步（`_sync_attachments`）
- `_sync_items` 过滤掉 `itemTypeID == attachment` 的 items
- `LocalDB.get_items()` SQL 层面也过滤了 attachment
- 附件走独立流程：
  1. `POST /items` 创建附件 item（含 `linkMode` 字符串、`contentType`、`filename`、`md5`）
  2. `linkMode` 格式：整数 → 字符串名（`0→imported_file`, `1→imported_url`, `2→linked_file`, `3→linked_url`）
  3. 上传文件到 MinIO，key 为 MD5 哈希

#### MinIO 凭证
- `minio_secure: false` — Mac 通过 Caddy 走 HTTPS，但 MinIO 只支持 HTTP
- 桶策略改为 `public`：`mc anonymous set public local/zotero`

### 配置
- `python/zotero_sync_config.json`
  - `library_filter: "group"`：仅同步 group 库
  - `sync_attachments: true`
  - `minio_secure: false`

## 状态
- ✅ Docker 容器启动正常
- ✅ 数据库初始化完成（`libraries`、`users`、`keys`、`shards`、`shardHosts` 数据就绪）
- ✅ `/keys/sessions` 返回正确 `sessionToken` 和 `loginURL`
- ✅ `/auth/login` 表单显示正常，POST 提交 session 正确标记为 `completed`
- ✅ session 完成时同时写入 `keyPermissions`（library + write）
- ✅ `/users/current` 返回 `{"userID":1,"username":"admin","libraryID":1}`
- ✅ `/users/1/items` 返回 `[]`（空用户库）
- ✅ 全流程端到端测试通过（Caddy → Docker → DB）
- ✅ Python Sync Client 端到端同步成功（math 组 14 items + 2 attachments 入库 MinIO）
