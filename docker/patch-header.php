<?php
/**
 * Patch dataserver PHP files for Docker (minimal setup).
 * Run from /var/www/html after COPY.
 */

chdir('/var/www/html');

// Patch one file at a time to avoid cascading str_replace issues
function patchFile($file, $patches) {
    $content = file_get_contents($file);
    foreach ($patches as [$label, $old, $new]) {
        if ($old === "") {
            $content .= "\n" . $new;
            echo "  [OK] $label\n";
        } elseif (strpos($content, $old) !== false) {
            $content = str_replace($old, $new, $content);
            echo "  [OK] $label\n";
        } else {
            echo "  [SKIP] $label (not found)\n";
        }
    }
    file_put_contents($file, $content);
}

echo "Patching master.sql (shardHosts address column)...\n";
patchFile('misc/master.sql', [
    [
        'fix shardHosts address column size',
        "`address` varchar(15) NOT NULL",
        "`address` varchar(64) NOT NULL",
    ],
]);

echo "Patching index.php (routes path)...\n";
patchFile('htdocs/index.php', [
    [
        'fix routes.inc.php path',
        "require('config/routes.inc.php');",
        "require('../include/config/routes.inc.php');",
    ],
]);

echo "Patching routes.inc.php (mvc path)...\n";
patchFile('include/config/routes.inc.php', [
    [
        'fix mvc Router.inc.php path (original)',
        "require('mvc/Router.inc.php');",
        "require(__DIR__ . '/../mvc/Router.inc.php');",
    ],
    [
        'fix mvc Router.inc.php path (already patched with ../)',
        "require('../mvc/Router.inc.php');",
        "require(__DIR__ . '/../mvc/Router.inc.php');",
    ],
]);

echo "Patching routes.inc.php (add /users/current route)...\n";
patchFile('include/config/routes.inc.php', [
    [
        'add /users/current route',
        '$router->map(\'/users/i:objectUserID/keys/:objectName\', array(\'controller\' => \'Keys\'));',
        sprintf("\$router->map('/users/current', array('controller' => 'Api', 'action' => 'currentUser'));\n\$router->map('/users/i:objectUserID/keys/:objectName', array('controller' => 'Keys'));"),
    ],
]);

echo "Patching Z_Core class (AWS_PUBLIC)...\n";
patchFile('include/Core.inc.php', [
    [
        'declare AWS_PUBLIC static property',
        "public static \$AWS = null; // AWS-SDK",
        "public static \$AWS = null; // AWS-SDK\n\tpublic static \$AWS_PUBLIC = null; // AWS-SDK with public endpoint",
    ],
]);

echo "Patching config.inc.php (Redis host)...\n";
patchFile('include/config/config.inc.php', [
    [
        'Redis host to env var',
        sprintf("\tpublic static \$REDIS_HOSTS = [\n\t\t'default' => [\n\t\t\t'host' => 'redis:6379'\n\t\t],\n\t\t'request-limiter' => [\n\t\t\t'host' => 'redis:6379'\n\t\t],\n\t\t'notifications' => [\n\t\t\t'host' => 'redis:6379'\n\t\t],\n\t\t'fulltext-migration' => [\n\t\t\t'host' => 'redis:6379',\n\t\t\t'cluster' => true\n\t\t]\n\t];"),
        sprintf("\t// REDIS_HOSTS set dynamically in header.inc.php after config load\n\tpublic static \$REDIS_HOSTS = [\n\t\t'default' => [\n\t\t\t'host' => 'redis'\n\t\t],\n\t\t'request-limiter' => [\n\t\t\t'host' => 'redis'\n\t\t],\n\t\t'notifications' => [\n\t\t\t'host' => 'redis'\n\t\t],\n\t\t'fulltext-migration' => [\n\t\t\t'host' => 'redis',\n\t\t\t'cluster' => true\n\t\t]\n\t];"),
    ],
]);

echo "Patching header.inc.php (Redis host override)...\n";
patchFile('include/header.inc.php', [
    [
        'Redis host override after config load',
        sprintf("// Read in configuration variables\nrequire('config/config.inc.php');\n\nif (Z_Core::isCommandLine())"),
        sprintf("// Read in configuration variables\nrequire('config/config.inc.php');\n\n// Override Redis host to use 127.0.0.1 (host network) or REDIS_HOST env var\n\$redisHost = getenv('REDIS_HOST') ?: '127.0.0.1';\nZ_CONFIG::\$REDIS_HOSTS = [\n    'default' => ['host' => \$redisHost],\n    'request-limiter' => ['host' => \$redisHost],\n    'notifications' => ['host' => \$redisHost],\n    'fulltext-migration' => ['host' => \$redisHost, 'cluster' => true],\n];\n\nif (Z_Core::isCommandLine())"),
    ],
]);

echo "Patching header.inc.php (S3/MinIO, ES, AWS_PUBLIC)...\n";
patchFile('include/header.inc.php', [
    [
        'S3/MinIO endpoint support',
        sprintf("\$awsConfig = [\n\t'region' => !empty(Z_CONFIG::\$AWS_REGION) ? Z_CONFIG::\$AWS_REGION : 'us-east-1',\n\t'version' => 'latest',\n\t'signature' => 'v4',\n\t'http' => [\n\t\t'timeout' => 3\n\t],\n\t'retries' => 2\n];"),
        sprintf("\$S3_ENDPOINT = getenv('S3_ENDPOINT') ?: '';\n\$S3_PUBLIC_ENDPOINT = getenv('S3_PUBLIC_ENDPOINT') ?: '';\n\$AWS_ACCESS_KEY_ID = getenv('AWS_ACCESS_KEY_ID') ?: Z_CONFIG::\$AWS_ACCESS_KEY;\n\$AWS_SECRET_ACCESS_KEY = getenv('AWS_SECRET_ACCESS_KEY') ?: Z_CONFIG::\$AWS_SECRET_KEY;\n\n\$awsConfig = [\n\t'region' => !empty(Z_CONFIG::\$AWS_REGION) ? Z_CONFIG::\$AWS_REGION : 'us-east-1',\n\t'version' => 'latest',\n\t'signature' => 'v4',\n\t'http' => [\n\t\t'timeout' => 3\n\t],\n\t'retries' => 2\n];\nif (\$S3_ENDPOINT) {\n\t\$awsConfig['endpoint'] = 'http://' . \$S3_ENDPOINT;\n\t\$awsConfig['use_path_style_endpoint'] = true;\n\t\$awsConfig['scheme'] = 'http';\n}"),
    ],
    [
        'credential provider (env vars)',
        sprintf("// IAM role authentication\nif (empty(Z_CONFIG::\$AWS_ACCESS_KEY)) {"),
        sprintf("// MinIO / Docker: use env vars, fall back to IAM role\nif (empty(\$AWS_ACCESS_KEY_ID)) {"),
    ],
    [
        'Elasticsearch conditional init',
        sprintf("// Elasticsearch\n\$esConfig = [\n\t'hosts' => Z_CONFIG::\$SEARCH_HOSTS\n];\nZ_Core::\$ES = \\Elasticsearch\\ClientBuilder::fromConfig(\$esConfig, true);"),
        sprintf("// Elasticsearch (optional \u2014 set SEARCH_HOSTS env to enable)\n\$esConfig = ['hosts' => Z_CONFIG::\$SEARCH_HOSTS];\nif (!empty(Z_CONFIG::\$SEARCH_HOSTS[0])) {\n\tZ_Core::\$ES = \\Elasticsearch\\ClientBuilder::fromConfig(\$esConfig, true);\n} else {\n\tZ_Core::\$ES = null;\n}"),
    ],
    [
        'AWS_PUBLIC for presigned URLs',
        sprintf("Z_Core::\$AWS = new Aws\\Sdk(\$awsConfig);\nunset(\$awsConfig);"),
        sprintf("Z_Core::\$AWS = new Aws\\Sdk(\$awsConfig);\nif (\$S3_PUBLIC_ENDPOINT) {\n\t\$awsConfigPublic = \$awsConfig;\n\t\$awsConfigPublic['endpoint'] = \$S3_PUBLIC_ENDPOINT;\n\t\$awsConfigPublic['use_path_style_endpoint'] = true;\n\t\$awsConfigPublic['scheme'] = 'http';\n\tZ_Core::\$AWS_PUBLIC = new Aws\\Sdk(\$awsConfigPublic);\n}\nunset(\$awsConfig);"),
    ],
]);

echo "Patching DB.inc.php (fix shard credentials)...\n";
patchFile('include/DB.inc.php', [
    [
        'fix shard connection credentials',
        sprintf("\$config = [\n\t\t\t'host'     => \$info['host'],\n\t\t\t'port'     => \$info['port'],\n\t\t\t// Docker: use env vars when DB doesn't store credentials\n\t\t\t'username' => !empty(\$info['user']) ? \$info['user'] : (getenv('DB_USER') ?: 'zotero'),\n\t\t\t'password' => !empty(\$info['pass']) ? \$info['pass'] : (getenv('DB_PASS') ?: 'zotropass'),\n\t\t\t'dbname'   => \$info['db'],"),
        sprintf("\$config = [\n\t\t\t'host'     => \$info['host'],\n\t\t\t'port'     => \$info['port'],\n\t\t\t// Docker: use env vars when DB doesn't store credentials\n\t\t\t'username' => !empty(\$info['user']) ? \$info['user'] : (getenv('MYSQL_USER') ?: 'zotero'),\n\t\t\t'password' => !empty(\$info['pass']) ? \$info['pass'] : (getenv('ZOTERO_MYSQL_PASS') ?: 'zotropass'),\n\t\t\t'dbname'   => \$info['db'],"),
    ],
]);

echo "Patching LoginSessionsController (fix loginURL to use Host header)...\n";
patchFile('controllers/LoginSessionsController.php', [
    [
        'fix loginURL to use request Host',
        sprintf("\$response = [\n\t\t\t\t'sessionToken' => \$session->sessionToken,\n\t\t\t\t'loginURL' => Z_CONFIG::\$WWW_BASE_URI . 'login?session=' . \$session->sessionToken\n\t\t\t];"),
        sprintf("\$proto = (!empty(\$_SERVER['HTTPS']) && \$_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';\n\t\t\t\$host = \$_SERVER['HTTP_HOST'] ?? Z_CONFIG::\$WWW_BASE_URI;\n\t\t\t\$response = [\n\t\t\t\t'sessionToken' => \$session->sessionToken,\n\t\t\t\t'loginURL' => \$proto . '://' . \$host . '/auth/login?session=' . \$session->sessionToken\n\t\t\t];"),
    ],
]);

echo "Patching Password.inc.php (fix www DB name)...\n";
patchFile('model/auth/Password.inc.php', [
    [
        'fix www database name',
        sprintf("// TODO: config\n\t\t\$dev = Z_ENV_TESTING_SITE ? \"_dev\" : \"\";\n\t\t\$databaseName = \"zotero_www{\$dev}\";"),
        sprintf("// Docker: www database name is \"www\" (mapped via www1/www2 in dbconnect.inc.php)\n\t\t\$databaseName = \"www\";"),
    ],
]);

echo "Patching ApiController.php (add currentUser action)...\n";
patchFile('controllers/ApiController.php', [
    [
        'add currentUser action for /users/current',
        sprintf("public function noop() {\n\t\techo \"Nothing to see here.\";\n\t\texit;\n\t}"),
        sprintf("public function noop() {\n\t\techo \"Nothing to see here.\";\n\t\texit;\n\t}\n\n\tpublic function currentUser() {\n\t\t\$this->allowMethods(['GET']);\n\t\t\$userID = \$this->userID;\n\t\tif (!\$userID) {\n\t\t\t\$this->e401('Not authenticated');\n\t\t}\n\t\t\$username = Zotero_Users::getUsername(\$userID);\n\t\t\$libraryID = Zotero_Users::getLibraryIDFromUserID(\$userID);\n\t\theader('Content-Type: application/json');\n\t\techo json_encode([\n\t\t\t'userID' => \$userID,\n\t\t\t'username' => \$username,\n\t\t\t'libraryID' => \$libraryID,\n\t\t], JSON_UNESCAPED_SLASHES);\n\t\t\$this->end();\n\t}"),
    ],
]);

echo "\nDone.\n";
