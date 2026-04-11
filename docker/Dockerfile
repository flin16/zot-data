# syntax=docker/dockerfile:1
FROM php:8.2-apache

# Install system deps + MinIO client + MySQL client
RUN apt-get update && apt-get install -y \
    libzip-dev libcurl4-openssl-dev libssl-dev zip unzip git curl \
    libicu-dev libonig-dev wget gnupg default-mysql-client \
    && wget -q https://dl.min.io/client/mc/release/linux-amd64/mc -O /usr/local/bin/mc \
    && chmod +x /usr/local/bin/mc \
    && rm -rf /var/lib/apt/lists/*

# PHP extensions
RUN docker-php-ext-install \
    mysqli pdo pdo_mysql zip opcache curl mbstring intl bcmath

# Redis extension
RUN pecl install redis && docker-php-ext-enable redis

# Composer
RUN curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

# ── Clone official Zotero dataserver from GitHub ──────────────────────────────
ARG DATASERVER_REF=master
WORKDIR /var/www/html
RUN git clone --depth=1 --branch="${DATASERVER_REF:-master}" \
        https://github.com/zotero/dataserver.git .

# ── Clone zotero-schema submodule ────────────────────────────────────────────
RUN git submodule update --init --recursive htdocs/zotero-schema || true

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

# ── Apply Docker environment patches ──────────────────────────────────────────
COPY patch-header.php /tmp/
RUN php /tmp/patch-header.php

# ── Composer deps ─────────────────────────────────────────────────────────────
RUN cd /var/www/html && composer install --no-dev --prefer-dist --no-scripts --ignore-platform-reqs

# ── tmp directory ──────────────────────────────────────────────────────────────
RUN mkdir -p /var/www/html/tmp /var/www/html/tmp/cache && chmod 777 /var/www/html/tmp

# ── Apache ─────────────────────────────────────────────────────────────────────
RUN a2enmod rewrite headers \
    && echo "ServerName localhost" >> /etc/apache2/apache2.conf
COPY apache2-site.conf /etc/apache2/sites-available/000-default.conf
COPY php.ini /usr/local/etc/php/conf.d/docker-php-custom.ini

# ── Init script ────────────────────────────────────────────────────────────────
COPY init.sh /init.sh
RUN chmod +x /init.sh

WORKDIR /var/www/html
EXPOSE 80
ENTRYPOINT ["/init.sh"]
