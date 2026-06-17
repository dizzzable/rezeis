# rezeis-admin — Конфигурация окружения и деплой

Справочник по каждой переменной `.env`, по тому какие значения должны
совпадать с reiwa, что обязательно для продакшена, и какой
`docker-compose.yml` использовать на одном VPS и на разных.

> Источник истины — `.env.example` (значения по умолчанию) и
> `src/common/config/env.schema.ts` (валидация при старте). Если значение
> не прошло валидацию, контейнер не стартует и пишет имя переменной в лог.

---

## 1. Как устроена конфигурация

- Контейнеры `rezeis` (API) и `rezeis-worker` читают **один и тот же `.env`**
  (через `env_file: .env` в `docker-compose.yml`).
- Часть переменных compose задаёт явно в блоке `environment:` — они
  **перекрывают** значения из `.env` (например `DATABASE_HOST=rezeis-db`,
  `NODE_ENV=production`, `RUID_PROCESS_ROLE`). Их в `.env` трогать не нужно.
- Пароли `DATABASE_PASSWORD` / `REDIS_PASSWORD` из `.env` используются
  **и приложением, и контейнерами `rezeis-db` / `rezeis-redis`** — поэтому
  их нужно задать ДО первого старта (иначе том БД создастся с одним
  паролем, а приложение пойдёт с другим).

---

## 2. Справочник переменных

Легенда: **Обяз.** — обязательна для запуска; **Прод** — рекомендованное
значение в продакшене; «—» — дефолт подходит.

### Приложение

| Переменная | Назначение | Обяз. | Прод |
|---|---|---|---|
| `REZEIS_DOMAIN` | Публичный домен админки (CORS/ссылки). | да | ваш домен, напр. `panel.example.com` |
| `REZEIS_HOST` | Интерфейс, на котором слушает API. | — | `0.0.0.0` (внутри docker) |
| `REZEIS_PORT` | Порт API. | — | `8000` |
| `REZEIS_LOCALES` | Доступные языки. | — | `ru,en` |
| `REZEIS_DEFAULT_LOCALE` | Язык по умолчанию. | — | `ru` |
| `REZEIS_CRYPT_KEY` | Ключ шифрования секретов в БД (мин. 32 символа). | **да** | свой, ≥32 симв., **секрет** |
| `API_DOCS_ENABLED` | Swagger на `/api/docs`. | — | `false` в проде |
| `ADMIN_CORS_ORIGINS` | Список доверенных origin (через запятую). В проде обязателен непустой. | прод | `https://panel.example.com` |
| `ADMIN_TRUST_PROXY` | Доверие к заголовкам reverse-proxy. | — | `loopback` за локальным прокси |

### Webhook (исходящие системные события + подпись)

| Переменная | Назначение | Обяз. | Прод |
|---|---|---|---|
| `WEBHOOK_ENABLED` | Включает доставку системных событий на внешний URL. | — | `false`, если нет внешнего приёмника |
| `WEBHOOK_URL` | Внешний приёмник событий (можно список через запятую). | если включено | URL вашего мониторинга |
| `WEBHOOK_SECRET_HEADER` | **64 alphanumeric** — HMAC-ключ. Подписывает И внешние вебхуки, И канал в reiwa (`X-Rezeis-Signature`). | для канала reiwa | свой 64-симв., **секрет** |

> `WEBHOOK_URL` (произвольный внешний endpoint) и `REIWA_URL` (адрес reiwa) —
> это **разные** вещи. Общий у них только секрет `WEBHOOK_SECRET_HEADER`.

### Remnawave

| Переменная | Назначение | Обяз. | Прод |
|---|---|---|---|
| `REMNAWAVE_HOST` | Хост панели Remnawave. Без точки → `http://host:port`; с точкой → `https://host`. | да | `remnawave` (одна сеть) или домен |
| `REMNAWAVE_PORT` | Порт (игнорируется для публичного домена). | — | `3000` |
| `REMNAWAVE_TOKEN` | Bearer-токен Remnawave API. | **да** | из панели Remnawave, **секрет** |
| `REMNAWAVE_WEBHOOK_SECRET` | Секрет для приёма вебхуков от Remnawave. | да | из Remnawave, **секрет** |
| `REMNAWAVE_CADDY_TOKEN` | Доп. заголовок, если Remnawave за Caddy-auth. | — | пусто |
| `REMNAWAVE_COOKIE` | Доп. cookie, если требуется. | — | пусто |

### База данных

| Переменная | Назначение | Обяз. | Прод |
|---|---|---|---|
| `DATABASE_HOST` | Хост БД. В compose перекрыт на `rezeis-db`. | — | `rezeis-db` |
| `DATABASE_PORT` | Порт БД. | — | `5432` |
| `DATABASE_NAME` | Имя БД. | — | `rezeis` |
| `DATABASE_USER` | Пользователь БД. | — | `rezeis` |
| `DATABASE_PASSWORD` | Пароль БД (общий с контейнером `rezeis-db`). | **да** | свой, **секрет**, задать до 1-го старта |
| `DATABASE_ECHO` / `DATABASE_ECHO_POOL` | Лог SQL/пула (отладка). | — | `false` |
| `DATABASE_POOL_SIZE` | Размер пула. Пусто → автоподбор по памяти. | — | пусто |
| `DATABASE_MAX_OVERFLOW` / `_POOL_TIMEOUT` / `_POOL_RECYCLE` | Параметры пула. | — | дефолты |

### Redis (брокер BullMQ)

| Переменная | Назначение | Обяз. | Прод |
|---|---|---|---|
| `REDIS_HOST` | Хост Redis. В compose перекрыт на `rezeis-redis`. | — | `rezeis-redis` |
| `REDIS_PORT` | Порт. | — | `6379` |
| `REDIS_NAME` | Номер логической БД. | — | `0` |
| `REDIS_PASSWORD` | Пароль Redis (общий с контейнером `rezeis-redis`). | **да** | свой, **секрет**, задать до 1-го старта |
| `REDIS_MAXMEMORY` | Лимит памяти Redis (читает **только compose**, не приложение). | — | `512mb`, на маленьком VPS меньше |

### Бэкапы

| Переменная | Назначение | Прод |
|---|---|---|
| `BACKUP_AUTO_ENABLED` | Автобэкап по расписанию. | `true` |
| `BACKUP_INTERVAL_HOURS` / `BACKUP_TIME` / `BACKUP_MAX_KEEP` | Период / время / сколько хранить. | дефолты |
| `BACKUP_COMPRESSION` / `BACKUP_INCLUDE_LOGS` | Сжатие / включать логи. | `true` / `false` |
| `BACKUP_LOCATION` | Папка бэкапов (в томе `rezeis-data`). | `/app/data/backups` |

> Доставка бэкапов в Telegram настраивается **в самой панели**
> (Настройки → Системные уведомления), а не через `.env`.

### Email (SMTP) — опционально

| Переменная | Назначение | Прод |
|---|---|---|
| `EMAIL_ENABLED` | Включить отправку писем (восстановление и т.п.). | `false`, если SMTP не нужен |
| `EMAIL_HOST` / `EMAIL_PORT` / `EMAIL_USERNAME` / `EMAIL_PASSWORD` | Параметры SMTP. | по вашему провайдеру |
| `EMAIL_FROM_ADDRESS` / `EMAIL_FROM_NAME` | Отправитель. | ваш адрес/имя |
| `EMAIL_USE_TLS` / `EMAIL_USE_SSL` | Транспорт. | `true` / `false` |

### Роль процесса

| Переменная | Назначение | Прод |
|---|---|---|
| `RUID_PROCESS_ROLE` | `api` — только HTTP, без `@Cron`; `worker` — только расписания, без HTTP; `all` — всё в одном. В compose задано по контейнерам. | в `.env` можно не трогать |

### Проверка обновлений — опционально

| Переменная | Назначение | Прод |
|---|---|---|
| `REZEIS_UPDATE_REPO` | Override GitHub-репо панели. **Уже захардкожен в коде** (`dizzzable/rezeis`), задавать НЕ нужно. | не задавать (только форкам) |
| `REZEIS_REIWA_UPDATE_REPO` | Override репо reiwa. Дефолт `dizzzable/reiwa` в коде. | не задавать |

### Интеграция с reiwa

| Переменная | Назначение | Обяз. | Прод |
|---|---|---|---|
| `REIWA_URL` | Базовый URL reiwa, куда панель шлёт вебхуки (`<REIWA_URL>/api/v1/webhooks/rezeis`): сброс кэша бота, уведомления, рассылки, метрики, версия. | для пушей | один VPS: `http://reiwa:5000`; разные: `https://app.example.com` |

### Web Push (VAPID) — опционально

| Переменная | Назначение | Прод |
|---|---|---|
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_CONTACT_EMAIL` | Браузерные push в кабинете. Генерируются `npx web-push generate-vapid-keys`. Пусто → push выключен. | по желанию |

---

## 3. Что должно совпадать между rezeis и reiwa

| rezeis (`.env`) | reiwa (`.env`) | Должны совпадать? | Зачем |
|---|---|---|---|
| `WEBHOOK_SECRET_HEADER` | `REZEIS_WEBHOOK_SECRET` | **ДА, идентично** | HMAC-подпись вебхуков admin→reiwa |
| `REIWA_URL` | `REIWA_DOMAIN` | согласованно (адрес одного и того же reiwa) | куда панель шлёт вебхуки |
| — (создаётся в панели) | `REZEIS_TOKEN` | токен из админки вставить в reiwa | Bearer-доступ reiwa→rezeis API |
| `REZEIS_DOMAIN` | `REZEIS_HOST` | согласованно (reiwa должен «видеть» rezeis) | reiwa тянет данные из rezeis |

> `REZEIS_TOKEN` — это **не статичный секрет**, а API-токен (JWT), который
> создаётся в админке rezeis (раздел API-токенов) и вставляется в reiwa.
> `REZEIS_INTERNAL_SHARED_SECRET` живёт **только в reiwa** и админке не нужен.
> Redis-пароли у проектов **разные** (у каждого свой Redis) — совпадать не должны.

---

## 4. Docker Compose: один VPS vs разные

### Один VPS (по умолчанию)

Всё в общей docker-сети `remnawave-network`, reiwa достукивается до rezeis
по имени контейнера `rezeis`.

```bash
# 0) общая сеть (если Remnawave не на этом VPS — создать один раз)
docker network create remnawave-network 2>/dev/null || true
# 1) reverse proxy: на одном VPS с reiwa — deploy/proxies/caddy-combined/
# 2) панель (готовый образ из GHCR, без сборки)
docker compose up -d            # поднимет rezeis + rezeis-worker + db + redis
```

`.env`: `REIWA_URL=http://reiwa:5000`, на стороне reiwa `REZEIS_HOST=rezeis`.

> Сборка из исходников (для разработки):
> `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.
> Прод-`docker-compose.yml` ссылается только на `image:`, поэтому установка на
> VPS — это чистый `docker compose pull` без исходников.

### Разные VPS (split)

Полный чеклист — в [`docs/split-vps-deployment.md`](./split-vps-deployment.md).
Кратко: на стороне reiwa `REZEIS_HOST=panel.example.com` (с точкой → https),
на стороне rezeis `REIWA_URL=https://app.example.com`, оба хоста за своим
reverse-proxy на `:443`.

### Обновление образов на VPS

```bash
cd /opt/rezeis
docker compose pull               # стянуть свежий образ из ghcr.io/dizzzable/rezeis
docker compose up -d              # пересоздать контейнеры на новом образе
```

`docker-compose.yml` ссылается на `image: ghcr.io/dizzzable/rezeis:latest`,
поэтому `docker compose pull` работает штатно (исходники на сервере не нужны).
Контейнер на старте сам прогоняет миграции (`docker-entrypoint.sh`). Если
обновился сам `docker-compose.yml` (редко) — перекачайте его тем же `curl`,
что и при установке, затем `pull` + `up -d`.

---

## 5. Сборка из исходников и `docker-compose.override.yml`

Прод-`docker-compose.yml` ссылается **только на готовый образ** (`image:`),
без `build:` — чтобы установка на VPS была чистым `docker compose pull` без
исходников. Для локальной сборки из исходников есть оверлей
`docker-compose.build.yml`:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

`docker-compose.override.yml` (gitignore-ится, нужен только локально)
**подхватывается автоматически** обычным `docker compose up -d` без `-f` —
в этом репозитории он публикует порт 8000 на loopback для отладки. На проде
он не нужен (наружу порт не публикуем, ходит reverse proxy).

## Анонимный чат поддержки (Phase 2–3)

Переменные на стороне rezeis (источник правды). Все имеют безопасные
значения по умолчанию — задавайте только для тонкой настройки.

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `SUPPORT_GUEST_TOKEN_TTL_HOURS` | `72` | Idle-TTL гостевого токена (часы). После простоя разговор нельзя возобновить. |
| `SUPPORT_ATTACHMENTS_DIR` | `data/support-attachments` | Каталог хранения вложений на диске (том `rezeis-data`). Раздаются только через permissioned/token-контроллер, не статикой. |
| `SUPPORT_ATTACHMENT_MAX_MB` | `10` | Лимит размера одного вложения (МБ, по декодированным байтам). |
| `SUPPORT_ATTACHMENT_MAX_PER_MSG` | `5` | Максимум вложений на одно сообщение. |

Гостевой токен хранится только как `sha256` (raw-токен живёт лишь в
httpOnly-cookie у посетителя). Вложения валидируются по allow-list
(png/jpeg/webp/pdf) + magic-byte sniff + лимиту размера. Закрытый тикет
уходит в архив (`CLOSED` + `archivedAt`); чтение архива и его вложений
требует право RBAC `support_tickets.archive` (засеяно в роли support и
operator). Captcha-проверка (Cloudflare Turnstile) выполняется на стороне
reiwa, см. её `environment.md`.
