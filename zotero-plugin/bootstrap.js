// bootstrap.js — ZotData Sync plugin for Zotero 7

var ZotDataSync;

async function startup({ id, version, rootURI }) {
    await Zotero.initializationPromise;

    // Load main logic
    Services.scriptloader.loadSubScript(rootURI + "zot-data-sync.js", this);

    ZotDataSync.init({ id, version, rootURI });
    ZotDataSync.addToAllWindows();
    ZotDataSync.registerNotifier();
}

function onMainWindowLoad({ window }) {
    ZotDataSync?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
    ZotDataSync?.removeFromWindow(window);
}

function shutdown() {
    if (ZotDataSync) {
        ZotDataSync.removeFromAllWindows();
        ZotDataSync.unregisterNotifier();
        ZotDataSync = undefined;
    }
}
