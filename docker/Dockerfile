FROM php:8.2-apache

# Build-time proxy support (optional, pass via --build-arg or .env)
# Supports both upper/lowercase — set either or both.
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG http_proxy
ARG https_proxy
ARG NO_PROXY
ARG no_proxy
ENV HTTP_PROXY=${HTTP_PROXY:-${http_proxy:-}} \
    HTTPS_PROXY=${HTTPS_PROXY:-${https_proxy:-}} \
    http_proxy=${http_proxy:-${HTTP_PROXY:-}} \
    https_proxy=${https_proxy:-${HTTPS_PROXY:-}} \
    NO_PROXY=${NO_PROXY:-${no_proxy:-localhost,127.0.0.1}} \
    no_proxy=${no_proxy:-${NO_PROXY:-localhost,127.0.0.1}}

# Install system deps + MinIO client + MySQL client
RUN apt-get update && apt-get install -y \
    libzip-dev libcurl4-openssl-dev libssl-dev zip unzip git curl \
    libicu-dev libonig-dev wget gnupg default-mysql-client \
    && rm -rf /var/lib/apt/lists/*

RUN wget -q https://dl.min.io/client/mc/release/linux-amd64/mc -O /usr/local/bin/mc \
    && chmod +x /usr/local/bin/mc

# PHP extensions
RUN docker-php-ext-install \
    mysqli pdo pdo_mysql zip opcache curl mbstring intl bcmath

# Redis extension (compiled from source, respects HTTP_PROXY)
RUN cd /tmp \
    && curl -fsSL https://github.com/phpredis/phpredis/archive/6.0.2.tar.gz -o redis.tar.gz \
    && tar xzf redis.tar.gz \
    && cd phpredis-6.0.2 \
    && phpize \
    && ./configure \
    && make -j$(nproc) \
    && make install \
    && docker-php-ext-enable redis \
    && rm -rf /tmp/redis* /tmp/phpredis-*

# Composer
RUN curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

# ── Clone official Zotero dataserver from GitHub ──────────────────────────────
ARG DATASERVER_REF=master
WORKDIR /var/www/html
RUN git clone --depth=1 --branch="${DATASERVER_REF:-master}" \
        https://github.com/zotero/dataserver.git .

# ── Clone zotero-schema (submodule, but clone directly to avoid safe.directory issues) ──
RUN git config --global --add safe.directory /var/www/html \
    && rm -rf htdocs/zotero-schema \
    && git clone --depth=1 https://github.com/zotero/zotero-schema.git htdocs/zotero-schema

# ── Zend Framework 1.x (legacy, not in composer) ────────────────────────────
RUN mkdir -p /usr/src/zf1 && \
    wget -q https://github.com/zendframework/zf1/archive/refs/tags/release-1.12.20.tar.gz -O /tmp/zf1.tar.gz && \
    tar -xzf /tmp/zf1.tar.gz -C /usr/src/zf1 --strip-components=1 && \
    mkdir -p /usr/local/lib/php && \
    cp -r /usr/src/zf1/library/Zend /usr/local/lib/php/ && \
    rm -rf /tmp/zf1.tar.gz /usr/src/zf1

# ── PHP include_path so Zend is found ────────────────────────────────────────
RUN echo "include_path='.:/usr/local/lib/php:/var/www/html/include'" \
    > /usr/local/etc/php/conf.d/docker-php-zend.ini

# ── Copy Docker config files (config/ not in GitHub repo) ────────────────────
COPY config.inc.php include/config/config.inc.php
COPY dbconnect.inc.php include/config/dbconnect.inc.php

# ── Auth pages (login/register) ──────────────────────────────────────────────
COPY auth/ htdocs/auth/

# ── Apply Docker environment patches ──────────────────────────────────────────
COPY patch-header.php /tmp/
RUN php /tmp/patch-header.php

# ── Patch: ensure annotation sortIndex is never null ─────────────────────────
COPY Item.inc.php /var/www/html/model/Item.inc.php

# ── Composer deps ─────────────────────────────────────────────────────────────
RUN cd /var/www/html && composer install --no-dev --prefer-dist --no-scripts --ignore-platform-reqs

# ── tmp directory ──────────────────────────────────────────────────────────────
RUN mkdir -p /var/www/html/tmp /var/www/html/tmp/cache && chmod 777 /var/www/html/tmp

# ── Apache: listen on ZOTERO_API_PORT (default 23231), set DocumentRoot to htdocs
ARG ZOTERO_API_PORT=23231
RUN a2enmod rewrite headers \
    && sed -i "s/Listen 80/Listen ${ZOTERO_API_PORT}/" /etc/apache2/ports.conf \
    && sed -i "s|<VirtualHost \\*:[0-9]*>|<VirtualHost *:${ZOTERO_API_PORT}>|" /etc/apache2/sites-available/000-default.conf \
    && sed -i '0,/DocumentRoot/s|DocumentRoot /var/www/html|DocumentRoot /var/www/html/htdocs|' /etc/apache2/sites-available/000-default.conf \
    && sed -i '/^RewriteEngine On/ a RewriteRule ^auth/login$ auth/login.php [L]' /var/www/html/htdocs/.htaccess \
    && echo "ServerName localhost" >> /etc/apache2/apache2.conf
COPY php.ini /usr/local/etc/php/conf.d/docker-php-custom.ini

# ── Init script ────────────────────────────────────────────────────────────────
COPY init.sh /init.sh
COPY init-schema.php /init-schema.php
RUN chmod +x /init.sh

WORKDIR /var/www/html
EXPOSE ${ZOTERO_API_PORT}
ENTRYPOINT ["/init.sh"]
