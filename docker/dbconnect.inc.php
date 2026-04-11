<?php
/**
 * Docker single-host DB config — all DBs on the same MySQL instance.
 * Credentials come from environment variables.
 */
function Zotero_DBConnectAuth($db) {
    $host = getenv('MYSQL_HOST') ?: 'host.docker.internal';
    $port = getenv('MYSQL_PORT') ?: 3306;
    $user = getenv('MYSQL_USER') ?: 'zotero';
    $pass = getenv('ZOTERO_MYSQL_PASS') ?: getenv('MYSQL_PASSWORD') ?: 'zotropass';
    $dbMap = [
        'master' => getenv('MYSQL_DATABASE') ?: 'zotero',
        'shard'  => getenv('MYSQL_DATABASE') ?: 'zotero',
        'id1'    => 'ids',
        'id2'    => 'ids',
        'www1'   => 'www',
        'www2'   => 'www',
    ];
    $dbName = $dbMap[$db] ?? null;
    if ($dbName === null) {
        throw new Exception("Invalid db '$db'");
    }
    return [
        'host'     => $host,
        'replicas' => ($db === 'master') ? [['host' => $host]] : [],
        'port'     => (int) $port,
        'db'       => $dbName,
        'user'     => $user,
        'pass'     => $pass,
        'charset'  => '',
        'state'    => 'up',
    ];
}
?>
