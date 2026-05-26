# Traefik + Let's Encrypt (HTTP-01)

Traefik сам выпускает и обновляет сертификат через ACME HTTP-01.
Конфиг построен по тому же шаблону, что и официальный Traefik-гайд Remnawave.

Порты наружу: **`80/tcp` + `443/tcp`**.

## Поднятие

```bash
docker network create remnawave-network 2>/dev/null || true

cd /opt/rezeis/proxies/traefik         # путь, куда вы скопировали эту папку

cp traefik.yml.example traefik.yml
sed -i 's/REPLACE_WITH_YOUR_EMAIL/you@example.com/g' traefik.yml

mkdir -p config letsencrypt logs
cp config/rezeis.yml.example config/rezeis.yml
sed -i 's/REPLACE_WITH_YOUR_DOMAIN/panel.rezeis.com/g' config/rezeis.yml

# acme.json должен иметь права 600, иначе Traefik откажется его использовать
touch letsencrypt/acme.json
chmod 600 letsencrypt/acme.json

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
ufw allow 80/tcp           # ACME HTTP-01 + редирект на 443
ufw allow 443/tcp
ufw enable
```

## Ограничение доступа по IP

Если нужно — добавьте middleware (см. официальный Remnawave Traefik-гайд,
секция «Restricting access to the panel by IP»). Шаблон:

```yaml
# config/ip-allow-list.yml
http:
  middlewares:
    ip-allow-list:
      ipAllowList:
        sourceRange:
          - 'REPLACE_WITH_YOUR_IP'
```

И прицепить её к роутеру в `config/rezeis.yml`:

```yaml
routers:
  rezeis:
    middlewares:
      - ip-allow-list
```
