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

    // ── DB helpers (using Zotero JS API) ─────────────────────────────────────

    async getItemsInLibrary(libraryID) {
        // Use Zotero.Search API for Zotero 9 compatibility
        try {
            const s = new Zotero.Search();
            s.libraryID = libraryID;
            s.addCondition('itemType', 'isNot', 'attachment');
            const itemIDs = await s.search();
            Zotero.debug(`[ZotDataSync] Search returned ${itemIDs.length} item IDs for library ${libraryID}`);
            const result = [];
            for (const id of itemIDs) {
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
        } catch (e) {
            Zotero.debug(`[ZotDataSync] getItemsInLibrary(${libraryID}) failed: ${e}`);
            return [];
        }
    },


    async getLibraries() {
        // Use Zotero API to enumerate all libraries
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
            Zotero.debug(`[ZotDataSync] getLibraries() via Zotero API: ${libs.length} libs`);
            return libs;
        } catch (e) {
            Zotero.debug(`[ZotDataSync] Zotero.Libraries.getAll() failed: ${e}`);
            return [];
        }
    },

    async getServerGroups() {
        // Get groups from the API using the user's groups list
        Zotero.debug(`[ZotDataSync] Fetching groups from ${this.serverURL}/users/${this.userID}/groups`);
        const r = await this.httpRequest(
            `${this.serverURL}/users/${this.userID}/groups`,
            { headers: this._apiHeaders() }
        );
        Zotero.debug(`[ZotDataSync] Groups response status: ${r.status}`);
        if (r.status !== 200) throw new Error(`Failed to fetch groups: ${r.status}`);
        const data = JSON.parse(r.responseText);
        Zotero.debug(`[ZotDataSync] Groups raw response: ${r.responseText.substring(0, 500)}`);

        // Fetch each group's name individually
        const groups = [];
        for (const g of (data || [])) {
            const groupId = g.library ? g.library.id : g.id;
            try {
                const gr = await this.httpRequest(
                    `${this.serverURL}/groups/${groupId}`,
                    { headers: this._apiHeaders() }
                );
                if (gr.status === 200) {
                    const gd = JSON.parse(gr.responseText);
                    groups.push({ id: groupId, name: gd.name || `Group ${groupId}` });
                }
            } catch (e) {
                Zotero.debug(`[ZotDataSync] Failed to fetch group ${groupId}: ${e}`);
                groups.push({ id: groupId, name: `Group ${groupId}` });
            }
        }
        return groups;
    },

    // ── Custom sync state (per library last-sync timestamp) ─────────────────

    _getLastSyncTime(libraryID) {
        const key = `extensions.zot-data-sync.lastSync.${libraryID}`;
        return this.getPref(key, null);  // ISO timestamp string or null
    },

    _setLastSyncTime(libraryID, timestamp) {
        const key = `extensions.zot-data-sync.lastSync.${libraryID}`;
        Zotero.Prefs.set(key, timestamp, true);
    },

    async getUnsyncedItems(libraryID) {
        // Use Zotero JS API for Zotero 9 compatibility
        const items = await this.getItemsInLibrary(libraryID);
        Zotero.debug(`[ZotDataSync] Found ${items.length} items in library ${libraryID}`);
        return items;
    },

    // ── Item → API JSON ────────────────────────────────────────────────────────

    async buildItemPayload(itemRow) {
        // Use Zotero Item API instead of raw SQL
        const item = Zotero.Items.get(itemRow.itemID);
        if (!item) {
            throw new Error(`Item ${itemRow.itemID} not found`);
        }

        const itemType = Zotero.ItemTypes.getName(item.itemTypeID);
        const creators = item.getCreators();
        const tags = item.getTags().map(t => ({ tag: t.tag, type: t.type || 1 }));
        const collections = item.getCollections();

        // Get all fields using getField(fieldName)
        // These are the standard Zotero API field names
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

        // Map non-standard item types
        const itemTypeMapExtra = { preprint: "document" };
        const mappedType = itemTypeMapExtra[itemType] || itemType;

        // Map creators: fieldMode 1 = single field (lastName only)
        // Skip creators without creatorType
        const mappedCreators = creators
            .filter(c => c.creatorType)
            .map(c => {
                if (c.fieldMode === 1) {
                    return { creatorType: c.creatorType, lastName: c.lastName };
                }
                return { creatorType: c.creatorType, firstName: c.firstName || "", lastName: c.lastName || "" };
            });

        // Build payload, excluding type-inapplicable fields
        const payload = {
            key: itemRow.key,
            version: 0,
            itemType: mappedType,
            creators: mappedCreators,
            tags,
            collections,
            relations: {},
            dateAdded: item.dateAdded,
            dateModified: item.dateModified,
        };

        // Only add note content for notes
        if (mappedType === 'note') {
            const noteText = item.getField('note');
            if (noteText) payload.note = noteText;
        } else {
            // Add regular fields, skipping inapplicable ones
            for (const field of apiFields) {
                try {
                    const val = item.getField(field);
                    if (val) payload[field] = val;
                } catch (e) {
                    // Field not applicable for this item type, skip
                }
            }
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
        const libs = await this.getLibraries();
        for (const lib of libs) {
            if (this.libraryFilter === "group" && lib.libraryType !== "group") continue;
            if (this.libraryFilter === "user" && lib.libraryType !== "user") continue;
            const path = lib.libraryType === "user"
                ? `/users/${this.userID}`
                : `/groups/${lib.libraryID}`;
            try {
                const r = await this.apiGet(path + "?format=json");
                Zotero.debug(`[ZotDataSync] Ping ${path}: ${r.status}`);
            }
            catch (e) {
                Zotero.debug(`[ZotDataSync] ping failed for ${path}: ${e}`);
            }
        }
    },

    async doSync() {
        const start = Date.now();
        Zotero.debug("[ZotDataSync] Starting sync...");
        Zotero.debug(`[ZotDataSync] Server: ${this.serverURL}, UserID: ${this.userID}, Filter: ${this.libraryFilter}`);

        try {
            // Always hit the server to log the sync attempt
            await this._pingServer();
            Zotero.debug("[ZotDataSync] Ping done");

            // Resolve server group IDs
            const serverGroups = await this.getServerGroups();
            Zotero.debug(`[ZotDataSync] Server groups: ${JSON.stringify(serverGroups)}`);
            // Map by server ID AND by name (for fallback)
            const groupMapByID = new Map(serverGroups.map(g => [g.id, g.name]));
            const groupMapByName = new Map(serverGroups.map(g => [g.name, g.id]));

            const libs = await this.getLibraries();
            Zotero.debug(`[ZotDataSync] Local libs: ${libs.map(l => l.name + '(' + l.libraryType + ', id=' + l.libraryID + ')').join(', ')}`);
            let totalSynced = 0;
            let totalErrors = 0;

            for (const lib of libs) {
                if (this.libraryFilter === "group" && lib.libraryType !== "group") continue;
                if (this.libraryFilter === "user" && lib.libraryType !== "user") continue;

                let serverID;
                if (lib.libraryType === "user") {
                    serverID = this.userID;
                } else {
                    // Try by ID first (Zotero: local libraryID = server group id)
                    serverID = groupMapByID.has(lib.libraryID) ? lib.libraryID : groupMapByName.get(lib.name);
                }

                if (!serverID) {
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

            for (const item of chunkItems) {
                if (!successKeys.has(item.key)) {
                    const err = data.failed?.[String(chunkItems.indexOf(item))];
                    Zotero.debug(`[ZotDataSync] Item ${item.key} failed: ${err?.code} ${err?.message}`);
                    errors++;
                }
            }
        }

        // Update our own sync timestamp after upload attempt
        const now = new Date().toISOString();
        this._setLastSyncTime(lib.libraryID, now);
        Zotero.debug(`[ZotDataSync] Updated last sync time to ${now}`);

        return { synced: successKeys.size, errors };
    },

    // ── UI: Toolbar Button & Menu ─────────────────────────────────────────────

    addToWindow(window) {
        const doc = window.document;

        // Toolbar button: clone the lookup button and insert before search
        const toolbar = doc.querySelector("#zotero-items-toolbar");
        if (toolbar) {
            const lookupNode = toolbar.querySelector("#zotero-tb-lookup");
            const searchNode = toolbar.querySelector("#zotero-tb-search");
            if (lookupNode) {
                // cloneNode(false) = shallow clone, no event listeners
                const btn = doc.createXULElement("toolbarbutton");
                btn.id = "zot-data-sync-toolbar-btn";
                btn.setAttribute("class", lookupNode.getAttribute("class") || "toolbar-button");
                btn.setAttribute("tooltiptext", "ZotData Sync");
                btn.setAttribute("type", "button");
                // Use data URI PNG for reliable XUL rendering
                btn.style.listStyleImage = "url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAL0lEQVR4nGNgGFQgoOfDf2IwRYZQ5BKKvEOSZqqBLSc+/AfhkWQAxQlp4A0YEAAAO/i9V17Ro+QAAAAASUVORK5CYII=)";
                btn.addEventListener("command", () => this.doSync());
                if (searchNode) {
                    toolbar.insertBefore(btn, searchNode);
                } else {
                    toolbar.appendChild(btn);
                }
                this._addedElements.push(btn.id);
            }
        }

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
