#!/usr/bin/env php
<?php
/**
 * Bootstrap Zotero framework and apply database schema updates.
 * Run during container startup (before Apache).
 */

chdir('/var/www/html');

require_once '/var/www/html/include/header.inc.php';
require_once '/var/www/html/include/DB.inc.php';
require_once '/var/www/html/model/Schema.inc.php';

$schemaFile = '/var/www/html/htdocs/zotero-schema/schema.json';
if (!file_exists($schemaFile)) {
    fwrite(STDERR, "Schema file not found: $schemaFile\n");
    exit(1);
}

$schemaData = json_decode(file_get_contents($schemaFile), true);
if (!$schemaData) {
    fwrite(STDERR, "Failed to parse schema.json\n");
    exit(1);
}

echo "Current schema version in DB: ";
$dbVersion = (int) Zotero_DB::valueQuery(
    "SELECT value FROM settings WHERE name='schemaVersion'"
);
echo $dbVersion . "\n";
echo "Target schema version: " . $schemaData['version'] . "\n";

if ($dbVersion >= $schemaData['version']) {
    echo "Schema is up to date.\n";
    exit(0);
}

echo "Applying schema updates...\n";
try {
    \Zotero\Schema::updateDatabase($schemaData);
    echo "Schema updated successfully to version " . $schemaData['version'] . "\n";
} catch (Exception $e) {
    fwrite(STDERR, "Schema update failed: " . $e->getMessage() . "\n");
    exit(1);
}
