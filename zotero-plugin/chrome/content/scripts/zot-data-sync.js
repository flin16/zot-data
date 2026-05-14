// zot-data-sync.js — Main sync logic for Zotero plugin

ZotDataSync = {
    id: null,
    version: null,
    rootURI: null,
    _addedElements: [],
    _notifierCallback: null,

    // ── Preferences ──────────────────────────────────────────────────────────────

    getPref(key, defaultVal) {
        try {
            return Zotero.Prefs.get(key, true) ?? defaultVal;
        }
        catch (e) {
            return defaultVal;
        }
    },

    get serverURL() {
        return this.getPref("extensions.zot-data-sync.server_url", "https://yourserver.com").replace(/\/$/, "");
    },
    get username() {
        return this.getPref("extensions.zot-data-sync.username", "admin");
    },
    get password() {
        return this.getPref("extensions.zot-data-sync.password", "");
    },
    get userID() {
        return this.getPref("extensions.zot-data-sync.user_id", 1);
    },
    get syncAttachments() {
        return this.getPref("extensions.zot-data-sync.sync_attachments", false);
    },
    get libraryFilter() {
        return this.getPref("extensions.zot-data-sync.library_filter", "group");
    },
    get minioEndpoint() {
        return this.getPref("extensions.zot-data-sync.minio_endpoint", "s3.yourserver.com");
    },
    get minioAccessKey() {
        return this.getPref("extensions.zot-data-sync.minio_access_key", "minioadmin");
    },
    get minioSecretKey() {
        return this.getPref("extensions.zot-data-sync.minio_secret_key", "minioadmin");
    },
    get minioBucket() {
        return this.getPref("extensions.zot-data-sync.minio_bucket", "zotero");
    },

    // ── Init ───────────────────────────────────────────────────────────────────

    init({ id, version, rootURI }) {
        this.id = id;
        this.version = version;
        this.rootURI = rootURI;
        Zotero.debug(`[ZotDataSync] v${version} starting — server: ${this.serverURL}`);
    },

    // ── Library enumeration ──────────────────────────────────────────────────

    async getLibraries() {
        try {
            const libs = [];
            for (const lib of Zotero.Libraries.getAll()) {
                const id = lib.libraryID;
                const type = lib.libraryType;
                const isGroup = type === 'group';
                libs.push({
                    libraryID: id,
                    libraryType: isGroup ? 'group' : 'user',
                    name: isGroup ? (lib.name || `Group ${id}`) : 'My Library',
                });
            }
            Zotero.debug(`[ZotDataSync] getLibraries(): ${libs.length} libs`);
            return libs;
        } catch (e) {
            Zotero.debug(`[ZotDataSync] Zotero.Libraries.getAll() failed: ${e}`);
            return [];
        }
    },

    async getServerGroups() {
        // Server returns {id, name} — no need for individual fetches
        const r = await this.httpRequest(
            `${this.serverURL}/users/${this.userID}/groups`,
            { headers: this._apiHeaders() }
        );
        if (r.status !== 200) throw new Error(`Failed to fetch groups: ${r.status}`);
        const data = JSON.parse(r.responseText);
        return (data || []).map(g => ({
            id: g.library ? g.library.id : g.id,
            name: g.name || `Group ${g.id}`,
        }));
    },

    // ── Custom sync state (per library last-sync timestamp) ─────────────────

    _getLastSyncTime(libraryID) {
        const raw = Zotero.Prefs.get(`extensions.zot-data-sync.lastSync.${libraryID}`, true);
        if (raw instanceof Date) return raw.toISOString();
        if (typeof raw === 'string' && raw) return raw;
        return undefined;
    },

    _setLastSyncTime(libraryID, timestamp) {
        Zotero.Prefs.set(`extensions.zot-data-sync.lastSync.${libraryID}`, timestamp, true);
    },

    // ── Item retrieval (incremental by dateModified) ─────────────────────────

    async getItemsInLibrary(libraryID) {
        const s = new Zotero.Search();
        s.libraryID = libraryID;
        const raw = await s.search();
        const allIDs = raw ? Array.from(raw) : [];
        const result = [];
        for (const id of allIDs) {
            const item = Zotero.Items.get(id);
            if (!item) continue;
            result.push({
                itemID: item.id,
                key: item.key,
                version: item.version,
                itemTypeID: item.itemTypeID,
                dateAdded: item.dateAdded,
                dateModified: item.dateModified,
                libraryID: item.libraryID,
            });
        }
        return result;
    },

    // Store synced item keys per library (populated after each sync)
    _getSyncedKeys(libraryID) {
        const key = `extensions.zot-data-sync.syncedKeys.${libraryID}`;
        const raw = Zotero.Prefs.get(key, true);
        Zotero.debug(`[ZotDataSync] _getSyncedKeys(${libraryID}) raw: ${JSON.stringify(raw)}`);
        if (typeof raw === 'string' && raw) {
            try { return new Set(JSON.parse(raw)); } catch(e) {}
        }
        return null;
    },

    _setSyncedKeys(libraryID, keys) {
        const key = `extensions.zot-data-sync.syncedKeys.${libraryID}`;
        const val = JSON.stringify([...keys]);
        Zotero.debug(`[ZotDataSync] _setSyncedKeys(${libraryID}): ${val.slice(0, 200)}`);
        Zotero.Prefs.set(key, val, true);
    },

    async getUnsyncedItems(libraryID) {
        const allItems = await this.getItemsInLibrary(libraryID);
        const syncedKeys = this._getSyncedKeys(libraryID);

        if (syncedKeys) {
            const unsynced = allItems.filter(item => {
                const skip = syncedKeys.has(item.key);
                Zotero.debug(`[ZotDataSync] ${skip ? 'SKIP' : 'SYNC'} ${item.key} (synced=${skip})`);
                return !skip;
            });
            Zotero.debug(`[ZotDataSync] Incremental: ${unsynced.length}/${allItems.length} not yet synced`);
            return unsynced;
        }

        Zotero.debug(`[ZotDataSync] Full sync: no syncedKeys, syncing all ${allItems.length} items`);
        return allItems;
    },

    // ── Item → API JSON ────────────────────────────────────────────────────────

    async buildItemPayload(itemRow) {
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

        const item = Zotero.Items.get(itemRow.itemID);
        if (!item) throw new Error(`Item ${itemRow.itemID} not found`);

        const itemType = Zotero.ItemTypes.getName(item.itemTypeID);
        const tags = item.getTags().map(t => ({ tag: t.tag, type: t.type || 1 }));

        // Annotation payload
        if (item.isAnnotation()) {
            const parent = item.parentID ? Zotero.Items.get(item.parentID) : null;
            return {
                key: itemRow.key,
                version: 0,
                itemType: 'annotation',
                annotationType: item.annotationType || '',
                annotationText: item.annotationText || '',
                annotationColor: item.annotationColor || '',
                annotationPageLabel: item.annotationPageLabel || '',
                parentItem: parent ? parent.key : '',
                tags,
                dateAdded: item.dateAdded,
                dateModified: item.dateModified,
            };
        }

        // Non-regular, non-annotation items
        if (!item.isRegularItem()) {
            const mappedType = itemType === 'preprint' ? 'document' : itemType;
            const payload = {
                key: itemRow.key,
                version: 0,
                itemType: mappedType,
                tags,
                dateAdded: item.dateAdded,
                dateModified: item.dateModified,
            };

            // Attachment: linkMode must be string
            if (item.isImportedAttachment()) {
                const lm = item.linkMode;
                const linkModeMap = { 1: 'imported_file', 2: 'imported_url', 3: 'linked_file', 4: 'linked_url' };
                payload.linkMode = (typeof lm === 'string') ? lm : (linkModeMap[lm] || 'imported_file');
                if (item.attachmentFilename) payload.filename = item.attachmentFilename;
                if (item.attachmentSize) payload.filesize = item.attachmentSize;
                if (item.attachmentContentType) payload.contentType = item.attachmentContentType;
                if (item.attachmentMD5) payload.md5 = item.attachmentMD5;
            }

            // Note: include note text
            if (mappedType === 'note') {
                const noteText = item.getField('note');
                if (noteText) payload.note = noteText;
            }

            return payload;
        }

        // Regular item
        const creators = item.getCreators().filter(c => c.creatorType).map(c => {
            if (c.fieldMode === 1) {
                return { creatorType: c.creatorType, lastName: c.lastName };
            }
            return { creatorType: c.creatorType, firstName: c.firstName || "", lastName: c.lastName || "" };
        });

        const mappedType = itemType === 'preprint' ? 'document' : itemType;
        const payload = {
            key: itemRow.key,
            version: 0,
            itemType: mappedType,
            creators,
            tags,
            collections: item.getCollections(),
            relations: {},
            dateAdded: item.dateAdded,
            dateModified: item.dateModified,
        };

        for (const field of apiFields) {
            try {
                const val = item.getField(field);
                if (val) payload[field] = val;
            } catch (e) { /* skip inapplicable fields */ }
        }

        return payload;
    },

    // ── HTTP helpers ──────────────────────────────────────────────────────────

    _apiHeaders(extra = {}) {
        const auth = btoa(this.username + ":" + this.password);
        return {
            "Zotero-API-Version": "3",
            "Authorization": `Basic ${auth}`,
            "Content-Type": "application/json",
            ...extra,
        };
    },

    httpRequest(url, options = {}) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open(options.method || "GET", url, true);
            for (const [k, v] of Object.entries(options.headers || {})) {
                xhr.setRequestHeader(k, v);
            }
            xhr.onload = () => resolve(xhr);
            xhr.onerror = () => reject(new Error("Network error"));
            xhr.send(options.body || null);
        });
    },

    async apiGet(path) {
        return this.httpRequest(`${this.serverURL}${path}`, {
            headers: this._apiHeaders(),
        });
    },

    async apiPost(path, body) {
        return this.httpRequest(`${this.serverURL}${path}`, {
            method: "POST",
            headers: this._apiHeaders(),
            body: JSON.stringify(body),
        });
    },

    // ── AWS S3 / MinIO helpers (Signature V4) ────────────────────────────────

    async _sha256(data) {
        return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    },

    async _hmacSha256(key, data) {
        const cryptoKey = await crypto.subtle.importKey(
            'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
        );
        return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, data));
    },

    async _s3Sign(method, path, md5Hex, contentType) {
        const endpoint = this.minioEndpoint;
        const bucket = this.minioBucket;
        const accessKey = this.minioAccessKey;
        const secretKey = this.minioSecretKey;
        const now = new Date();
        const dateStr = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
        const dateShort = dateStr.slice(0, 8);
        const region = 'us-east-1';
        const host = endpoint;
        const service = 's3';
        const algorithm = 'AWS4-HMAC-SHA256';
        const credentialScope = `${dateShort}/${region}/${service}/aws4_request`;
        const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
        const canonicalHeaders = [
            `content-type:${contentType}`,
            `host:${host}`,
            `x-amz-content-sha256:${md5Hex}`,
            `x-amz-date:${dateStr}`,
        ].join('\n') + '\n';

        const canonicalRequest = [
            method, path, '', canonicalHeaders, signedHeaders, md5Hex,
        ].join('\n');

        const hashedReq = Array.from(
            new Uint8Array(await this._sha256(new TextEncoder().encode(canonicalRequest)))
        ).map(b => b.toString(16).padStart(2, '0')).join('');

        const stringToSign = [algorithm, dateStr, credentialScope, hashedReq].join('\n');

        const signingKey = await this._hmacSha256(
            await this._hmacSha256(
                await this._hmacSha256(
                    await this._hmacSha256(
                        new TextEncoder().encode('AWS4' + secretKey), dateShort),
                    region),
                service),
            'aws4_request');

        const signature = Array.from(
            await this._hmacSha256(signingKey, new TextEncoder().encode(stringToSign))
        ).map(b => b.toString(16).padStart(2, '0')).join('');

        return {
            date: dateStr,
            auth: `${algorithm} Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        };
    },

    async _minioHead(md5) {
        const path = `/${this.minioBucket}/${md5}`;
        const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
        const { date, auth } = await this._s3Sign('HEAD', path, emptyHash, '');
        const url = `https://${this.minioEndpoint}${path}`;
        try {
            const r = await this.httpRequest(url, {
                method: 'HEAD',
                headers: {
                    'x-amz-date': date,
                    'Authorization': auth,
                },
            });
            return r.status === 200;
        } catch (e) {
            return false;
        }
    },

    async _minioPut(fileBytes, md5, contentType) {
        const path = `/${this.minioBucket}/${md5}`;
        const url = `https://${this.minioEndpoint}${path}`;
        const { date, auth } = await this._s3Sign('PUT', path, md5, contentType);
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('PUT', url, true);
            xhr.setRequestHeader('Content-Type', contentType);
            xhr.setRequestHeader('x-amz-date', date);
            xhr.setRequestHeader('x-amz-content-sha256', md5);
            xhr.setRequestHeader('Authorization', auth);
            xhr.onload = () => {
                if (xhr.status === 200) {
                    resolve(true);
                } else {
                    reject(new Error(`MinIO PUT failed: ${xhr.status}`));
                }
            };
            xhr.onerror = () => reject(new Error('MinIO network error'));
            xhr.send(new Uint8Array(fileBytes));
        });
    },

    async _getAttachmentFile(item) {
        if (!item.isImportedAttachment()) return null;
        try {
            const path = item.getFilePath();
            if (!path) return null;
            const file = await OS.File.read(path, { binary: true });
            return { path, data: file };
        } catch (e) {
            Zotero.debug(`[ZotDataSync] Could not read attachment: ${e}`);
            return null;
        }
    },

    // ── Core sync ─────────────────────────────────────────────────────────────

    async doSync() {
        const start = Date.now();
        Zotero.debug("[ZotDataSync] Starting sync...");

        try {
            // Resolve server group IDs: local libraryID = server group id (empirical)
            const serverGroups = await this.getServerGroups();
            const groupMapByID = new Map(serverGroups.map(g => [g.id, g.name]));

            const libs = await this.getLibraries();
            let totalSynced = 0, totalErrors = 0;

            for (const lib of libs) {
                if (this.libraryFilter === "group" && lib.libraryType !== "group") continue;
                if (this.libraryFilter === "user" && lib.libraryType !== "user") continue;

                // For groups: local libraryID = server group id
                const serverID = lib.libraryType === "user"
                    ? this.userID
                    : lib.libraryID;

                if (lib.libraryType === "group" && !groupMapByID.has(serverID)) {
                    Zotero.debug(`[ZotDataSync] Group '${lib.name}' (id=${lib.libraryID}) not on server, skipping`);
                    continue;
                }

                Zotero.debug(`[ZotDataSync] Syncing [${lib.libraryType}] ${lib.name} → server ID ${serverID}`);
                const { synced, errors } = await this._syncItems(lib, serverID);
                totalSynced += synced;
                totalErrors += errors;
            }

            const ms = Date.now() - start;
            Zotero.debug(`[ZotDataSync] Done: ${totalSynced} synced, ${totalErrors} errors in ${ms}ms`);
            this.showStatus(
                totalErrors === 0
                    ? `Sync complete: ${totalSynced} items uploaded`
                    : `Sync done: ${totalSynced} uploaded, ${totalErrors} errors`
            );
        }
        catch (e) {
            Zotero.debug(`[ZotDataSync] Sync error: ${e}\n${e.stack}`);
            this.showStatus(`Sync failed: ${e.message}`);
        }
    },

    async _syncItems(lib, serverLibraryID) {
        const items = await this.getUnsyncedItems(lib.libraryID);
        if (!items.length) {
            return { synced: 0, errors: 0 };
        }

        // Build payloads
        const payloads = [];
        for (const item of items) {
            try {
                payloads.push(await this.buildItemPayload(item));
            } catch (e) {
                Zotero.debug(`[ZotDataSync] buildItemPayload ${item.key} failed: ${e}`);
            }
        }

        const path = lib.libraryType === "user"
            ? `/users/${serverLibraryID}/items`
            : `/groups/${serverLibraryID}/items`;

        let successKeys = new Set();
        let errors = 0;

        // Batch upload (50 per batch)
        for (let i = 0; i < payloads.length; i += 50) {
            const chunk = payloads.slice(i, i + 50);
            const chunkItems = items.slice(i, i + 50);
            const r = await this.apiPost(path, chunk);

            if (r.status !== 200 && r.status !== 201) {
                Zotero.debug(`[ZotDataSync] Upload failed: ${r.status} ${r.responseText}`);
                errors += chunk.length;
                continue;
            }

            let data;
            try { data = JSON.parse(r.responseText); }
            catch (e) { errors += chunk.length; continue; }

            for (const [, val] of Object.entries(data.successful || {})) {
                if (val?.key) successKeys.add(val.key);
            }
            for (const [, val] of Object.entries(data.success || {})) {
                if (val?.key) successKeys.add(val.key);
            }
            for (const [, val] of Object.entries(data.unchanged || {})) {
                if (val?.key) successKeys.add(val.key);
            }
            for (const [idx, val] of Object.entries(data.failed || {})) {
                if (val?.code === 412 && chunk[parseInt(idx)]?.key) {
                    successKeys.add(chunk[parseInt(idx)].key);
                }
                if (!successKeys.has(chunk[parseInt(idx)]?.key)) {
                    Zotero.debug(`[ZotDataSync] Item ${chunk[parseInt(idx)]?.key} failed: ${val?.code} ${val?.message}`);
                    errors++;
                }
            }
        }

        // Upload attachment files to MinIO
        let uploadedFiles = 0;
        if (this.syncAttachments) {
            for (const item of items) {
                if (!successKeys.has(item.key)) continue;
                const zItem = Zotero.Items.get(item.itemID);
                if (!zItem || !zItem.isImportedAttachment()) continue;
                const lm = zItem.linkMode;
                if (lm !== 1 && lm !== 'imported_file') continue;

                const md5 = zItem.attachmentMD5;
                if (!md5) continue;

                try {
                    const exists = await this._minioHead(md5);
                    if (exists) {
                        Zotero.debug(`[ZotDataSync] File ${md5} already in MinIO`);
                    } else {
                        const fileInfo = await this._getAttachmentFile(zItem);
                        if (!fileInfo) continue;
                        const ct = zItem.attachmentContentType || 'application/octet-stream';
                        await this._minioPut(fileInfo.data, md5, ct);
                        Zotero.debug(`[ZotDataSync] Uploaded ${md5} to MinIO`);
                    }
                    uploadedFiles++;
                } catch (e) {
                    Zotero.debug(`[ZotDataSync] MinIO error for ${item.key}: ${e}`);
                }
            }
        }

        Zotero.debug(`[ZotDataSync] Uploaded ${uploadedFiles} attachment files`);
        // Store synced keys for incremental sync
        this._setSyncedKeys(lib.libraryID, successKeys);
        return { synced: successKeys.size, errors };
    },

    // ── UI ───────────────────────────────────────────────────────────────────

    addToWindow(window) {
        const doc = window.document;

        // Toolbar button
        const toolbar = doc.querySelector("#zotero-items-toolbar");
        if (toolbar) {
            const lookupNode = toolbar.querySelector("#zotero-tb-lookup");
            const searchNode = toolbar.querySelector("#zotero-tb-search");
            if (lookupNode) {
                const btn = doc.createXULElement("toolbarbutton");
                btn.id = "zot-data-sync-toolbar-btn";
                btn.setAttribute("class", lookupNode.getAttribute("class") || "toolbar-button");
                btn.setAttribute("tooltiptext", "ZotData Sync");
                btn.setAttribute("type", "button");
                btn.style.listStyleImage = "url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAL0lEQVR4nGNgGFQgoOfDf2IwRYZQ5BKKvEOSZqqBLSc+/AfhkWQAxQlp4A0YEAAAO/i9V17Ro+QAAAAASUVORK5CYII=)";
                btn.addEventListener("command", () => this.doSync());
                if (searchNode) toolbar.insertBefore(btn, searchNode);
                else toolbar.appendChild(btn);
                this._addedElements.push(btn.id);
            }
        }

        // Menu item
        const mi = doc.createXULElement("menuitem");
        mi.id = "zot-data-sync-menuitem";
        mi.setAttribute("label", "Sync to Custom Server");
        mi.setAttribute("accesskey", "S");
        mi.addEventListener("command", () => this.doSync());
        doc.getElementById("menu_ToolsPopup").appendChild(mi);
        this._addedElements.push(mi.id);
    },

    removeFromWindow(window) {
        const doc = window.document;
        for (const id of this._addedElements) {
            doc.getElementById(id)?.remove();
        }
        this._addedElements = [];
    },

    addToAllWindows() {
        for (const win of Zotero.getMainWindows()) {
            if (win.ZoteroPane) this.addToWindow(win);
        }
    },

    removeFromAllWindows() {
        for (const win of Zotero.getMainWindows()) {
            if (win.ZoteroPane) this.removeFromWindow(win);
        }
    },

    // ── Notifier ───────────────────────────────────────────────────────────────

    registerNotifier() {
        this._notifierCallback = (event, type, ids) => {
            if (type === "item" && (event === "add" || event === "modify")) {
                Zotero.debug(`[ZotDataSync] Item ${event}: ${ids.length} item(s)`);
            }
        };
        Zotero.Notifier.registerObserver(this._notifierCallback, ["item"], "zot-data-sync");
    },

    unregisterNotifier() {
        if (this._notifierCallback) {
            Zotero.Notifier.unregisterObserver(this._notifierCallback);
            this._notifierCallback = null;
        }
    },

    // ── Status notification ───────────────────────────────────────────────────

    showStatus(message) {
        const win = Zotero.getMainWindows()[0];
        if (!win) return;
        win.alert(`ZotData Sync:\n${message}`);
    },
};
