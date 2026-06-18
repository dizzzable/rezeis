# Переменные окружения

## Назначение env-модели

В проекте переменные окружения разделены по шаблонам под конкретный режим запуска Docker Compose. Такой подход фиксирует, какие значения нужны для монолитного запуска, локальной разработки и split deployment, где admin-side и user-side поднимаются отдельно.

## Существующие env templates

### `.env.example`

Используется вместе с `docker-compose.yml` для полного production-подобного запуска всех сервисов в одном compose-файле. Шаблон содержит настройки базы данных, Redis, admin API, интеграции с Remnawave, bot-переменные, `TELEGRAM_ADMIN_CHAT_ID`, а также backend session-переменные `TELEGRAM_AUTH_MAX_AGE_SECONDS`, `RUID_SESSION_TTL_SECONDS`, `RUID_SESSION_COOKIE_*` и `RUID_BROWSER_ALLOWED_ORIGINS` для Telegram bootstrap + cookie session модели.

### `.env.dev.example`

Используется вместе с `docker-compose.dev.yml` для локальной разработки. Включает те же базовые переменные, что и полный запуск, и дополнительно содержит `APP_CRYPT_KEY`, внутренний блок `REZEIS_*` и тот же session-блок `TELEGRAM_AUTH_MAX_AGE_SECONDS`, `RUID_SESSION_TTL_SECONDS`, `RUID_SESSION_COOKIE_*`, `RUID_BROWSER_ALLOWED_ORIGINS`, но с явным `RUID_SESSION_COOKIE_SECURE=false` для plain HTTP разработки.

### `.env.external.admin.example`

Используется вместе с `docker-compose.external.admin.yml` для admin-side в split deployment. Содержит DB/Redis-параметры, `APP_CRYPT_KEY`, admin secrets, внутренние `REZEIS_*`, `REZEIS_ADMIN_API_PORT` и настройки Remnawave. Комментарий в шаблоне отдельно отмечает, что DB/Redis указываются здесь только если admin-side владеет этими сервисами.

### `.env.external.user.example`

Используется вместе с `docker-compose.external.user.yml` для user-side в split deployment. Содержит Redis-параметры, внутренние `REZEIS_*`, настройки Remnawave, bot-переменные, `TELEGRAM_ADMIN_CHAT_ID` и backend session-переменные `TELEGRAM_AUTH_MAX_AGE_SECONDS`, `RUID_SESSION_TTL_SECONDS`, `RUID_SESSION_COOKIE_*`, `RUID_BROWSER_ALLOWED_ORIGINS`. В шаблоне прямо указано, что bot обычно живет рядом с user service.

## Группы переменных

### `DATABASE_*`

Блок `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD` описывает подключение к PostgreSQL. Production `docker-compose.yml` требует явный `DATABASE_PASSWORD` из `.env` или shell и больше не содержит фиксированный пароль или фиксированный `DATABASE_URL`. Runtime и Prisma config строят DSN из split `DATABASE_*`; `DATABASE_URL` остается только backward-compatible override для внешних/ручных запусков и не нужен для нового production compose.

### `REDIS_*`

Блок `REDIS_HOST`, `REDIS_PORT`, `REDIS_NAME`, `REDIS_PASSWORD` задает подключение к Valkey (drop-in замена Redis, протокол совместим — переменные сохраняют префикс `REDIS_*`). Production `docker-compose.yml` требует явный `REDIS_PASSWORD` из `.env` или shell, передает его в `valkey-server --requirepass` и использует `REDISCLI_AUTH` для healthcheck без hardcoded пароля. `REDIS_URL` не нужен для нового production compose; если отдельный legacy компонент ожидает URL, он должен быть собран из тех же split `REDIS_*` значений.

### `ADMIN_CORS_ORIGINS`

`ADMIN_CORS_ORIGINS` задает comma-separated список trusted browser origins для credentialed CORS к `rezeis-admin`. Runtime нормализует значения до `scheme://host[:port]`, удаляет дубликаты и отклоняет `*`, не-HTTP(S) схемы, invalid URLs, embedded credentials, path, query и hash. В `NODE_ENV=production` переменная обязательна: если список пустой или не задан, backend завершит env validation до старта вместо отражения любого browser origin. Для same-origin deploy укажите публичный origin админки, например `https://admin.example.com`; для локальной разработки через Vite proxy переменную можно не задавать, потому что browser обращается к API same-origin через `/api` proxy.

### `APP_CRYPT_KEY`

`APP_CRYPT_KEY` используется для шифрования чувствительных значений, сохраненных из Admin Panel. Эта переменная есть в `.env.dev.example` и `.env.external.admin.example`. В `.env.example` и `.env.external.user.example` она отсутствует.

Отдельно важно: credentials платежных шлюзов не лежат в root `.env`. В шаблонах прямо сказано, что они настраиваются через Admin Panel и шифруются с помощью `APP_CRYPT_KEY`.

### `REZEIS_*`

Внутренний блок `REZEIS_BASE_URL`, `REZEIS_HOST`, `REZEIS_PORT`, `REZEIS_TOKEN`, `REZEIS_WEBHOOK_SECRET` используется для взаимодействия с admin-side. `REZEIS_BASE_URL` нужен для split deployment между разными VPS и поддерживает явный `https://...` URL. `REZEIS_HOST` и `REZEIS_PORT` остаются fallback-вариантом для same-network/Docker topology. Этот блок присутствует в `.env.dev.example`, `.env.external.admin.example` и `.env.external.user.example`. В `.env.example` используются `REZEIS_ADMIN_JWT_SECRET`, `REZEIS_ADMIN_INTERNAL_API_KEY`, а также fallback-пара `REZEIS_HOST`/`REZEIS_PORT` для single-stack запуска `ruid`.

### `REZEIS_ADMIN_SMTP_*`

Блок `REZEIS_ADMIN_SMTP_HOST`, `REZEIS_ADMIN_SMTP_PORT`, `REZEIS_ADMIN_SMTP_SECURE`, `REZEIS_ADMIN_SMTP_USER`, `REZEIS_ADMIN_SMTP_PASSWORD`, `REZEIS_ADMIN_SMTP_FROM_ADDRESS`, `REZEIS_ADMIN_SMTP_FROM_NAME`, `REZEIS_ADMIN_SMTP_REPLY_TO`, `REZEIS_ADMIN_SMTP_IDENTITY_DOMAIN`, `REZEIS_ADMIN_SMTP_TIMEOUT_MS` используется `rezeis-admin` для синхронной отправки кода подтверждения email для linked web account. `REZEIS_ADMIN_SMTP_TIMEOUT_MS` покрывает и фазу TCP/TLS-подключения, и последующие SMTP-команды. `REZEIS_ADMIN_SMTP_USER` и `REZEIS_ADMIN_SMTP_PASSWORD` можно оставлять пустыми только вместе, если SMTP-провайдер допускает relay без аутентификации; для authenticated SMTP обе переменные обязательны. `REZEIS_ADMIN_SMTP_IDENTITY_DOMAIN` опционален: если он не задан, `rezeis-admin` использует домен из `REZEIS_ADMIN_SMTP_FROM_ADDRESS` для `EHLO` и `Message-ID`. Whitespace-only значения для optional SMTP-полей нормализуются как unset. Эти переменные нужны только на admin-side, поэтому они добавлены в `.env.example`, `.env.dev.example` и `.env.external.admin.example`.

### `TELEGRAM_AUTH_MAX_AGE_SECONDS`

`TELEGRAM_AUTH_MAX_AGE_SECONDS` задает допустимый возраст Telegram `initData` для `POST /api/v1/auth/telegram/bootstrap`. Значение из backend defaults - `300` секунд. Переменная документируется в `.env.example`, `.env.dev.example` и `.env.external.user.example`.

### `RUID_SESSION_TTL_SECONDS` и `RUID_SESSION_COOKIE_*`

`RUID_SESSION_TTL_SECONDS` задает TTL opaque session, которую backend создает после успешного Telegram bootstrap. Блок `RUID_SESSION_COOKIE_NAME`, `RUID_SESSION_COOKIE_SECURE`, `RUID_SESSION_COOKIE_DOMAIN`, `RUID_SESSION_COOKIE_PATH`, `RUID_SESSION_COOKIE_SAMESITE` управляет cookie-параметрами этой session.

Для production-подобных шаблонов `.env.example` и `.env.external.user.example` пример должен оставаться secure-by-default: `RUID_SESSION_COOKIE_SECURE=true`, пустой `RUID_SESSION_COOKIE_DOMAIN` и `RUID_SESSION_COOKIE_SAMESITE=lax`, пока не нужна явная cross-subdomain схема.

Для локальной разработки в `.env.dev.example` нужен явный override `RUID_SESSION_COOKIE_SECURE=false`, иначе cookie не будет записываться браузером на plain HTTP origin вроде `http://localhost:3001`.

### `RUID_BROWSER_ALLOWED_ORIGINS`

`RUID_BROWSER_ALLOWED_ORIGINS` задает дополнительный comma-separated список trusted browser origins для credentialed CORS к `ruid-api`. Backend нормализует origins до схемы и host:port, объединяет их с `RUID_PUBLIC_WEB_URL`, а затем использует итоговый allowlist и для `CORSMiddleware`, и для проверки browser origin на `POST /api/v1/auth/telegram/bootstrap`.

Переменная нужна только когда `ruid-web` или другие доверенные browser clients работают с API cross-origin. Для same-origin deployment и для локальной Vite proxy-схемы ее можно оставлять пустой.

### `REZEIS_ADMIN_API_PORT`

`REZEIS_ADMIN_API_PORT` задает внешний host port для `rezeis-admin-api` в `docker-compose.external.admin.yml`. Это отделяет admin API от admin web и устраняет конфликт двух сервисов на порту `3000`.

### `REMNAWAVE_*`

Блок `REMNAWAVE_HOST`, `REMNAWAVE_PORT`, `REMNAWAVE_TOKEN`, `REMNAWAVE_WEBHOOK_SECRET`, `REMNAWAVE_CADDY_TOKEN`, `REMNAWAVE_COOKIE` описывает интеграцию с Remnawave API и webhook-проверкой. Этот блок присутствует во всех четырех шаблонах.

### `BOT_*`

Блок `BOT_TOKEN`, `BOT_SECRET_TOKEN`, `BOT_DEV_ID`, `BOT_SUPPORT_USERNAME`, `BOT_MINI_APP`, `BOT_RESET_WEBHOOK`, `BOT_DROP_PENDING_UPDATES`, `BOT_SETUP_COMMANDS`, `BOT_USE_BANNERS`, `BOT_SETUP_WEBHOOK` управляет Telegram-ботом и его webhook/runtime-поведением. Он есть в `.env.example`, `.env.dev.example` и `.env.external.user.example`. В текущем routed shell `BOT_MINI_APP` должен указывать на корень опубликованного `ruid-web`, а не на `/miniapp`, потому что web-клиент теперь получает raw Telegram `initData`, вызывает `POST /api/v1/auth/telegram/bootstrap` и дальше живет на cookie-backed session. Практически это означает, что `BOT_MINI_APP` должен совпадать с тем public origin, на который backend ставит session cookie. В `.env.external.admin.example` bot-переменных нет.

### `TELEGRAM_ADMIN_CHAT_ID`

`TELEGRAM_ADMIN_CHAT_ID` задается в шаблонах, где присутствует bot/user-side: `.env.example`, `.env.dev.example` и `.env.external.user.example`. В `.env.external.admin.example` этой переменной нет.

## Как выбирать шаблон

- Для полного запуска всех сервисов одним стеком используйте `.env.example`.
- Для локальной разработки используйте `.env.dev.example`.
- Для admin-side в split deployment используйте `.env.external.admin.example`.
- Для user-side в split deployment используйте `.env.external.user.example`.
