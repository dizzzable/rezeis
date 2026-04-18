# Режимы развертывания

## `docker-compose.yml`

Полный production-подобный стек в одном compose-файле. Поднимает `postgres`, `redis`, `rezeis-admin-api`, `rezeis-admin-worker`, `ruid-api`, `ruid-worker`, `rezeis-web`, `ruid-web`.

Исходники web-приложений теперь лежат внутри соответствующих сервисов: admin web в `rezeis-admin/web`, user web в `ruid/web`.

В связанном `.env.example` актуальная модель для dashboard/subscription - Telegram bootstrap плюс cookie session с production-default `RUID_SESSION_COOKIE_SECURE=true`.

Внешние порты:

- `3000:80` - `rezeis-web`
- `3001:80` - `ruid-web`
- `3100:3000` - `rezeis-admin-api`
- `8100:8000` - `ruid-api`

Соответствующий env template: `.env.example`.

Команда запуска:

```bash
docker compose -f docker-compose.yml up -d
```

## `docker-compose.dev.yml`

Локальный режим разработки с bind mounts и dev-командами внутри контейнеров. Поднимает те же сервисы, что и полный стек, но с открытыми портами базы и Redis и с командами разработки для Node.js и Python приложений. Frontend bind mounts направлены в `rezeis-admin/web` и `ruid/web`.

Текущий `ruid/web` больше не открывает user-specific страницы по `userId` / `telegramId` / `email` в query string, а для локального plain HTTP dev шаблон явно задает `RUID_SESSION_COOKIE_SECURE=false`, чтобы bootstrap cookie сохранялась в браузере.

Внешние порты:

- `3000:3000` - `rezeis-web`
- `3001:3001` - `ruid-web`
- `3100:3000` - `rezeis-admin-api`
- `5432:5432` - `postgres`
- `6379:6379` - `redis`
- `8100:8000` - `ruid-api`

Соответствующий env template: `.env.dev.example`.

Команда запуска:

```bash
docker compose -f docker-compose.dev.yml up -d
```

## `docker-compose.external.admin.yml`

Admin-side для split deployment. Поднимает `postgres`, `redis`, `rezeis-admin-api`, `rezeis-admin-worker`, `rezeis-web`. Этот compose-файл отвечает за admin API, admin worker, admin web из `rezeis-admin/web` и, при необходимости, собственные DB/Redis.

Внешние порты:

- `127.0.0.1:${REZEIS_ADMIN_API_PORT:-3100}:3000` - `rezeis-admin-api`
- `127.0.0.1:3000:80` - `rezeis-web`

Соответствующий env template: `.env.external.admin.example`.

Команда запуска:

```bash
docker compose -f docker-compose.external.admin.yml up -d
```

## `docker-compose.external.user.yml`

User-side для split deployment. Поднимает `redis`, `ruid-api`, `ruid-worker`, `ruid-web`. PostgreSQL здесь не нужен, но Redis остается обязательным, пока `ruid-worker` использует `REDIS_URL`. Web-часть собирается из `ruid/web` и по умолчанию проксирует same-origin запросы `/api/*` в `ruid-api`. Также именно user-side обычно несет bot-нагрузку: это подтверждается шаблоном `.env.external.user.example`, где присутствуют все `BOT_*` переменные и `TELEGRAM_ADMIN_CHAT_ID`.

Для текущего Telegram-first shell важно, чтобы `BOT_MINI_APP` вел на тот же публичный origin, который отдает `ruid-web`. Тогда Telegram WebApp передает raw `initData`, `POST /api/v1/auth/telegram/bootstrap` ставит opaque cookie session, а последующие `GET /api/v1/session` и `GET /api/v1/subscription` читаются уже из cookie.

В production/split deployment примеры рассчитаны на secure cookie: `RUID_SESSION_COOKIE_SECURE=true`, `RUID_SESSION_COOKIE_SAMESITE=lax`, `RUID_SESSION_COOKIE_DOMAIN=`. Заполняйте `RUID_SESSION_COOKIE_DOMAIN` только если cookie должна шариться между поддоменами одного registrable domain.

В локальной разработке по plain HTTP нужно явно держать `RUID_SESSION_COOKIE_SECURE=false`. Это не меняет deployment mode, а только позволяет браузеру принять bootstrap cookie на `http://localhost`.

Если `ruid-web` и `ruid-api` разнесены по разным origin через `VITE_RUID_API_URL`, на API стороне нужно разрешить credentialed CORS и подобрать cookie `domain`/`samesite` под такую схему. Без этого bootstrap может пройти, но browser session не будет переиспользоваться последующими запросами.

Внешние порты:

- `127.0.0.1:3001:80` - `ruid-web`
- `127.0.0.1:8100:8000` - `ruid-api`

Соответствующий env template: `.env.external.user.example`.

Команда запуска:

```bash
docker compose -f docker-compose.external.user.yml up -d
```

## Соответствие compose и env template

- `docker-compose.yml` -> `.env.example`
- `docker-compose.dev.yml` -> `.env.dev.example`
- `docker-compose.external.admin.yml` -> `.env.external.admin.example`
- `docker-compose.external.user.yml` -> `.env.external.user.example`

## Короткий smoke checklist

- Убедиться, что контейнеры в статусе `Up` и healthcheck не падает.
- Открыть admin web на порту `3000` в том режиме, где он поднимается.
- Открыть user web на порту `3001` в том режиме, где он поднимается.
- Проверить `http://127.0.0.1:${REZEIS_ADMIN_API_PORT:-3100}/api/health` для `rezeis-admin-api`, если используется admin-side compose.
- Проверить `http://127.0.0.1:8100/api/v1/health` для `ruid-api`, если используется full/dev/user-side compose.
- Для split deployment между VPS задавать `REZEIS_BASE_URL=https://admin.example.com` на user-side. `REZEIS_HOST` и `REZEIS_PORT` остаются запасным вариантом только для same-network topology.
