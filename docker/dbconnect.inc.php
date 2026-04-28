<?php
/**
 * Docker single-host DB config — all DBs on the same MySQL instance.
 * Credentials come from environment variables.
 *
 * Hardcoded defaults for single-host Docker setup (127.0.0.1).
 * Use SHORT env var names to avoid Docker truncation:
 *   DB_USER, DB_PASS, DB_NAME
 */
function Zotero_DBConnectAuth($db) {
    $host = '127.0.0.1';
    $port = 3306;
    $user = getenv('DB_USER') ?: 'zotero';
    $pass = getenv('DB_PASS') ?: 'zotropass';
    $dbName = getenv('DB_NAME') ?: 'zotero';
    $dbMap = [
        'master' => $dbName,
        'shard'  => $dbName,
        'id1'    => 'ids',
        'id2'    => 'ids',
        'www1'   => 'www',
        'www2'   => 'www',
    ];
    return [
        'host'     => $host,
        'replicas' => ($db === 'master') ? [['host' => $host]] : [],
        'port'     => (int) $port,
        'db'       => $dbMap[$db] ?? $dbName,
        'user'     => $user,
        'pass'     => $pass,
        'charset'  => '',
        'state'    => 'up',
    ];
}