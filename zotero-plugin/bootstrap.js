/**
 * ZotData Sync plugin for Zotero 7/8/9
 */

var ZotDataSync;
var chromeHandle;

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
    await Promise.all([
        Zotero.initializationPromise,
        Zotero.unlockPromise,
        Zotero.uiReadyPromise,
    ]);

    if (!rootURI) {
        rootURI = resourceURI.spec;
    }

    var aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
        .getService(Components.interfaces.amIAddonManagerStartup);
    var manifestURI = Services.io.newURI(rootURI + "manifest.json");
    chromeHandle = aomStartup.registerChrome(manifestURI, [
        ["content", "zot-data-sync", rootURI + "chrome/content/"],
    ]);

    const ctx = { rootURI };
    ctx._globalThis = ctx;
    Services.scriptloader.loadSubScript(
        rootURI + "chrome/content/scripts/zot-data-sync.js",
        ctx
    );

    ZotDataSync.init({ id, version, rootURI });
    ZotDataSync.registerNotifier();

    // Add UI to all open windows
    await Promise.all(
        Zotero.getMainWindows().map((win) => {
            if (win.ZoteroPane) ZotDataSync.addToWindow(win);
        })
    );
}

async function onMainWindowLoad({ window }, reason) {
    if (ZotDataSync && window.ZoteroPane) {
        ZotDataSync.addToWindow(window);
    }
}

async function onMainWindowUnload({ window }, reason) {
    if (ZotDataSync) {
        ZotDataSync.removeFromWindow(window);
    }
}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
    if (reason === APP_SHUTDOWN) {
        return;
    }
    if (ZotDataSync) {
        ZotDataSync.removeFromAllWindows();
        ZotDataSync.unregisterNotifier();
        ZotDataSync = undefined;
    }
    if (chromeHandle) {
        chromeHandle.destruct();
        chromeHandle = null;
    }
}

function uninstall(data, reason) {}
