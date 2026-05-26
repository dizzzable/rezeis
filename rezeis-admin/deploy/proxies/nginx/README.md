# Nginx + acme.sh TLS-ALPN-01

Аналог официального Nginx-гайда Remnawave. Открыты наружу:

- `443/tcp` — постоянно;
- `8443/tcp` — только в момент выпуска / обновления сертификата (~30 секунд раз
  в 60 дней). 80 не нужен.

> ⚠️ **Cloudflare proxy (orange cloud) и TLS-ALPN-01 несовместимы.** Cloudflare
> не пропускает трафик на 8443. Используйте grey cloud (DNS only) или
> переключайтесь на стек `caddy/` с DNS-01.

## Установка acme.sh

```bash
sudo apt-get install -y cron socat
curl https://get.acme.sh | sh -s email=YOUR_EMAIL
source ~/.bashrc
~/.acme.sh/acme.sh --upgrade --auto-upgrade
~/.acme.sh/acme.sh --set-default-ca --server letsencrypt
```

## Выпуск сертификата

Файлы сертификатов попадают **сразу в текущую директорию** — Nginx-контейнер
читает их через bind-mount.

```bash
cd /opt/rezeis/proxies/nginx          # путь, куда вы скопировали эту папку

~/.acme.sh/acme.sh --issue --standalone \
  -d 'panel.rezeis.com' \
  --key-file       "$PWD/privkey.key" \
  --fullchain-file "$PWD/fullchain.pem" \
  --alpn --tlsport 8443 \
  --reloadcmd      "docker exec rezeis-nginx nginx -s reload"
```

И сразу же зарегистрируем установку с автообновлением:

```bash
~/.acme.sh/acme.sh --install-cert -d 'panel.rezeis.com' \
  --key-file       "$PWD/privkey.key" \
  --fullchain-file "$PWD/fullchain.pem" \
  --reloadcmd      "docker exec rezeis-nginx nginx -s reload"
```

## Поднятие прокси

```bash
docker network create remnawave-network 2>/dev/null || true

cp nginx.conf.example nginx.conf
sed -i 's/REPLACE_WITH_YOUR_DOMAIN/panel.rezeis.com/g' nginx.conf

docker compose up -d
docker compose logs -f
```

После этого:

```bash
cd /opt/rezeis/rezeis-admin
docker compose up -d
```

Открываем `https://panel.rezeis.com`.

## Firewall

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 443/tcp
ufw allow 8443/tcp         # для renew сертификата
ufw enable
```

> Если хотите ещё чище — закрывайте 8443 после первичного выпуска и
> временно открывайте только на момент renew. Это не очень удобно, но
> возможно: cron-таск acme.sh легко обернуть в скрипт `ufw allow 8443/tcp;
> acme.sh --cron; ufw deny 8443/tcp`.
