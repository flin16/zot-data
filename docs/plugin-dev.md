# Zotero 插件开发

## 背景：为什么需要插件

Python 同步脚本 (`python/zotero_sync_client.py`) 需要直接读取 Zotero 的 SQLite 数据库，但 Zotero 使用**排他锁**（journal_mode=delete），外部进程无法在 Zotero 运行时并发访问数据库。

解决方案：做成 Zotero 插件，运行在 Zotero 进程内部，可以直接访问 `Zotero.DB` 并发起 HTTP 请求。

## 插件架构

使用 **Bootstrap** 方式（无需 XUL overlay），Zotero 7 支持 `manifest.json`。

## 目录结构

```
zotero-plugin/
├── manifest.json          # Zotero 7 manifest (manifest_version: 2)
├── bootstrap.js           # install/startup/shutdown/shutdown hooks
├── zot-data-sync.js      # 主逻辑
├── prefs.js               # 默认配置
├── locale/
│   └── en-US/
│       └── zot-data-sync.ftl  # i18n 字符串
└── resources/
    └── icon.svg
```

## manifest.json

```json
{
    "manifest_version": 2,
    "name": "ZotData Sync",
    "version": "0.1.0",
    "description": "Sync items to custom self-hosted Zotero server",
    "applications": {
        "zotero": {
            "id": "zot-data-sync@example.com",
            "strict_min_version": "7.0"
        }
    }
}
```

## bootstrap.js

```js
var ZotDataSync;

async function startup({ id, version, rootURI }) {
    Services.scriptloader.loadSubScript(rootURI + 'zot-data-sync.js');
    ZotDataSync.init({ id, version, rootURI });
    ZotDataSync.addToAllWindows();
    await ZotDataSync.main();
}

function onMainWindowLoad({ window }) {
    ZotDataSync.addToWindow(window);
}

function onMainWindowUnload({ window }) {
    ZotDataSync.removeFromWindow(window);
}

function shutdown() {
    ZotDataSync.removeFromAllWindows();
    Zotero.Notifier.unregisterObserver(ZotDataSync._notifierCallback);
    ZotDataSync = undefined;
}
```

## 主逻辑 (zot-data-sync.js)

核心功能：
- 读取 Zotero.DB（通过 `Zotero.DB.queryAsync()`）
- 转换 item 为 API JSON 格式
- POST 到服务器
- 标记 synced 状态
- 注册 `Zotero.Notifier` 监听 item 变化

### DB 访问

```js
// 异步查询
let items = await Zotero.DB.queryAsync(`
    SELECT i.itemID, i.key, i.version, i.libraryID, i.dateAdded, i.dateModified
    FROM items i
    WHERE i.synced = 0
      AND i.itemTypeID != (SELECT itemTypeID FROM itemTypes WHERE typeName = 'attachment')
`, [libraryID]);

// item 数据字段
let fields = await Zotero.DB.queryAsync(`
    SELECT fd.fieldName, idv.value
    FROM itemData id
    JOIN itemDataValues idv ON id.valueID = idv.valueID
    JOIN fieldsCombined fd ON id.fieldID = fd.fieldID
    WHERE id.itemID = ?
`, [itemID]);
```

### HTTP 请求

```js
// Zotero.HTTP（推荐）
let r = await Zotero.HTTP.request('POST',
    `${serverURL}/users/${userID}/items`,
    {
        headers: {
            'Zotero-API-Version': '3',
            'Authorization': 'Basic ' + btoa(username + ':' + password),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ items: payload }),
    }
);

// 或者全局 fetch（Zotero 7）
let r = await fetch(url, { method: 'POST', headers, body });
```

### Notifier（监听变化）

```js
this._notifierCallback = (event, type, ids) => {
    if (type === 'item' && (event === 'add' || event === 'modify')) {
        // 触发增量同步
    }
};
Zotero.Notifier.registerObserver(this._notifierCallback, ['item'], 'zot-data-sync');
```

### 配置读取

```js
let serverURL = Zotero.Prefs.get('extensions.zot-data-sync.server_url', true);
let username  = Zotero.Prefs.get('extensions.zot-data-sync.username', true);
let password  = Zotero.Prefs.get('extensions.zot-data-sync.password', true);
```

## prefs.js 默认值

```js
pref("extensions.zot-data-sync.server_url", "https://yourserver.com");
pref("extensions.zot-data-sync.username", "admin");
pref("extensions.zot-data-sync.password", "");
pref("extensions.zot-data-sync.sync_attachments", true);
pref("extensions.zot-data-sync.library_filter", "group");
```

## API 端点（与 Python 客户端兼容）

```
GET    /users/{userID}/items?limit=N&format=json
POST   /users/{userID}/items          # 批量创建/更新 items
GET    /users/{userID}/groups?format=json
POST   /groups/{groupID}/items        # 批量创建/更新 items（组）
POST   /items/{itemKey}/file?upload=1 # 附件注册
```

认证：HTTP Basic (`Authorization: Basic base64(username:password)`)

## linkMode 映射（attachment 类型）

Zotero API 要求字符串名称，不是整数：

```js
const LINK_MODE_NAMES = {
    0: "imported_file",
    1: "imported_url",
    2: "linked_file",
    3: "linked_url",
};
```

## 构建

```bash
cd zotero-plugin
zip -r ../build/zot-data.xpi manifest.json bootstrap.js zot-data-sync.js prefs.js locale/
```

安装：在 Zotero → Tools → Add-ons → Gear → Install Add-on From File

## 已知限制

- Zotero 6 使用 `install.rdf` 而非 `manifest.json`
- Zotero 6 中 `Zotero.HTTP.request` 不支持 `body`，需要用 `Zotero.File`
- Zotero 6 中 XUL 元素需要 `doc.createElementNS(XUL_NS, ...)`
