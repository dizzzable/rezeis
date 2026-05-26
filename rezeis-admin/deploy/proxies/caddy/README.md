# Caddy + acme.sh DNS-01 (Cloudflare)

Минимальный набор открытых портов наружу: **только `443/tcp`**.
Caddy сам TLS не выпускает — он берёт готовые сертификаты, которые acme.sh
кладёт на хост в `/etc/acme/<домен>/`.

## Подготовка Cloudflare API Token

1. В Cloudflare → **My Profile → API Tokens → Create Token → Custom Token**.
2. Permissions:
   - `Zone → Zone → Read`
   - `Zone → DNS → Edit`
3. Zone Resources: `Include → Specific zone → <твоя-зона>`.
4. Сохраните `CF_Token`. Также нужен `CF_Account_ID` — он на главной странице
   зоны в Cloudflare справа внизу.

## Установка acme.sh на хост (одноразово)

```bash
sudo apt-get install -y cron socat
curl https://get.acme.sh | sh -s email=YOUR_EMAIL
source ~/.bashrc
~/.acme.sh/acme.sh --upgrade --auto-upgrade
~/.acme.sh/acme.sh --set-default-ca --server letsencrypt
```

## Выпуск сертификата (одноразово)

Замените `panel.rezeis.com` на ваш домен.

```bash
export CF_Token="вставь-сюда-Cloudflare-API-Token"
export CF_Account_ID="вставь-сюда-Account-ID"

sudo mkdir -p /etc/acme/panel.rezeis.com

sudo --preserve-env=CF_Token,CF_Account_ID ~/.acme.sh/acme.sh --issue --dns dns_cf \
  -d panel.rezeis.com \
  --key-file       /etc/acme/panel.rezeis.com/privkey.key \
  --fullchain-file /etc/acme/panel.rezeis.com/fullchain.pem \
  --reloadcmd      "docker exec caddy caddy reload --config /etc/caddy/Caddyfile"
```

> **Хочешь wildcard?** Добавь `-d '*.rezeis.com'` к команде, и один сертификат
> закроет и админку, и reiwa, и всё что нужно. В этом случае пути меняются на
> `/etc/acme/wildcard.rezeis.com/...`, и в `Caddyfile` указывается тот же файл.

После выпуска `acme.sh` сохраняет твои `CF_Token`/`CF_Account_ID` в
`~/.acme.sh/account.conf`. Каждый день cron-задача `acme.sh --cron` проверяет,
осталось ли меньше 60 дней до конца срока, и автоматически перевыпускает
сертификат, копирует файлы и дёргает `caddy reload`.

## Поднятие прокси

```bash
# создаём общую сеть, если её ещё нет
docker network create remnawave-network 2>/dev/null || true

# готовим Caddyfile под свой домен
cd /opt/rezeis/proxies/caddy           # путь, куда вы скопировали эту папку
cp Caddyfile.example Caddyfile
sed -i 's/REPLACE_WITH_YOUR_DOMAIN/panel.rezeis.com/g' Caddyfile

# поднимаем
docker compose up -d
docker compose logs -f
```

После этого:

```bash
cd /opt/rezeis/rezeis-admin
docker compose up -d
```

Открываем `https://panel.rezeis.com` — должна появиться форма логина в админку.

## Firewall (ufw, для примера)

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp           # SSH
ufw allow 443/tcp          # сама панель
ufw enable
```

Никаких других портов наружу не нужно. `80`, `8443`, `5432`, `6379`, `8000`,
`3000` — всё внутри docker-сети.

## Cloudflare proxy mode

С DNS-01 валидацией режим облачка не имеет значения для выпуска — он работает
через DNS API.

- **Grey cloud (DNS only)** — Caddy сам терминирует TLS, прямой путь до VPS.
  Достаточно для админки.
- **Orange cloud (Proxied)** — Cloudflare стоит спереди и сам терминирует TLS
  своим сертификатом. Дополнительная DDoS-защита, но требуется
  «Authenticated Origin Pull», иначе любой может зайти мимо CF на твой
  публичный IP.

## Ручная перезагрузка Caddy

```bash
docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```
