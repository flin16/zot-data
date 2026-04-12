#!/usr/bin/env python3
"""
Zotero Sync Client - Minimal sync between local SQLite and self-hosted Zotero server.
Usage: python3 zotero_sync.py [--config config.json]
"""

import sqlite3
import json
import os
import sys
import hashlib
import logging
import io
import platform
from datetime import datetime, timezone
from pathlib import Path

import requests
from minio import Minio

# ─── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("zotero_sync")


# ─── Config ─────────────────────────────────────────────────────────────────


def _default_local_db() -> str:
    """Return platform-appropriate Zotero database path, checking common locations."""
    home = Path.home()
    candidates = []
    if platform.system() == "Darwin":
        candidates = [
            home / "Zotero" / "zotero.sqlite",
            home / "Library" / "Application Support" / "Zotero" / "zotero.sqlite",
        ]
    elif platform.system() == "Windows":
        candidates = [
            Path(os.environ.get("APPDATA", "")) / "Zotero" / "Zotero" / "zotero.sqlite",
            home / "Zotero" / "zotero.sqlite",
        ]
    else:  # Linux / other
        candidates = [
            home / "Zotero" / "zotero.sqlite",
            home / "Library" / "Application Support" / "Zotero" / "zotero.sqlite",
        ]
    for p in candidates:
        if p.exists() and p.stat().st_size > 0:
            return str(p)
    return str(candidates[0])


DEFAULT_CONFIG = {
    "api_url": "https://zot.0und.com",
    "username": "admin",
    "password": os.getenv("ZOTERO_PASSWORD", "adminpass"),
    "user_id": 1,
    "library_id": 1,
    "local_db": _default_local_db(),
    "minio_endpoint": "s3.0und.com",
    "minio_access_key": "minioadmin",
    "minio_secret_key": "minioadmin",
    "minio_bucket": "zotero",
    "minio_secure": False,
    "sync_attachments": True,
    "dry_run": False,
}


def load_config(config_path: str = None) -> dict:
    if config_path and Path(config_path).exists():
        with open(config_path) as f:
            return {**DEFAULT_CONFIG, **json.load(f)}
    return {**DEFAULT_CONFIG}


# ─── Zotero API Client ────────────────────────────────────────────────────────

class ZoteroAPI:
    def __init__(self, api_url: str, username: str, password: str, user_id: int):
        self.api_url = api_url.rstrip("/")
        self.auth = (username, password)
        self.headers = {
            "Zotero-API-Version": "3",
            "Content-Type": "application/json",
            "User-Agent": "ZoteroSyncClient/1.0",
        }
        self.user_id = user_id

    def _api_path(self, path: str, library_type: str, library_id: int) -> str:
        """Build API path for user or group library."""
        if library_type == "group":
            return f"groups/{library_id}/{path}"
        return f"users/{self.user_id}/{path}"

    def get(self, path: str, params: dict = None, library_type: str = None, library_id: int = None):
        if library_type:
            path = self._api_path(path, library_type, library_id)
        url = f"{self.api_url}/{path.lstrip('/')}"
        r = requests.get(url, auth=self.auth, headers=self.headers, params=params, timeout=30)
        return r

    def post(self, path: str, data: dict, params: dict = None, library_type: str = None, library_id: int = None):
        if library_type:
            path = self._api_path(path, library_type, library_id)
        url = f"{self.api_url}/{path.lstrip('/')}"
        r = requests.post(url, auth=self.auth, headers=self.headers, json=data, params=params, timeout=30)
        return r

    def patch(self, path: str, data: dict, library_type: str = None, library_id: int = None):
        if library_type:
            path = self._api_path(path, library_type, library_id)
        url = f"{self.api_url}/{path.lstrip('/')}"
        r = requests.patch(url, auth=self.auth, headers=self.headers, json=data, timeout=30)
        return r

    def delete(self, path: str, library_type: str = None, library_id: int = None):
        if library_type:
            path = self._api_path(path, library_type, library_id)
        url = f"{self.api_url}/{path.lstrip('/')}"
        r = requests.delete(url, auth=self.auth, headers=self.headers, timeout=30)
        return r

    def get_user_info(self):
        # Verify connection by fetching one item; user_id is known from config
        r = self.get(f"users/{self.user_id}/items", params={"limit": 1, "format": "json"})
        if not r.ok:
            raise Exception(f"Failed to verify connection: {r.status_code} {r.text}")
        return {"userID": self.user_id, "username": self.auth[0]}

    def get_groups(self):
        """Return list of group libraries the user belongs to."""
        r = self.get(f"users/{self.user_id}/groups", params={"format": "json"})
        if not r.ok:
            return []
        items = r.json()
        return [{"library_id": g["id"], "library_type": "group",
                 "name": g["data"]["name"], "version": g["version"]} for g in items]

    def get_items(self, since: int = None, limit: int = 100, library_type: str = None, library_id: int = None):
        params = {"format": "json", "limit": limit}
        if since:
            params["since"] = since
        r = self.get(f"items", params=params, library_type=library_type, library_id=library_id)
        if not r.ok:
            raise Exception(f"Failed to get items: {r.status_code} {r.text}")
        return r.json()

    def get_item(self, item_key: str, library_type: str = None, library_id: int = None):
        r = self.get(f"items/{item_key}", params={"format": "json"}, library_type=library_type, library_id=library_id)
        if r.status_code == 404:
            return None
        if not r.ok:
            raise Exception(f"Failed to get item {item_key}: {r.status_code}")
        return r.json()

    def post_item(self, item: dict, library_type: str = None, library_id: int = None):
        r = self.post(f"items", {"items": [item]}, library_type=library_type, library_id=library_id)
        return r

    def post_items(self, items: list, library_type: str = None, library_id: int = None):
        r = self.post(f"items", items, library_type=library_type, library_id=library_id)
        return r

    def get_collections(self, since: int = None, library_type: str = None, library_id: int = None):
        params = {"format": "json"}
        if since:
            params["since"] = since
        r = self.get(f"collections", params=params, library_type=library_type, library_id=library_id)
        if not r.ok:
            raise Exception(f"Failed to get collections: {r.status_code}")
        return r.json() if r.ok else []

    def get_attachment_upload_info(self, item_key: str, filename: str, filesize: int, md5: str,
                                  library_type: str = None, library_id: int = None):
        """Get pre-signed URL for direct S3 upload"""
        r = self.post(
            f"items/{item_key}/file",
            data={},
            params={
                "filename": filename,
                "filesize": filesize,
                "md5": md5,
                "upload": 1,
            },
            library_type=library_type,
            library_id=library_id,
        )
        if not r.ok:
            raise Exception(f"Failed to get upload info: {r.status_code} {r.text}")
        return r.json()

    def register_upload(self, item_key: str, upload_key: str, library_type: str = None, library_id: int = None):
        r = self.post(
            f"items/{item_key}/file",
            data={},
            params={"upload": upload_key},
            library_type=library_type,
            library_id=library_id,
        )
        return r


# ─── Local DB Reader ─────────────────────────────────────────────────────────

class LocalDB:
    def __init__(self, db_path: str):
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(db_path, timeout=30)
        self.db.row_factory = sqlite3.Row

    def get_libraries(self) -> list:
        """Return all libraries (user + groups) from local DB."""
        rows = self.db.execute(
            "SELECT libraryID, type, editable, filesEditable FROM libraries"
        ).fetchall()
        result = []
        for row in rows:
            r = dict(row)
            lib_type = r["type"]  # 'user' or 'group'
            if lib_type == "group":
                gr = self.db.execute(
                    "SELECT name FROM groups WHERE libraryID = ?",
                    (r["libraryID"],)
                ).fetchone()
                name = gr["name"] if gr else f"Group {r['libraryID']}"
            else:
                name = "My Library"
            result.append({
                "library_id": r["libraryID"],
                "library_type": lib_type,
                "name": name,
                "editable": r["editable"],
                "files_editable": r["filesEditable"],
            })
        return result

    def get_items(self, library_id: int, unsynced_only: bool = True):
        """Get unsynced items from local DB"""
        query = """
            SELECT i.itemID, i.key, i.version, i.itemTypeID,
                   i.dateAdded, i.dateModified, i.clientDateModified,
                   i.libraryID, i.synced
            FROM items i
            WHERE i.libraryID = ?
        """
        if unsynced_only:
            query += " AND i.synced = 0"
        query += " ORDER BY i.dateModified"
        rows = self.db.execute(query, (library_id,)).fetchall()
        return [dict(row) for row in rows]

    def get_item_data(self, item_id: int) -> dict:
        """Get all data fields for an item"""
        rows = self.db.execute("""
            SELECT fd.fieldName, idv.value
            FROM itemData id
            JOIN itemDataValues idv ON id.valueID = idv.valueID
            JOIN fieldsCombined fd ON id.fieldID = fd.fieldID
            WHERE id.itemID = ?
        """, (item_id,)).fetchall()
        return {row["fieldName"]: row["value"] for row in rows}

    def get_item_creators(self, item_id: int) -> list:
        """Get creators for an item"""
        rows = self.db.execute("""
            SELECT ic.creatorTypeID, ic.orderIndex, c.creatorID,
                   c.firstName, c.lastName, c.fieldMode
            FROM itemCreators ic
            JOIN creators c ON ic.creatorID = c.creatorID
            WHERE ic.itemID = ?
            ORDER BY ic.orderIndex
        """, (item_id,)).fetchall()
        creators = []
        for row in rows:
            if row["fieldMode"] == 1:
                creators.append({
                    "creatorType": self._creator_type_name(row["creatorTypeID"]),
                    "lastName": row["lastName"] or "",
                })
            else:
                creators.append({
                    "creatorType": self._creator_type_name(row["creatorTypeID"]),
                    "firstName": row["firstName"] or "",
                    "lastName": row["lastName"] or "",
                })
        return creators

    def _creator_type_name(self, creator_type_id: int) -> str:
        row = self.db.execute(
            "SELECT typeName FROM creatorTypes WHERE creatorTypeID = ?",
            (creator_type_id,)
        ).fetchone()
        return row["typeName"] if row else "author"

    def get_item_type(self, item_type_id: int) -> str:
        row = self.db.execute(
            "SELECT typeName FROM itemTypes WHERE itemTypeID = ?",
            (item_type_id,)
        ).fetchone()
        return row["typeName"] if row else "journalArticle"

    def get_collections(self, library_id: int, unsynced_only: bool = True):
        query = """
            SELECT c.collectionID, c.key, c.collectionName, c.version,
                   c.parentCollectionID, c.clientDateModified
            FROM collections c
            WHERE c.libraryID = ?
        """
        if unsynced_only:
            query += " AND c.synced = 0"
        rows = self.db.execute(query, (library_id,)).fetchall()
        return [dict(row) for row in rows]

    def get_attachments(self, library_id: int, unsynced_only: bool = True):
        """Get attachment items (linked or imported files)"""
        rows = self.db.execute("""
            SELECT i.itemID, i.key, i.version, i.libraryID,
                   ia.linkMode, ia.contentType,
                   ia.charsetID, ia.path, ia.syncState,
                   ia.storageHash as md5
            FROM items i
            JOIN itemAttachments ia ON i.itemID = ia.itemID
            WHERE i.libraryID = ?
        """, (library_id,)).fetchall()
        result = []
        for row in rows:
            r = dict(row)
            if unsynced_only and r["syncState"] == 1:
                continue  # already synced
            result.append(r)
        return result

    def get_attachment_file(self, path: str) -> tuple:
        """Read attachment file, return (content, md5, size)"""
        if not path:
            return None, None, None
        p = Path(path)
        if not p.exists():
            return None, None, None
        content = p.read_bytes()
        md5 = hashlib.md5(content).hexdigest()
        return content, md5, len(content)

    def mark_synced(self, item_id: int, version: int):
        self.db.execute(
            "UPDATE items SET synced = 1 WHERE itemID = ?",
            (item_id,)
        )

    def commit(self):
        self.db.commit()


# ─── MinIO Storage Client ───────────────────────────────────────────────────

class StorageClient:
    def __init__(self, endpoint: str, access_key: str, secret_key: str,
                 bucket: str, secure: bool = False):
        self.client = Minio(
            endpoint,
            access_key=access_key,
            secret_key=secret_key,
            secure=secure,
        )
        self.bucket = bucket
        self._ensure_bucket()

    def _ensure_bucket(self):
        if not self.client.bucket_exists(self.bucket):
            self.client.make_bucket(self.bucket)
            log.info(f"Created bucket: {self.bucket}")

    def upload_file(self, filepath: str, md5: str) -> str:
        """Upload file to MinIO, return hash key"""
        with open(filepath, "rb") as f:
            content = f.read()
            file_md5 = hashlib.md5(content).hexdigest()
        if md5 and md5 != file_md5:
            raise Exception(f"MD5 mismatch: expected {md5}, got {file_md5}")
        self.client.put_object(self.bucket, file_md5, io.BytesIO(content), len(content))
        log.info(f"Uploaded {filepath} as {file_md5}")
        return file_md5

    def file_exists(self, md5: str) -> bool:
        try:
            self.client.stat_object(self.bucket, md5)
            return True
        except:
            return False


# ─── Item Converter ─────────────────────────────────────────────────────────

class ItemConverter:
    """Convert local SQLite item → Zotero API JSON item"""

    ITEM_TYPE_MAP = {}  # lazy-loaded from local DB
    FIELD_MAP = {}      # lazy-loaded

    def __init__(self, local_db: LocalDB):
        self.db = local_db
        self._load_maps()

    def _load_maps(self):
        rows = self.db.db.execute("SELECT itemTypeID, typeName FROM itemTypes").fetchall()
        self.ITEM_TYPE_MAP = {r["itemTypeID"]: r["typeName"] for r in rows}
        rows = self.db.db.execute("SELECT fieldID, fieldName FROM fieldsCombined").fetchall()
        self.FIELD_MAP = {r["fieldID"]: r["fieldName"] for r in rows}

    def to_json(self, item_row: dict, library_context: dict = None) -> dict:
        item_id = item_row["itemID"]
        item_type = self.ITEM_TYPE_MAP.get(item_row["itemTypeID"], "journalArticle")

        data = self.db.get_item_data(item_id)
        creators = self.db.get_item_creators(item_id)

        result = {
            "key": item_row["key"],
            "version": item_row["version"],
            "itemType": item_type,
            "creators": creators,
            "tags": self._get_tags(item_id),
            "collections": self._get_collections(item_id),
            "relations": {},
            "dateAdded": item_row["dateAdded"],
            "dateModified": item_row["dateModified"],
        }
        if library_context:
            result["library"] = library_context
        result.update(data)
        return result

    def _get_tags(self, item_id: int) -> list:
        rows = self.db.db.execute("""
            SELECT t.name, it.type
            FROM itemTags it
            JOIN tags t ON it.tagID = t.tagID
            WHERE it.itemID = ?
        """, (item_id,)).fetchall()
        return [{"tag": row["name"], "type": row["type"]} for row in rows]

    def _get_collections(self, item_id: int) -> list:
        rows = self.db.db.execute("""
            SELECT c.key FROM collectionItems ci
            JOIN collections c ON ci.collectionID = c.collectionID
            WHERE ci.itemID = ?
        """, (item_id,)).fetchall()
        return [row["key"] for row in rows]


# ─── Sync Engine ─────────────────────────────────────────────────────────────

class SyncEngine:
    def __init__(self, config: dict):
        self.cfg = config
        self.api = ZoteroAPI(
            config["api_url"],
            config["username"],
            config["password"],
            config["user_id"],
        )
        self.local = LocalDB(config["local_db"])
        self.converter = ItemConverter(self.local)
        self.storage = StorageClient(
            config["minio_endpoint"],
            config["minio_access_key"],
            config["minio_secret_key"],
            config["minio_bucket"],
            config["minio_secure"],
        )
        self.dry_run = config["dry_run"]
        self.stats = {"upload": 0, "download": 0, "skip": 0, "error": 0}

    def _get_library_version(self, library_type: str, library_id: int) -> int:
        r = self.api.get(f"", library_type=library_type, library_id=library_id, params={"format": "json"})
        if r.ok:
            data = r.json()
            return data.get("libraryVersion", 0)
        return 0

    def _resolve_server_library_id(self, lib: dict) -> int:
        """Map local library to server-side library ID.

        User library: server ID is the config user_id.
        Group library: fetch /users/{user_id}/groups, match by name.
        Returns None if group not found on server (will be skipped).
        """
        lt = lib["library_type"]
        if lt == "user":
            return self.cfg["user_id"]

        # Group: match by name against server groups
        server_groups = self.api.get_groups()
        server_map = {g["name"]: g["library_id"] for g in server_groups}
        server_id = server_map.get(lib["name"])
        if server_id is None:
            log.warning(f"  Group '{lib['name']}' not found on server — skipping")
        return server_id

    def _list_target_libraries(self) -> list:
        """List libraries to sync based on config filter, resolved to server IDs."""
        libs = self.local.get_libraries()
        lib_filter = self.cfg.get("library_filter", "all")  # 'all', 'user', 'group'

        if lib_filter == "user":
            libs = [l for l in libs if l["library_type"] == "user"]
            log.info("Filtering: user library only")
        elif lib_filter == "group":
            libs = [l for l in libs if l["library_type"] == "group"]
            log.info("Filtering: group libraries only")
        else:
            log.info(f"Syncing all libraries ({len(libs)} found)")

        result = []
        for lib in libs:
            server_id = self._resolve_server_library_id(lib)
            if server_id is None:
                continue  # group not on server
            lib["server_library_id"] = server_id
            lt = lib["library_type"]
            lib["server_version"] = self._get_library_version(lt, server_id)
            log.info(f"  [{lt}] {lib['name']} (localID={lib['library_id']}, serverID={server_id}, version={lib['server_version']})")
            result.append(lib)

        return result

    def run(self):
        log.info(f"Connecting to {self.cfg['api_url']}")
        user_info = self.api.get_user_info()
        log.info(f"User: {user_info.get('username')} (ID: {user_info.get('userID')})")

        target_libs = self._list_target_libraries()
        if not target_libs:
            log.warning("No libraries to sync")
            return

        for lib in target_libs:
            lt = lib["library_type"]
            lid = lib["library_id"]
            sid = lib["server_library_id"]
            self.cfg["library_id"] = sid

            log.info(f"--- Syncing [{lt}] {lib['name']} ---")
            self._sync_items(lt, lid, sid)
            if self.cfg["sync_attachments"]:
                self._sync_attachments(lt, lid, sid)

        log.info(
            f"Sync done: {self.stats['upload']} uploaded, "
            f"{self.stats['download']} downloaded, "
            f"{self.stats['skip']} skipped, "
            f"{self.stats['error']} errors"
        )

    def _sync_items(self, library_type: str, library_id: int, server_library_id: int):
        """Upload unsynced items to server.

        library_id: local DB library ID (for querying local SQLite).
        server_library_id: server-side library ID (for API calls).
        """
        items = self.local.get_items(library_id)
        if not items:
            log.info("No unsynced items to upload")
            return

        # Build Zotero API library context for item JSON
        if library_type == "user":
            library_context = {"type": "user", "id": server_library_id}
        else:
            library_context = {"type": "group", "id": server_library_id}

        log.info(f"Uploading {len(items)} items...")
        batch = []
        for item_row in items:
            try:
                json_item = self.converter.to_json(item_row, library_context=library_context)
                batch.append(json_item)
            except Exception as e:
                log.error(f"Error converting item {item_row['key']}: {e}")
                self.stats["error"] += 1

        # Upload in batches of 50
        for i in range(0, len(batch), 50):
            chunk = batch[i:i+50]
            if self.dry_run:
                log.info(f"[DRY RUN] Would upload {len(chunk)} items")
                continue
            try:
                r = self.api.post_items(chunk, library_type=library_type, library_id=server_library_id)
                if r.status_code in (200, 201):
                    for item in chunk:
                        item_row = next(
                            x for x in items
                            if x["key"] == item["key"]
                        )
                        self.local.mark_synced(item_row["itemID"], item.get("version", 0))
                    log.info(f"Uploaded {len(chunk)} items OK")
                    self.stats["upload"] += len(chunk)
                else:
                    log.error(f"Upload failed: {r.status_code} {r.text[:200]}")
                    self.stats["error"] += len(chunk)
            except Exception as e:
                log.error(f"Upload batch error: {e}")
                self.stats["error"] += len(chunk)

        self.local.commit()

    def _sync_attachments(self, library_type: str, library_id: int, server_library_id: int):
        """Upload local attachments to MinIO + register on server"""
        attachments = self.local.get_attachments(library_id)
        if not attachments:
            log.info("No attachments to sync")
            return

        log.info(f"Syncing {len(attachments)} attachments...")
        for att in attachments:
            key = att["key"]
            local_path = att.get("path", "")
            link_mode = att.get("linkMode", 0)

            if link_mode == 3:  # linked URL
                log.info(f"Skipping linked URL: {key}")
                self.stats["skip"] += 1
                continue

            if link_mode == 2:  # linked file
                log.info(f"Skipping linked file: {key}")
                self.stats["skip"] += 1
                continue

            # Imported file (path is "storage:filename.pdf")
            if local_path and local_path.startswith("storage:"):
                filename = local_path[8:]  # strip "storage:"
                key = att["key"]
                data_dir = Path(self.cfg["local_db"]).parent
                local_path = str(data_dir / "storage" / key / filename)

            if not local_path or not Path(local_path).exists():
                log.warning(f"Attachment file not found: {local_path}")
                self.stats["error"] += 1
                continue

            try:
                content, md5, size = self.local.get_attachment_file(local_path)
                if not md5:
                    log.warning(f"Could not read attachment: {local_path}")
                    self.stats["error"] += 1
                    continue

                # Check if already in MinIO
                if self.storage.file_exists(md5):
                    log.info(f"File {md5} already in storage, skipping upload")
                    self.stats["skip"] += 1
                else:
                    # Upload to MinIO directly
                    if not self.dry_run:
                        self.storage.upload_file(local_path, md5)
                    else:
                        log.info(f"[DRY RUN] Would upload {local_path} as {md5}")
                    self.stats["upload"] += 1

            except Exception as e:
                log.error(f"Error syncing attachment {key}: {e}")
                self.stats["error"] += 1


# ─── CLI ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Zotero Sync Client")
    parser.add_argument("--config", default="zotero_sync_config.json")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--library-filter", default=None,
                        choices=["all", "user", "group"],
                        help="Filter libraries to sync: all (default), user, group")
    args = parser.parse_args()

    config = load_config(args.config)
    config["dry_run"] = args.dry_run or config.get("dry_run", False)
    if args.library_filter:
        config["library_filter"] = args.library_filter
    elif "library_filter" not in config:
        config["library_filter"] = "group"  # default to group-only

    if not config.get("password"):
        log.error("No password set. Set ZOTERO_PASSWORD env var or password in config.")
        sys.exit(1)

    engine = SyncEngine(config)
    engine.run()
