# Caddy (auto-TLS, HTTP-01)

Самый простой вариант: Caddy сам выпускает и обновляет сертификат через
Let's Encrypt по HTTP-01 challenge. Никаких токенов и acme.sh.

Порты наружу: **`80/tcp` + `443/tcp`**. 80 нужен и для challenge, и для
редиректа на HTTPS — оба делает сам Caddy.

## Поднятие

```bash
docker network create remnawave-network 2>/dev/null || true

cd /opt/rezeis/proxies/caddy-auto      # путь, куда вы скопировали эту папку
cp Caddyfile.example Caddyfile
sed -i 's/REPLACE_WITH_YOUR_DOMAIN/panel.rezeis.com/g' Caddyfile
sed -i 's/REPLACE_WITH_YOUR_EMAIL/you@example.com/g'   Caddyfile

docker compose up -d
docker compose logs -f
```

В логе увидите строки `serving initial configuration` и через несколько секунд
`certificate obtained successfully` — это Caddy получил сертификат у LE.

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
ufw allow 80/tcp           # для challenge и редиректа на 443
ufw allow 443/tcp
ufw enable
```

## Когда выбрать этот вариант, а не `caddy/`

- Не хочется возиться с Cloudflare API token.
- Cloudflare DNS не используется (или используется любой провайдер без удобного API).
- Открытый 80 порт не критичен.

## Когда лучше использовать `caddy/`

- Нужно **только 443** наружу (политика безопасности, требования компании).
- Хочется **wildcard** сертификат (`*.rezeis.com`).
- Cloudflare — основной DNS-провайдер.
