# ZotData Plugin 开发日志

## 2026-04-12

### 问题：Zotero 9 适配

**现象**：插件加载后点 Sync 按钮报错 `Zotero.Libraries.getLibrary is not a function`

**根因**：
- Zotero 9 的 SQLite 数据库文件是 0 字节，不使用标准 SQLite
- `Zotero.DB.queryAsync()` 返回特殊 collection 对象，无法序列化
- 之前基于 SQL 的同步方案完全失效

**修复**：
1. 使用 `Zotero.Search` API 替代 `Zotero.Items.getAll` 和 SQL 查询
   ```javascript
   const s = new Zotero.Search();
   s.libraryID = libraryID;
   s.addCondition('itemType', 'isNot', 'attachment');
   const itemIDs = await s.search();
   ```
2. 使用 `Zotero.Items.get(id)` 获取单个 item 数据
3. 使用 `item.getField(fieldName)` 读取字段值

### 问题：API 字段校验失败

**现象**：批量上传时部分 item 返回 HTTP 400

**错误列表**：
- `'year' is not a valid field` → 移除 `year`（Zotero API 不支持）
- `'archiveID' is not a valid field'` → 移除 `archiveID`
- `'repository' is not a valid field'` → 移除 `repository`
- `creator object must contain 'creatorType'` → 过滤无 `creatorType` 的 creator
- `'title' is not a valid field for type 'note'` → note 类型跳过 title 字段

**修复**：精简 apiFields 列表，只保留 Zotero API 3.0 标准字段

### 最终 apiFields 列表
```javascript
const apiFields = [
    'title', 'firstName', 'lastName', 'abstractNote', 'url',
    'date', 'publishedDate', 'accessDate',
    'publicationTitle', 'journalAbbreviation', 'volume', 'issue',
    'pages', 'DOI', 'isbn', 'issn', 'series', 'seriesTitle',
    'seriesNumber', 'conferenceName', 'documentNumber',
    'university', 'institution', 'school', 'degree',
    'publisher', 'language', 'rights',
    'archive', 'archiveLocation', 'libraryCatalog', 'callNumber',
    'edition', 'place',
    'shortTitle', 'websiteType', 'forumTitle',
    'postType', 'audioRecordingType', 'presentationType',
    'meetingName', 'session', 'chair',
    'code', 'codeVolume', 'sessionType', 'committee',
    'type', 'patentNumber', 'applicationNumber',
    'filingDate', 'issueDate', 'issuingAuthority',
    'country', 'letterType', 'manuscriptType',
    'mapType', 'scale', 'cartographer', 'mapSeries',
];
```

### Note 类型特殊处理
```javascript
if (mappedType === 'note') {
    const noteText = item.getField('note');
    if (noteText) payload.note = noteText;
} else {
    // 只对非 note 类型添加 regular fields
}
```

### 结果
- math 组：5 items → 5 synced, 0 errors ✓
- 插件成功将本地库内容 POST 到自建 Zotero 服务器

### 补充：同步所有 item 类型

**现象**：math 组有 43 项（Zotero MCP 显示），插件只找到 5→3→4 项

**诊断发现**：
- `Zotero.Search` 不带条件返回 8 项（不是 43），搜索只返回 library 根级别的 item
- 其中 3 项 regular items，5 项 annotations
- `isRegularItem()` 过滤掉 annotations、notes、embedded images 等

**修复**：不过滤，同步所有 item，按类型分别处理：

```javascript
// Annotation: parentItem 字段（不是 parentItemID）
if (item.isAnnotation()) {
    return {
        itemType: 'annotation',
        annotationType: item.annotationType,
        annotationText: item.annotationText,
        annotationColor: item.annotationColor,
        annotationPageLabel: item.annotationPageLabel,
        parentItem: parent?.key || '',
        // ...
    };
}

// Attachment: linkMode 必须是字符串
if (item.isImportedAttachment()) {
    const linkModeMap = { 1: 'imported_file', 2: 'imported_url',
                          3: 'linked_file', 4: 'linked_url' };
    payload.linkMode = linkModeMap[item.linkMode] || 'imported_file';
    payload.filename = item.attachmentFilename;
    payload.filesize = item.attachmentSize;
    payload.contentType = item.attachmentContentType;
    payload.md5 = item.attachmentMD5;
}

// Note: 使用 note 字段
if (mappedType === 'note') {
    payload.note = item.getField('note');
}
```

**Zotero API itemType 类型**：
| 类型 | 特殊字段 |
|---|---|
| annotation | annotationType, annotationText, annotationColor, parentItem |
| attachment | linkMode (string), filename, filesize, contentType, md5 |
| note | note |
| regular | standard API fields |
