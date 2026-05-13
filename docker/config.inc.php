<?php
/**
 * Docker config — static defaults + runtime env-var injection.
 * Covers every Z_CONFIG property referenced by the codebase.
 */
class Z_CONFIG {
    // ── Runtime injection happens after class definition below ──────────────

    // ── Fixed defaults (must all be valid PHP constant expressions) ─────────
    public static $API_ENABLED = true;
    public static $READ_ONLY = false;
    public static $BACKOFF = 0;
    public static $TESTING_SITE = false;
    public static $DEV_SITE = false;
    public static $DEBUG_LOG = false;

    public static $BASE_URI = '';
    public static $API_BASE_URI = '';
    public static $WWW_BASE_URI = '';

    public static $AUTH_SALT = '';
    public static $API_SUPER_USERNAME = '';
    public static $API_SUPER_PASSWORD = '';

    public static $AWS_REGION = 'us-east-1';
    public static $AWS_ACCESS_KEY = '';
    public static $AWS_SECRET_KEY = '';
    public static $S3_BUCKET = '';
    public static $S3_BUCKET_CACHE = '';
    public static $S3_BUCKET_FULLTEXT = '';
    public static $S3_BUCKET_ERRORS = '';
    public static $SNS_ALERT_TOPIC = '';

    public static $REDIS_HOSTS = [];
    public static $REDIS_PREFIX = '';
    public static $REDIS_PASSWORD = null;

    public static $MEMCACHED_ENABLED = false;
    public static $MEMCACHED_SERVERS = [];

    public static $TRANSLATION_SERVERS = [];
    public static $CITATION_SERVERS = [];

    public static $SEARCH_HOSTS = [];
    public static $GLOBAL_ITEMS_URL = '';

    public static $ATTACHMENT_PROXY_URL = '';
    public static $ATTACHMENT_PROXY_SECRET = '';

    public static $TTS_TABLE = '';
    public static $S3_BUCKET_TTS = '';
    public static $TTS_AUDIO_DOMAIN = '';
    public static $TTS_CREDIT_LIMITS = [];
    public static $TTS_DAILY_LIMIT_MINUTES = 0;

    public static $STATSD_ENABLED = false;
    public static $STATSD_PREFIX = '';
    public static $STATSD_HOST = '';
    public static $STATSD_PORT = 8125;

    public static $LOG_TO_SCRIBE = false;
    public static $LOG_ADDRESS = '';
    public static $LOG_PORT = 0;
    public static $LOG_TIMEZONE = 'UTC';
    public static $LOG_TARGET_DEFAULT = 'errors';

    public static $HTMLCLEAN_SERVER_URL = '';
    public static $CLI_PHP_PATH = '/usr/bin/php';

    public static $CACHE_VERSION_ATOM_ENTRY = 1;
    public static $CACHE_VERSION_BIB = 1;
    public static $CACHE_VERSION_RESPONSE_JSON_COLLECTION = 1;
    public static $CACHE_VERSION_RESPONSE_JSON_ITEM = 1;
    public static $CACHE_ENABLED_ITEM_RESPONSE_JSON = true;

    // ── Optional / rarely used ─────────────────────────────────────────────
    public static $MAINTENANCE_MESSAGE = '';
    public static $ERROR_PATH = '';
    public static $REPROXY_MAP = [];
    public static $URI_PREFIX_DOMAIN_MAP = [];
}

// ── Runtime env-var injection ──────────────────────────────────────────────
Z_CONFIG::$API_SUPER_USERNAME    = getenv('ADMIN_USERNAME') ?: 'admin';
Z_CONFIG::$API_SUPER_PASSWORD    = getenv('ADMIN_PASSWORD') ?: 'adminpass';
Z_CONFIG::$API_BASE_URI         = getenv('API_BASE_URI') ?: 'http://localhost:8080/';
Z_CONFIG::$WWW_BASE_URI         = getenv('WWW_BASE_URI') ?: 'http://localhost:8080/';
Z_CONFIG::$AWS_REGION           = getenv('AWS_REGION') ?: 'us-east-1';
Z_CONFIG::$AWS_ACCESS_KEY       = getenv('AWS_ACCESS_KEY_ID') ?: '';
Z_CONFIG::$AWS_SECRET_KEY       = getenv('AWS_SECRET_ACCESS_KEY') ?: '';
Z_CONFIG::$S3_BUCKET            = getenv('S3_BUCKET') ?: 'zotero';
Z_CONFIG::$S3_BUCKET_FULLTEXT   = getenv('S3_BUCKET_FULLTEXT') ?: 'zotero-fulltext';
Z_CONFIG::$ATTACHMENT_PROXY_URL = getenv('ATTACHMENT_PROXY_URL') ?: 'http://localhost:8080/';
Z_CONFIG::$ATTACHMENT_PROXY_SECRET = getenv('ATTACHMENT_PROXY_SECRET') ?: 'dev-secret';
Z_CONFIG::$AUTH_SALT            = getenv('AUTH_SALT') ?: '';
Z_CONFIG::$REDIS_PASSWORD        = getenv('REDIS_PASSWORD') ?: null;
Z_CONFIG::$SEARCH_HOSTS         = [getenv('SEARCH_HOSTS') ?: ''];

$redisHost = getenv('REDIS_HOST') ?: 'redis';
Z_CONFIG::$REDIS_HOSTS = [
    'default' => ['host' => $redisHost],
    'request-limiter' => ['host' => $redisHost],
    'notifications' => ['host' => $redisHost],
    'fulltext-migration' => ['host' => $redisHost, 'cluster' => true],
];
?>
