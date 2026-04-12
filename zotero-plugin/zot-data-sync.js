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
        return this.getPref("extensions.zot-data-sync.server_url", "https://zot.0und.com").replace(/\/$/, "");
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

    // ── Init ───────────────────────────────────────────────────────────────────

    init({ id, version, rootURI }) {
        this.id = id;
        this.version = version;
        this.rootURI = rootURI;
        Zotero.debug(`[ZotDataSync] v${version} starting — server: ${this.serverURL}`);
    },

    // ── DB helpers ─────────────────────────────────────────────────────────────

    async dbQuery(sql, params = []) {
        return Zotero.DB.queryAsync(sql, params);
    },

    async dbExecute(sql, params = []) {
        return Zotero.DB.queryAsync(sql, params);
    },

    async getLibraries() {
        // Returns all libraries (user + groups) with their local and server IDs
        const rows = await this.dbQuery(`
            SELECT l.libraryID, l.type AS libraryType, l.editable, l.filesEditable,
                   g.name, g.libraryID AS serverGroupID
            FROM libraries l
            LEFT JOIN \`groups\` g ON l.libraryID = g.libraryID
        `);
        return rows.map(r => ({
            libraryID: r.libraryID,
            libraryType: r.libraryType,  // 'user' or 'group'
            name: r.libraryType === 'user' ? 'My Library' : (r.name || `Group ${r.libraryID}`),
            editable: r.editable,
            filesEditable: r.filesEditable,
            serverGroupID: r.serverGroupID,
        }));
    },

    async getServerGroups() {
        // Get groups from the API using the user's groups list
        const r = await this.httpRequest(
            `${this.serverURL}/users/${this.userID}/groups`,
            { headers: this._apiHeaders() }
        );
        if (r.status !== 200) throw new Error(`Failed to fetch groups: ${r.status}`);
        const data = JSON.parse(r.responseText);
        return (data || []).map(g => ({
            id: g.library.id,
            name: g.library.name,
        }));
    },

    async getUnsyncedItems(libraryID) {
        const rows = await this.dbQuery(`
            SELECT i.itemID, i.key, i.version, i.itemTypeID,
                   i.dateAdded, i.dateModified, i.libraryID
            FROM items i
            WHERE i.libraryID = ?
              AND i.synced = 0
              AND i.itemTypeID != (SELECT itemTypeID FROM itemTypes WHERE typeName = 'attachment')
            ORDER BY i.dateModified
        `, [libraryID]);
        return rows;
    },

    async getItemData(itemID) {
        const rows = await this.dbQuery(`
            SELECT fd.fieldName, idv.value
            FROM itemData id
            JOIN itemDataValues idv ON id.valueID = idv.valueID
            JOIN fieldsCombined fd ON id.fieldID = fd.fieldID
            WHERE id.itemID = ?
        `, [itemID]);
        const data = {};
        for (const row of rows) {
            data[row.fieldName] = row.value;
        }
        return data;
    },

    async getItemCreators(itemID) {
        const rows = await this.dbQuery(`
            SELECT c.firstName, c.lastName, c.fieldMode, ct.creatorType
            FROM itemCreators ic
            JOIN creators c ON ic.creatorID = c.creatorID
            JOIN creatorTypes ct ON ic.creatorTypeID = ct.creatorTypeID
            WHERE ic.itemID = ?
            ORDER BY ic.orderIndex
        `, [itemID]);
        return rows.map(r => ({
            creatorType: r.creatorType,
            firstName: r.firstName || "",
            lastName: r.lastName || "",
        }));
    },

    async getItemTags(itemID) {
        const rows = await this.dbQuery(`
            SELECT t.name, it.type
            FROM itemTags it
            JOIN tags t ON it.tagID = t.tagID
            WHERE it.itemID = ?
        `, [itemID]);
        return rows.map(r => ({ tag: r.name, type: r.type || 1 }));
    },

    async getItemCollections(itemID) {
        const rows = await this.dbQuery(`
            SELECT c.\`key\` FROM collectionItems ci
            JOIN collections c ON ci.collectionID = c.collectionID
            WHERE ci.itemID = ?
        `, [itemID]);
        return rows.map(r => r.key);
    },

    async getItemTypeName(itemTypeID) {
        const rows = await this.dbQuery(
            "SELECT typeName FROM itemTypes WHERE itemTypeID = ?",
            [itemTypeID]
        );
        return rows.length > 0 ? rows[0].typeName : "journalArticle";
    },

    // ── Item → API JSON ────────────────────────────────────────────────────────

    async buildItemPayload(itemRow) {
        const itemType = await this.getItemTypeName(itemRow.itemTypeID);
        const data = await this.getItemData(itemRow.itemID);
        const creators = await this.getItemCreators(itemRow.itemID);
        const tags = await this.getItemTags(itemRow.itemID);
        const collections = await this.getItemCollections(itemRow.itemID);

        // Strip non-API fields
        const nonApiFields = new Set(["repository", "citationKey", "archiveID", "accessDate"]);
        for (const f of nonApiFields) {
            delete data[f];
        }

        // Map non-standard item types
        const itemTypeMapExtra = { preprint: "document" };
        const mappedType = itemTypeMapExtra[itemType] || itemType;

        // Map creator fieldMode: 1 = single field (lastName only), 0 = two fields
        const mappedCreators = creators.map(c => {
            if (c.fieldMode === 1) {
                return { creatorType: c.creatorType, lastName: c.lastName };
            }
            return { creatorType: c.creatorType, firstName: c.firstName, lastName: c.lastName };
        });

        return {
            key: itemRow.key,
            version: 0,
            itemType: mappedType,
            creators: mappedCreators,
            tags,
            collections,
            relations: {},
            dateAdded: itemRow.dateAdded,
            dateModified: itemRow.dateModified,
            ...data,
        };
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
            const headers = options.headers || {};
            for (const [k, v] of Object.entries(headers)) {
                xhr.setRequestHeader(k, v);
            }
            xhr.onload = () => resolve(xhr);
            xhr.onerror = () => reject(new Error("Network error"));
            xhr.send(options.body || null);
        });
    },

    async apiGet(path) {
        const r = await this.httpRequest(`${this.serverURL}${path}`, {
            headers: this._apiHeaders(),
        });
        return r;
    },

    async apiPost(path, body) {
        const r = await this.httpRequest(`${this.serverURL}${path}`, {
            method: "POST",
            headers: this._apiHeaders(),
            body: JSON.stringify(body),
        });
        return r;
    },

    async _pingServer() {
        // GET each library version so the sync attempt is logged server-side
        for (const lib of await this.getLibraries()) {
            if (this.libraryFilter === "group" && lib.libraryType !== "group") continue;
            if (this.libraryFilter === "user" && lib.libraryType !== "user") continue;
            const path = lib.libraryType === "user"
                ? `/users/${this.userID}`
                : `/groups/${lib.serverGroupID}`;
            try {
                await this.apiGet(path + "?format=json");
            }
            catch (e) {
                Zotero.debug(`[ZotDataSync] ping failed for ${path}: ${e}`);
            }
        }
    },

    async doSync() {
        const start = Date.now();
        Zotero.debug("[ZotDataSync] Starting sync...");

        // Always hit the server to log the sync attempt
        await this._pingServer();

        try {
            // Resolve server group IDs
            const serverGroups = await this.getServerGroups();
            const groupMap = new Map(serverGroups.map(g => [g.name, g.id]));

            const libs = await this.getLibraries();
            let totalSynced = 0;
            let totalErrors = 0;

            for (const lib of libs) {
                if (this.libraryFilter === "group" && lib.libraryType !== "group") continue;
                if (this.libraryFilter === "user" && lib.libraryType !== "user") continue;

                const serverID = lib.libraryType === "user"
                    ? this.userID
                    : groupMap.get(lib.name);

                if (!serverID) {
                    Zotero.debug(`[ZotDataSync] Group '${lib.name}' not on server, skipping`);
                    continue;
                }

                Zotero.debug(`[ZotDataSync] Syncing [${lib.libraryType}] ${lib.name} → server ID ${serverID}`);

                const { synced, errors } = await this._syncItems(lib, serverID);
                totalSynced += synced;
                totalErrors += errors;
            }

            const ms = Date.now() - start;
            Zotero.debug(`[ZotDataSync] Done: ${totalSynced} synced, ${totalErrors} errors in ${ms}ms`);

            // Show notification
            this.showStatus(
                totalErrors === 0
                    ? `Sync complete: ${totalSynced} items uploaded`
                    : `Sync done: ${totalSynced} uploaded, ${totalErrors} errors`
            );
        }
        catch (e) {
            Zotero.debug(`[ZotDataSync] Sync error: ${e}`);
            this.showStatus(`Sync failed: ${e.message}`);
        }
    },

    async _syncItems(lib, serverLibraryID) {
        const items = await this.getUnsyncedItems(lib.libraryID);
        if (!items.length) {
            Zotero.debug(`[ZotDataSync] No unsynced items for library ${lib.libraryID}`);
            return { synced: 0, errors: 0 };
        }

        Zotero.debug(`[ZotDataSync] Building ${items.length} item payloads...`);
        const payloads = [];
        for (const item of items) {
            try {
                payloads.push(await this.buildItemPayload(item));
            }
            catch (e) {
                Zotero.debug(`[ZotDataSync] Error building item ${item.key}: ${e}`);
            }
        }

        const path = lib.libraryType === "user"
            ? `/users/${serverLibraryID}/items`
            : `/groups/${serverLibraryID}/items`;

        let successKeys = new Set();
        let errors = 0;

        // Upload in batches of 50
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
            try {
                data = JSON.parse(r.responseText);
            }
            catch (e) {
                Zotero.debug(`[ZotDataSync] Non-JSON response: ${r.responseText}`);
                errors += chunk.length;
                continue;
            }

            // Collect successful keys
            for (const [, val] of Object.entries(data.successful || {})) {
                if (val?.key) successKeys.add(val.key);
            }
            for (const [key, val] of Object.entries(data.success || {})) {
                if (val?.key) successKeys.add(val.key);
            }
            for (const [key, val] of Object.entries(data.unchanged || {})) {
                if (val?.key) successKeys.add(val.key);
            }
            // 412 = already exists on server → treat as synced
            for (const [idx, val] of Object.entries(data.failed || {})) {
                if (val?.code === 412 && chunk[parseInt(idx)]?.key) {
                    successKeys.add(chunk[parseInt(idx)].key);
                }
            }

            // Mark synced locally
            for (const item of chunkItems) {
                if (successKeys.has(item.key)) {
                    await this.dbExecute(
                        "UPDATE items SET synced = 1 WHERE itemID = ?",
                        [item.itemID]
                    );
                }
                else {
                    const err = data.failed?.[String(chunkItems.indexOf(item))];
                    Zotero.debug(`[ZotDataSync] Item ${item.key} failed: ${err?.code} ${err?.message}`);
                    errors++;
                }
            }
        }

        return { synced: successKeys.size, errors };
    },

    // ── UI: Menu & Status ─────────────────────────────────────────────────────

    addToWindow(window) {
        const doc = window.document;

        // Menu item under Tools
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
        const windows = Zotero.getMainWindows();
        if (!windows.length) return;
        const win = windows[0];
        if (win.Zotero?.Pane?.itemTree?.view) {
            // Use Zotero's progress window if available
            try {
                const pw = new win.Zotero.ProgressWindow({ closeOnClick: true });
                pw.changeHeadline("ZotData Sync");
                pw.addLines([message]);
                pw.show();
            }
            catch (e) {
                win.alert(`ZotData Sync:\n${message}`);
            }
        }
        else {
            win.alert(`ZotData Sync:\n${message}`);
        }
    },
};
