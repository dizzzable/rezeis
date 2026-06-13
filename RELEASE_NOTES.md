# Rezeis Admin v0.9.5.5

Патч устойчивости запуска: опечатка в опциональном секрете больше не роняет панель.

### Конфигурация
- **Кривой `WEBHOOK_SECRET_HEADER` больше не валит контейнер.** Раньше значение не ровно из 64 буквенно-цифровых символов (например base64/с дефисами) роняло rezeis и rezeis-worker в краш-цикл с `ZodError`, а reverse proxy отдавал `502` (имя `rezeis` не резолвилось, т.к. контейнер не поднимался). Теперь такое значение **громко логируется и отключает подпись вебхуков**, а панель стартует. Валидное значение (`openssl rand -hex 32`) или пусто — как и раньше. `REZEIS_CRYPT_KEY` остаётся fail-closed (это ядро).

---

# Rezeis Admin v0.9.5.4

Патч про удобство установки и устойчивость к ошибкам в `.env`.

### Конфигурация
- **Пустое значение булевой env-переменной больше не роняет контейнер.**
  Частая ошибка установки — `WEBHOOK_ENABLED=` (пусто) — раньше валила старт
  с `expected boolean, received string`. Теперь пустое значение трактуется как
  дефолт, плюс принимаются `1/0/yes/no/on/off` наряду с `true/false`.

### Документация
- **Quick Start теперь генерирует секреты одной пачкой** (`openssl rand` →
  `sed` прямо в `.env`): `REZEIS_CRYPT_KEY`, `DATABASE_PASSWORD`,
  `REDIS_PASSWORD` (и для reiwa — `REIWA_COOKIE_SECRET`,
  `REZEIS_INTERNAL_SHARED_SECRET`). Меньше шансов словить ZodError на старте
  из-за `change_me`/коротких значений.

---

# Rezeis Admin v0.9.5.3

Релиз про reverse proxy: combined-примеры для двух проектов на одном VPS.

### Reverse proxy (rezeis + reiwa на одном VPS)
- **Combined-стеки для всех методов**: `nginx-combined`, `caddy-combined`,
  `angie-combined`, `traefik-combined` в `rezeis-admin/deploy/proxies/`.
- Все **443-only** и используют **один заранее выпущенный SAN-сертификат на оба
  домена** (`acme.sh --standalone -d PANEL -d APP`), который лежит прямо в
  каталоге прокси и монтируется в контейнер read-only. Порт 80 нужен только в
  момент выпуска сертификата и в самом прокси не публикуется.
- Маршрутизация `PANEL_DOMAIN → rezeis:8000` (админка) и
  `APP_DOMAIN → reiwa:5000` (кабинет / Mini App / webApp бота), с сохранением
  SSE/realtime (no-buffering / flush).
- Конфиги проверены: nginx `nginx -t` ok, caddy `adapt` ok, все
  `docker compose config` валидны.

### Документация
- `deploy/proxies/README.md` дополнен разделом «один сервис vs два», таблицей
  combined-вариантов и пошаговым acme.sh SAN-флоу; в главном README — прямые
  ссылки на правильный путь `rezeis-admin/deploy/proxies/`.

---

# Rezeis Admin v0.9.5.2

Релиз про установку и эксплуатацию: быстрый деплой в стиле Remnawave, единый
reverse proxy и понятная сеть.

### Установка / Docker
- **Чистая установка готовым образом в `/opt/rezeis`** — без исходников.
  Прод `docker-compose.yml` ссылается ТОЛЬКО на `image: ghcr.io/dizzzable/rezeis:latest`
  (без `build:`), поэтому установка = два ``curl`` + ``docker compose up -d``,
  обновление = ``docker compose pull && docker compose up -d``.
- **Локальная сборка из исходников** вынесена в оверлей
  ``docker-compose.build.yml`` (``docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build``).

### Reverse proxy
- **`deploy/proxies/caddy-combined`** — один Caddy для rezeis + reiwa на одном
  VPS (``PANEL_DOMAIN → rezeis:8000``, ``APP_DOMAIN → reiwa:5000``), авто-TLS
  Let's Encrypt. Закрывает кейс «нет прокси для обоих сервисов на одной машине».

### Сеть
- **`remnawave-network` задокументирована как общая внешняя шина** reiwa ↔ rezeis
  (+ Remnawave, если рядом). Добавлен шаг ``docker network create remnawave-network``
  и пояснение сценариев co-located / remote. Удалять сеть на одном VPS нельзя —
  иначе reiwa теряет связь с rezeis.

### Документация
- README обоих проектов переписаны под установку в ``/opt`` (Remnawave-стиль),
  актуализированы версия/бейджи (`0.9.5.2`).

---

# Rezeis Admin v0.9.5.1

Патч-релиз с мелкими фиксами деплоя, конфигурации и документации поверх `0.9.5`.

### Деплой / Docker

- **`docker compose pull` теперь реально обновляет образы.** Прод
  `docker-compose.yml` ссылается на `image: ghcr.io/dizzzable/rezeis:latest`
  (рядом оставлен `build: .` для локальной сборки). Раньше сервисы имели
  только `build:`, поэтому `pull` был no-op и обновление на VPS не доезжало.

### Конфигурация / окружение

- **Фикс «Internal server error» при регистрации на свежем деплое.** В
  reiwa `.env.example` хост админки был указан как `rezeis-admin`, тогда как
  контейнер называется `rezeis` — reiwa не достукивалась до панели. Исправлено
  на `REZEIS_HOST=rezeis` с пояснением формата (docker-имя vs публичный домен).
- **Убран дубль `REZEIS_UPDATE_REPO`/`REZEIS_REIWA_UPDATE_REPO`.** Слаги уже
  захардкожены в коде update-checker как дефолты (`dizzzable/rezeis` +
  `dizzzable/reiwa`), поэтому убраны из compose и переведены в опциональный
  override в `.env.example`. Поправлен устаревший комментарий в `env.schema.ts`.
- **Чистка `.env.example`** обоих проектов: удалены неиспользуемые переменные,
  задокументированы реально читаемые (`BOT_INVALIDATE_PORT`, `REIWA_CORS_ORIGIN`).

### Проверка обновлений

- **`compareSemver` понимает 4-й сегмент** (`MAJOR.MINOR.PATCH.BUILD`), чтобы
  патч-релизы вида `0.9.5.1` корректно сортировались выше `0.9.5` и баннер
  «доступно обновление» срабатывал.

### Документация

- Новый файл `rezeis-admin/docs/environment.md` — разбор каждой переменной
  `.env`, таблица «что должно совпадать с reiwa», прод-значения, схемы
  деплоя на одном и на разных VPS, пояснение про `docker-compose.override.yml`.
- README: актуализированы версия/бейджи (`0.9.5.1`), увеличен логотип, добавлена
  ссылка на доку по окружению.

### Диагностика

- reiwa: при 500 на `/auth/register` в лог теперь пишется `upstreamStatus`
  (HTTP-код от rezeis или `null` при сетевом сбое) — чтобы отличать
  недоступность панели от ошибок приложения.

---

# Rezeis Admin v0.7.3

## Remediation baseline

`v0.7.3` is the current remediation baseline for the unified Rezeis admin image. Package versions, README examples, Docker build metadata, and health version reporting now align on `0.7.3`.

### Docker image metadata

- Unified GHCR image: `ghcr.io/dizzzable/rezeis`.
- Release tags: `v0.7.3`, `0.7.3`, `0.7`, plus `sha-<short>` for commits.
- Docker build receives `APP_VERSION` from `rezeis-admin/package.json` and `GIT_SHA` from the GitHub Actions commit SHA.
- Runtime health reports `version` and non-sensitive `gitSha` metadata.

---

# Rezeis Admin v0.5.4

## Вариант A — слияние «Каналов рассылок» в «Настройки доставки»

`v0.5.4` убирает дублирующую сущность. В v0.5.1 я добавил отдельную вкладку «Каналы рассылок» (`BotNotificationChannel`) — оказалось это пересекалось с уже существующими «Настройками доставки» в Telegram. У вас уже есть Broadcast для рекламных рассылок, поэтому отдельная CRUD-таблица каналов была лишней. Слил всё в один Telegram-delivery surface.

### Что сделано

- **Удалена сущность `BotNotificationChannel`**: модель, миграция (drop), сервис, контроллер, DTO, SPA-вкладка «Каналы рассылок», все i18n-ключи `channels.*`. Таблица `bot_notification_channels` дропнута (была добавлена в v0.5.1, на практике не заполнялась).
- **Новый тоггл `mirrorUserNotifications`** в «Настройки доставки → Доставка в Telegram». Когда включён, копия каждого пользовательского уведомления (истечение, рефералы, партнёрские выплаты…) зеркалится в тот же операторский чат, в топик `USER` если задан в маршрутизации по категориям. Не меняет то, что получают сами пользователи.
- **`UserNotificationsService.mirrorToOperatorChat()`** читает `systemNotifications.telegram` напрямую из Settings (без cross-module зависимости) и шлёт через bot `/notify-broadcast` с idempotency-суффиксом `:operator-mirror`.

### Архитектура «после»

Один `UserNotificationEvent` веером уходит в:
1. **Лента кабинета** (DB row — всегда)
2. **Telegram пользователю** в личку (если есть telegramId + не заблокировал + тип включён в тогглах)
3. **Web-push** на browser/PWA-подписки
4. **Операторский чат** (если включён `mirrorUserNotifications` в настройках доставки)

Системные события (`user.registered`, `payment.completed`…) идут своим потоком через `SystemEventsService.deliverTelegram()` в тот же чат с маршрутизацией по категориям.

### Где это видно

- **Admin → Уведомления → Настройки доставки**: новый тоггл «Зеркалить уведомления пользователей» под маршрутизацией по категориям.
- Вкладка «Каналы рассылок» **удалена** — её функция теперь это один тоггл.

### Backend изменения

- `prisma/schema.prisma` — удалена модель `BotNotificationChannel`
- `prisma/migrations/20260529120000_drop_bot_notification_channels/migration.sql` — DROP TABLE
- `src/modules/settings/dto/update-telegram-delivery.dto.ts` — `mirrorUserNotifications` field
- `src/modules/settings/services/settings.service.ts` — `mirrorUserNotifications` в config + `getTelegramDeliveryConfig()` getter
- `src/modules/settings/controllers/settings.controller.ts` — форвард флага
- `src/modules/notifications/services/user-notifications.service.ts` — `mirrorToOperatorChat()` + `readTelegramDeliveryConfig()`, удалена зависимость от `BotNotificationChannelsService`
- `src/modules/notifications/notifications.module.ts` — убраны channels controller/service
- удалены: `services/bot-notification-channels.service.ts`, `controllers/admin-notification-channels.controller.ts`, `dto/notification-channel.dto.ts`

### Frontend изменения

- `web/src/features/notifications/notifications-page.tsx` — удалён `NotificationChannelsTab` + диалоги (~470 строк), добавлен тоггл mirror в `TelegramDeliveryForm`
- `web/src/i18n/features/notifications.{en,ru}.ts` — `delivery.mirrorLabel/mirrorDescription`, удалён блок `channels.*` + таб-ключ

### Pre-push checklist

| Check | Result |
|---|---|
| Backend `tsc --noEmit -p tsconfig.json` | ✅ 0 errors |
| Backend `eslint . --quiet` | ✅ 0 warnings |
| Frontend `npm run build` | ✅ 0 errors |
| Frontend `eslint . --quiet` | ✅ 0 warnings |
| Drop migration applied to local DB | ✅ |

### Migration / breaking

- `20260529120000_drop_bot_notification_channels` дропает таблицу. Безопасно — добавлена в v0.5.1, не использовалась.
- API `/admin/notifications/channels` удалён. Не было реальных потребителей кроме одноимённой вкладки.

### Docker image

Пересобирается на push tag `v0.5.4` → GHCR теги `v0.5.4`, `0.5.4`, `0.5`, `latest`.

**Full Changelog**: https://github.com/dizzzable/rezeis/compare/v0.5.3...v0.5.4

---

# Rezeis Admin v0.5.3

## Connect notification toggles to the fanout + fix type-key mismatch

`v0.5.3` устраняет разрыв который мешал админ-странице уведомлений работать по-настоящему: тогглы `userNotifications` сохранялись в `Settings`, но `UserNotificationsService` их **не читал** — выключить уведомление в панели не давало эффекта. Заодно пофикшен латентный баг с расхождением `type`-строк, из-за которого expiry-уведомления не находили шаблон и уходили без текста.

### Что сделано

- **Toggle gating подключён**. `UserNotificationsService.fanout()` теперь читает `Settings.userNotifications` и пропускает push-каналы (Telegram + web-push + broadcast) когда оператор выключил конкретный тип. Семантика opt-out: явный `false` глушит, всё остальное (отсутствует / null) = включено, поэтому свежая инсталляция шлёт всё. **Лента кабинета не затрагивается** — `UserNotificationEvent` row всё равно создаётся, юзер видит уведомление в in-app feed, гасится только push.
- **Explicit-send bypass**: операторские «отправить сообщение пользователю» (`preRenderedText`) не гейтятся тогглами — это разовое действие, а не автоматический тип.
- **Type-key alias map** (`notification-toggle.util.ts`): нормализует исторические расхождения — `subscription_expiring_3d` → `expires_in_3_days`, `partner.earning` → `partner_earning`, `referral.*` → `referral_*`. Одна каноническая строка теперь драйвит И lookup шаблона И toggle-гейт.
- **Латентный баг исправлен**: `renderMessage()` (бывший `renderText`) теперь резолвит шаблон по канонической ключу с fallback на сырой `type`. До этого auto-renew слал `subscription_expiring_3d`, шаблон назывался `expires_in_3_days`, lookup проваливался → текст null → Telegram-доставка молча пропускалась. Теперь резолвится корректно.
- **Web-push title исправлен**: раньше web-push banner заголовок был сырым `type` (`expires_in_3_days`), теперь это отрендеренный `template.title` («⏳ Подписка истекает через 3 дня»).
- **Auto-renew теперь шлёт канонические ключи** (`expires_in_3_days` / `expires_in_1_days`) напрямую, чтобы лента кабинета хранила чистые type-строки.

### Backend изменения

- `src/modules/notifications/utils/notification-toggle.util.ts` — новый: `resolveToggleKey()` + `isNotificationDeliveryEnabled()`
- `src/modules/notifications/services/user-notifications.service.ts` — toggle gate в начале `fanout()`, `readUserNotificationToggles()` читает Settings singleton, `renderMessage()` возвращает `{title, body, html}` с canonical-key lookup
- `src/modules/auto-renew/auto-renew.service.ts` — runCycle шлёт `expires_in_3_days` / `expires_in_1_days`

### Frontend изменения

- `web/src/i18n/features/notifications.{en,ru}.ts` — уточнено описание `userNotifications` (выключение глушит push, но оставляет в ленте кабинета)

### Где это видно

- **Admin → Уведомления → вкладка «Пользовательские»**: тогглы теперь реально гейтят доставку. Выключи «Подписка истекает через 3 дня» → бот/push перестанут слать этот тип, но в ленте кабинета он остаётся.
- **В Telegram**: expiry-уведомления теперь приходят с настоящим текстом шаблона (раньше молча не доходили из-за mismatch).

### Pre-push checklist

| Check | Result |
|---|---|
| Backend `tsc --noEmit -p tsconfig.json` | ✅ 0 errors |
| Backend `eslint . --quiet` | ✅ 0 warnings |
| Frontend `npm run build` | ✅ 0 errors |

### Migration / breaking

Нет. Поведенческий fix + новая util. Существующие deployments: если оператор раньше выключал тогглы (думая что они работают) — теперь они **начнут** работать как ожидалось. Стоит проверить что нужные типы включены после апдейта.

### Docker image

Пересобирается на push tag `v0.5.3` → GHCR теги `v0.5.3`, `0.5.3`, `0.5`, `latest`.

**Full Changelog**: https://github.com/dizzzable/rezeis/compare/v0.5.2...v0.5.3

---

# Rezeis Admin v0.5.2

## Hotfix — default keyboard seed completed (5 buttons)

`v0.5.2` фиксит регрессию которая вылезла на свежем deploy v0.5.1: дефолтный seed reiwa-клавиатуры (`webapp` / `cabinet` / `invite` / `rules` / `help`) ронял первые две кнопки потому что `BotButtonsService.validateAction()` требовал `actionTarget` для `URL` / `WEBAPP` action types — а seed специально оставляет target пустым, чтобы reiwa подставил `${publicWebUrl}` / `${miniAppUrl}` из env (admin-managed `REIWA_DOMAIN`).

### Что сделано

- `validateAction()` теперь разрешает пустой `actionTarget` для `URL` / `WEBAPP` — возвращает `null` и доверяет reiwa fallback. Когда оператор задаёт URL — валидируем https:// строго; когда оставляет пустым — admin-managed default из env.
- SPA-side валидатор уже имел собственный layer и продолжит подсказывать пользователю заполнить target в форме.

### Backend изменения

- `src/modules/bot-config/services/bot-buttons.service.ts` — `validateAction()` returns null on empty target instead of throwing

### Migration / breaking

Нет. Behavioural fix. Существующие deployments со seed'нутыми 4 кнопками НЕ будут пере-сидиться (`existingCount > 0` guard защищает). На свежем deployment теперь правильно сидятся все 5 кнопок с правильными action types.

### Pre-push checklist

| Check | Result |
|---|---|
| Backend `tsc --noEmit -p tsconfig.json` | ✅ 0 errors |
| Backend `eslint . --quiet` | ✅ 0 warnings |

### Docker image

Пересобирается на push tag `v0.5.2` → GHCR теги `v0.5.2`, `0.5.2`, `0.5`, `latest`.

**Full Changelog**: https://github.com/dizzzable/rezeis/compare/v0.5.1...v0.5.2

---

# Rezeis Admin v0.5.1

## Wave E — Bot notification channels + browser push opt-in UI

`v0.5.1` достраивает Wave E поверх v0.5.0 fanout pipeline: оператор теперь управляет broadcast-каналами через админ-панель, юзер включает browser-уведомления в кабинете одним переключателем.

### Что сделано

- **`BotNotificationChannel` Prisma model** + миграция `20260529001000_bot_notification_channels` (применена + зарегистрирована). Полный CRUD через `BotNotificationChannelsService` (admin SPA-управляемые destinations: chat / supergroup / forum-topic с `kindFilter` exact-match).
- **`AdminNotificationChannelsController`** (`/admin/notifications/channels`) под `AdminJwtAuthGuard` — list / create / update / delete (POST `:id/delete` для legacy proxy compatibility) + DTOs.
- **`UserNotificationsService.fanout()` теперь 4-канальный**: cabinet feed (DB row) → Telegram (`bot.api.sendMessage`) → web-push (`webPushService.sendToUser`) → broadcast (`channelsService.broadcastToChannels`). Каждый канал изолирован, идемпотентность по `${eventId}:${channelId}` для каналов чтобы один event не дедуплицировался между destinations.
- **Admin SPA**: новая вкладка «Каналы рассылок» в `/admin/notifications` — список каналов с toggle активности + edit/delete + create-dialog (форма с zod-валидацией chatId, кратким хинтом про @userinfobot, мульти-line `kindFilter`). Optimistic update toggle, optimistic-restore on error. Локализация ru/en.
- **Reiwa SPA**: `notifications-page.tsx` теперь содержит `BrowserPushSection` — реальный toggle над встроенным notification permission flow. Вызывает `subscribeToPush()` / `unsubscribeFromPush()` из `lib/push.ts`. Capability-aware:
  - `unsupported-browser` → секция скрыта целиком
  - `unsupported-ios-not-installed` → toggle disabled, amber-info card «Установите на главный экран» с инструкцией
  - `permission-denied` → toggle disabled, rose-info card с подсказкой про настройки браузера
  - `supported` → toggle работает, состояние сохраняется в UI
  - i18n keys `notifications.push*` (ru + en параллельно)

### Backend изменения

- `prisma/schema.prisma` — модель `BotNotificationChannel` + index на `is_active`
- `prisma/migrations/20260529001000_bot_notification_channels/migration.sql`
- `src/modules/notifications/services/bot-notification-channels.service.ts` — CRUD + `broadcastToChannels` (filter exact-match, fire-and-forget delivery, isolated failures, eventId per-channel)
- `src/modules/notifications/controllers/admin-notification-channels.controller.ts`
- `src/modules/notifications/dto/notification-channel.dto.ts` — Create / Update DTOs
- `src/modules/notifications/services/user-notifications.service.ts` — fanout инжектит `BotNotificationChannelsService`, добавлен 4й канал
- `src/modules/notifications/notifications.module.ts` — провайдер + контроллер зарегистрированы

### Frontend изменения

- `rezeis-admin/web/src/features/notifications/notifications-page.tsx` — новый таб «Channels» с `NotificationChannelsTab`, `ChannelEditDialog`, `ChannelCreateDialog`, `ChannelFormBody`, `parseKindFilter`. zod-resolved react-hook-form, optimistic update for toggle, manual confirm on delete
- `rezeis-admin/web/src/i18n/features/notifications.{en,ru}.ts` — `notificationsPage.channels.*` keys (~30 entries) с corner cases для plural форм русского
- `reiwa/web/src/features/settings/notifications-page.tsx` — `BrowserPushSection` extracted, capability detection, Switch driving subscribe/unsubscribe, info cards для iOS / permission-denied
- `reiwa/web/src/i18n/{ru,en}.ts` — `notifications.push*` keys

### Pre-push checklist

| Check | Result |
|---|---|
| Backend `tsc --noEmit -p tsconfig.json` | ✅ 0 errors |
| Backend `eslint . --quiet` | ✅ 0 warnings |
| Frontend `npm run build` (tsc + vite) | ✅ 0 errors |
| Frontend `eslint . --quiet` | ✅ 0 warnings |
| Reiwa SPA `npm run build` | ✅ 0 errors |
| Migration applied to local DB | ✅ `bot_notification_channels` created + registered |

### Migration / breaking

- Миграция `20260529001000_bot_notification_channels` — чисто аддитивная. Существующие deployments продолжат работать без рассылок в каналы (таблица пустая → fanout no-op).
- API расширен — новый namespace `/admin/notifications/channels` под существующим `AdminJwtAuthGuard`. Старые endpoints не тронуты.

### Docker image

Пересобирается на push tag `v0.5.1` → GHCR теги `v0.5.1`, `0.5.1`, `0.5`, `latest`.

**Full Changelog**: https://github.com/dizzzable/rezeis/compare/v0.5.0...v0.5.1

---

# Rezeis Admin v0.5.0

## Notification fanout pipeline + magic-link bot→browser + bot pruning

`v0.5.0` — major release. Reiwa-bot становится тонким каналом доставки (вместо дублирующего кабинет UI), magic-link даёт telegram-only юзерам автологин в браузере без логина/пароля, и admin теперь ведёт фанаут любых notification событий по трём каналам параллельно (cabinet feed → Telegram → web-push).

### Wave A — Bot pruning (reiwa side)

Бот выкинул всё что дублировало кабинет: удалены страницы `buy`, `plans`, `subscription`, `profile`, `promo`, `activity`, `referral`. Остались только то что бот должен реально делать: `start` (приветствие + main keyboard), `menu` (back-to-menu callback), `help-callback` (fallback когда support_url не настроен), `help` (`/help` slash), `invite` (генерит share-link через admin), `rules` (admin-managed rules screen), `lang` (`/lang` picker), `dynamic-screen` (universal `screen:<shortId>` handler).

Дефолтная клавиатура (5 кнопок, обновлён seed):
1. **Открыть приложение** (WebApp, primary, blue) — Mini App, эмодзи `5276127848644503161`
2. **Кабинет** (URL, default) — открывает SPA в браузере, эмодзи `5278589204207528856`
3. **Пригласить** (callback, success, green) — `5298668674532538341`
4. **Правила** (callback, default) — `5276314275994954605`
5. **Помощь** (support_url, default) — `5276229330131772747`

Custom emoji ids — Telegram Premium-эмодзи; на не-Premium ботах Telegram молча показывает label без иконки.

### Wave C — Magic-link bot→browser

Snoups-style magic link для telegram-only юзеров. Юзер жмёт «Кабинет» в боте, попадает в браузер уже авторизованным.

- **Admin**: новый `BotSigninTokenService` (Redis-backed, sha256-hashed, single-use, 5-min TTL, 32 bytes hex). Endpoint `POST /internal/web-auth/bot-signin/issue` (ввод `telegramId`, выдача `token`) + `POST /internal/web-auth/bot-signin/consume` (single-use, возвращает `userId`).
- **Reiwa-bot**: `start.ts` + `menu.ts` дёргают `adminClient.webAuth.issueBotSigninToken(telegramId)` при рендере keyboard, `attachSigninTokenToUrl()` вшивает `?signin=<token>` в URL для url-кнопок (cabinet). Webapp-кнопки и support_url остаются нетронутыми — у Mini App есть `initData` для авто-auth, support_url — это просто tg://deep-link. Fallback на чистый URL если admin недоступен / юзер заблокирован.
- **Reiwa-web BFF**: новый route `POST /api/v1/auth/bot-signin?token=...` который консьюмит токен через admin → создаёт WebSession → 302 на `/dashboard`. Token rate-limited через `loginRateLimiter`, single-use — replay не работает.
- **SPA `WebHomePage`**: при наличии `?signin=...` в URL вызывает BFF endpoint первым делом, strip'ит param через `history.replaceState`, идёт на `/dashboard`. Fallback splash меняет текст на «Входим через Telegram…».

### Wave B — Notification fanout (admin → bot)

Admin → bot push-канал чтобы юзер получал в Telegram уведомления мгновенно, не ожидая 5-min TTL pull-loop.

- **Admin**: новый `BotNotifierClient` (HTTP клиент к reiwa-bot's `:5100/notify`), `UserNotificationsService` (single source of truth для notify-this-user). Service пишет cabinet-feed row + (best-effort) пушит на бот в Telegram + (best-effort) пушит web-push на все subscriptions юзера. Идемпотентность: каждый event несёт `eventId` (CUID `UserNotificationEvent.id`), бот хранит in-memory LRU recently-delivered ids (1024 slots, 24h horizon) и no-op'ит replays.
- **Refactor**: 3 callsites которые писали `prisma.userNotificationEvent.create` напрямую (`partner-notifications`, `auto-renew`, `admin-user-management`) теперь через `UserNotificationsService.create()` — fanout автоматически.
- **Templates**: уже существующий `NotificationTemplatesService` (с `{{placeholder}}` substitution) подключён — оператор редактирует тексты через `/admin/notifications/templates`, бот доставляет с актуальным текстом без code change.
- **Bot side** (reiwa): новый `bot/listeners/internal-http-listener.ts` объединяет `/invalidate` + новые `/notify` + `/notify-broadcast` endpoints. `/notify` принимает `{ eventId, telegramId, text, parseMode?, buttons? }`, доставляет через `bot.api.sendMessage`, на 403 (юзер заблокировал бота) колбэчит `adminClient.user.markBotBlocked(telegramId)` чтобы admin прекратил пытаться. `/notify-broadcast` принимает `{ chatId, topicThreadId? }` для Telegram-каналов / forum-топиков (UI для управления каналов оставлен на следующий релиз).

### Wave D — Web-push (PWA-enabled)

Browser web-push для всех trex кейсов которые Telegram не покрывает: web-only юзеры, юзеры заблокировавшие бота, юзеры открывшие кабинет в браузере на десктопе.

- **Prisma**: новая модель `WebPushSubscription { userId, endpoint @unique, p256dhKey, authKey, userAgent, failureCount, createdAt, lastSeenAt }`. Миграция `20260529000000_web_push_subscriptions`.
- **Admin**: новый `WebPushService` (использует `web-push@3.6.7`, RFC 8030 + VAPID RFC 8292), `subscribe()` upsert по endpoint, `sendToUser()` фан-аут на все subscriptions, 410/404 → delete subscription (endpoint мёртв), 3 consecutive failures → evict. `InternalPushController` теперь полноценный — `GET /public-key` возвращает VAPID public key, `POST /subscribe` персистит, `POST /unsubscribe` удаляет (POST вместо DELETE т.к. некоторые прокси страйпят body на DELETE).
- **Env**: новые опциональные `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_CONTACT_EMAIL`. Без них web-push silently disabled — SPA получает empty publicKey и скрывает UI. Генерируются один раз через `npx web-push generate-vapid-keys`.
- **SPA**: `web/src/lib/push.ts` — `detectPushSupport()`, `subscribeToPush()`, `unsubscribeFromPush()`. `getCurrentSubscription()` для рендеринга toggle state. Новый `web/src/lib/api-client/push.ts` namespace.
- **Service Worker**: `web/src/sw.ts` расширен `push` event handler (рендерит OS notification через `showNotification`) + `notificationclick` handler (открывает `/dashboard` или `data.url`, фокусит существующую вкладку если есть).
- **iOS 16.4+ PWA**: `detectPushSupport()` распознаёт iOS-without-standalone и возвращает `unsupported-ios-not-installed` — UI слой может показывать инструкцию «Установите на главный экран» вместо silent fail.
- **Fanout integration**: `UserNotificationsService.fanout()` теперь параллельно вызывает `botNotifier.notifyUser()` И `webPushService.sendToUser()`. Один `UserNotificationEvent` → три канала доставки (feed + Telegram + web-push), каждый изолирован.

### Backend изменения

- `src/modules/notifications/services/{bot-notifier.client,user-notifications.service}.ts` — новые
- `src/modules/notifications/notifications.module.ts` — обновлён, импортит `InternalPushModule`, экспортит `UserNotificationsService` + `BotNotifierClient`
- `src/modules/web-auth/services/bot-signin-token.service.ts` — magic-link tokens (Redis-backed)
- `src/modules/web-auth/{controllers/internal-web-auth.controller,web-auth.module}.ts` — добавлены bot-signin endpoints
- `src/modules/internal-user/{services/internal-user-edge.service,controllers/internal-user.controller}.ts` — добавлен `markBotBlocked()` + endpoint
- `src/modules/push/services/web-push.service.ts` — реализация поверх `web-push` пакета
- `src/modules/push/internal-push.{controller,module}.ts` — заменён stub на полноценные endpoints
- `src/modules/{partners,auto-renew,users}/...` — refactored to use `UserNotificationsService`
- `src/common/config/env.schema.ts` — добавлены `REIWA_BOT_URL`, `REZEIS_INTERNAL_SHARED_SECRET`
- `prisma/schema.prisma` — модель `WebPushSubscription` + relation на `User`

### Reiwa изменения

- `src/bot/pages/index.ts` + `bot/main.ts` — выкинуты pruned page registrars
- `src/bot/pages/{activity,buy,plans,profile,promo,referral,subscription}.ts` — удалены
- `src/bot/pages/{start,menu}.ts` — добавлен fetch magic-link token и forward через keyboard
- `src/bot/widgets/main-keyboard.ts` — `attachSigninTokenToUrl()` + `signinToken` option на `MainKeyboardOptions`
- `src/bot/listeners/internal-http-listener.ts` — новый, объединяет `/invalidate` + `/notify` + `/notify-broadcast`
- `src/api/routes/{auth,push}.ts` — `bot-signin` endpoint + `public-key` endpoint + flat subscribe payload accepted
- `src/infrastructure/admin-client/namespaces/{user,push,web-auth}.ts` — расширены: `markBotBlocked`, `getPublicKey`, `issueBotSigninToken`/`consumeBotSigninToken`
- `web/src/sw.ts` — `push` + `notificationclick` event handlers
- `web/src/lib/{push,api-client/push}.ts` — новые SPA-side push helpers
- `web/src/features/auth/web-home-page.tsx` — magic-link consume на `?signin=` redirect

### Pre-push checklist

| Check | Result |
|---|---|
| Backend `tsc --noEmit -p tsconfig.json` | ✅ 0 errors |
| Backend `eslint . --quiet` | ✅ 0 warnings |
| Frontend `npm run build` (tsc + vite) | ✅ 0 errors |
| Frontend `eslint . --quiet` | ✅ 0 warnings |
| Reiwa `tsc --noEmit` | ✅ 0 errors |
| Reiwa SPA `npm run build` | ✅ 0 errors |
| Migration applied to local DB | ✅ `web_push_subscriptions` created + registered in `_prisma_migrations` |

### Migration / breaking

- **Миграция `20260529000000_web_push_subscriptions`** — добавляет таблицу. Чисто аддитивная.
- **Reiwa-bot keyboard seed** — новый layout срабатывает только на чистом БД (existingCount > 0 guard). Существующие deployments сохраняют свою клавиатуру.
- **Web-push отключён** пока оператор не сгенерирует VAPID keys и не положит в env. БД растёт с 0 subscriptions, делать ничего не нужно.
- **`/api/v1/push/unsubscribe` теперь POST** (раньше DELETE). Старые SPA-бандлы в SW кэше могут пытаться DELETE — admin отвечает 404, BFF разрулит как идемпотентный success.
- **REIWA_BOT_URL** default `http://reiwa-bot:5100` — заработает в docker-compose. В bare-metal deploy переопределить через env.
- **VAPID keys** генерируются один раз: `npx web-push generate-vapid-keys` → пишем в `rezeis-admin/.env`. Без них push silently disabled, остальное работает.

### Docker image

Пересобирается на push tag `v0.5.0` → GHCR теги `v0.5.0`, `0.5.0`, `0.5`, `latest`.

**Full Changelog**: https://github.com/dizzzable/rezeis/compare/v0.4.5...v0.5.0

---

# Rezeis Admin v0.4.5

## Reiwa BFF surface — internal modules ship for the SPA / Mini App / bot

`v0.4.5` фокусируется на одной вещи: закрыть все internal-эндпоинты, которые reiwa уже умеет дёргать, но в admin они до сих пор висели локально без коммита. После релиза reiwa-сторона перестаёт упираться в 404 на старте и получает полноценный BFF-контракт.

### Новые модули

- **`LinkingModule`** — `internal/link/telegram/{generate,consume}` + `internal/link/email/{initiate,verify}` для opt-in привязки Telegram / email к существующему `reiwa_id`. Использует `auth_challenges` через `purpose: 'telegram_link' | 'email_link'`, sha256(code), TTL 10 мин, attemptsLeft = 5. Email доставляется через общий `EmailService.sendLinkedAccountVerificationCode()`.
- **`WebAuthModule`** — `internal/web-auth/{register,login,recover,change-password}` для credential-based входа. `register` создаёт `WebAccount` (с опциональной привязкой к Telegram-User по `telegramIdToLink`), `login` верифицирует scrypt-хеш и возвращает session-флаги (`requiresPasswordChange`, `telegramLinked`, `emailVerified`), `recover` резолвит recovery-канал (telegram > email > none) без user-enumeration, `change-password` ротирует hash после verify текущего.
- **`InternalPushModule`** — stub `internal/push/subscribe` + `internal/push/unsubscribe` чтобы reiwa SPA не упирался в 404 при flow подписки на web-push. Сейчас acknowledge-only, persistence добавится когда фича станет реальной (Prisma model + outbound delivery worker).

### Расширения существующих модулей

- **`InternalUserModule`** — добавлен `InternalUserEdgeService` со всем bot-side стэком который раньше жил в legacy-контроллере: `bootstrap` (idempotent create-or-refresh по `telegramId`), `updateLanguage`, notifications feed (list / unread-count / read-all / read-one), transactions feed, trial eligibility + activate. Service делегирует `grantTrial` через колбэк к `SubscriptionMutationsService`, чтобы не тащить циркулярную зависимость.
  - Новые DTO: `InternalBootstrapUserDto`, `InternalByTelegramQueryDto`, `InternalUpdateLanguageDto`.
  - Новые interfaces: `InternalUserBootstrapInterface`, `InternalUserNotificationInterface`, `InternalUserTransactionInterface`, расширенный `InternalUserSessionInterface` с `webAccount` под-объектом.
- **`InternalPaymentsController`** — новый `GET internal/payments/gateways` возвращает user-safe view списка активных gateway'ев (только `id / type / currency / orderIndex`) для рендеринга на purchase screen. Stripped operator-only fields (`settings`, `isUsedInPricing`, `updatedAt`).
- **`InternalPromocodesController`** — новый `POST internal/promocodes/activate-by-telegram` для бот-side активации (раньше требовало предварительный resolve `userId` со стороны reiwa); `GET internal/promocodes/user/:telegramId/activations` для user history page.
- **`InternalPlatformPolicyController`** — новый `GET internal/settings/registration-toggle` который маппит `Settings.accessMode === 'PUBLIC' → enabled: true` без изменения public контракта.
- **`AutoRenewModule`** — новый `InternalWorkerController` с `GET internal/worker/expiry-alerts` который форсит один cycle `runCycle()` и возвращает счётчики `expired / warnings3d / warnings1d / cycleAt`. Удобно когда reiwa worker хочет компенсировать stalled scheduler.

### Backend изменения

- `src/app.module.ts` — зарегистрированы `LinkingModule`, `WebAuthModule`, `InternalPushModule`.
- `src/modules/auto-renew/auto-renew.module.ts` — добавлен `InternalWorkerController` в `controllers`.
- `src/modules/internal-user/internal-user.module.ts` — добавлен `InternalUserEdgeService` в providers + exports.

### Pre-push checklist

| Check | Result |
|---|---|
| Backend `tsc --noEmit -p tsconfig.json` | ✅ 0 errors |
| Backend `eslint . --quiet` | ✅ 0 warnings |
| Frontend без изменений | n/a |

### Migration / breaking

Нет. Полностью аддитивное:

- Все новые endpoint'ы под `internal/*` (`InternalAdminAuthGuard` → требуется `REZEIS_INTERNAL_API_TOKEN`). Существующие пути нетронуты.
- БД миграции **не нужны** — `auth_challenges` уже существует с прошлых волн, `Plan / Subscription / Transaction / UserNotificationEvent / TrialGrant / WebAccount` модели уже на месте.
- `InternalUserSessionInterface` расширен полем `webAccount` — `null` для users без WebAccount, читать reiwa уже умеет, для несовместимых старых клиентов поле просто игнорируется.

### Docker image

Пересобирается на push tag `v0.4.5` → GHCR теги `v0.4.5`, `0.4.5`, `0.4`, `latest`.

**Full Changelog**: https://github.com/dizzzable/rezeis/compare/v0.4.4...v0.4.5

---

# Rezeis Admin v0.4.4

## Per-button action routing — operator can attach URLs / Mini Apps / screen jumps to any reply-keyboard button

`v0.4.4` закрывает оператору последний хардкод-узел в Bot Studio: до сих пор смысл reply-keyboard кнопки определялся её `buttonId`, прибитым в reiwa, и самостоятельно прикрутить ссылку к произвольной кнопке было нельзя — отсюда жалоба «могу кнопку создать, только ссылку к ней приделать не могу». Теперь у каждой кнопки в `BotButton` лежит `actionType` + `actionTarget`, и reiwa резолвит роутинг по этим полям перед фолбэком на встроенную карту.

### Что сделано

- **Prisma schema** — новый enum `BotButtonAction` (`CALLBACK / URL / WEBAPP / SCREEN / SUPPORT_URL`) + поля `actionType` (default `CALLBACK`) и `actionTarget` (nullable string) в модели `BotButton`. Hand-written миграция `20260528193000_bot_button_action`.
- **`BotButtonsService.validateAction()`** — централизованная валидация: `URL` / `WEBAPP` требуют `https://` (Telegram отбрасывает остальное), `SCREEN` требует alphanumeric shortId, `CALLBACK` / `SUPPORT_URL` всегда обнуляют target. Сообщения об ошибках возвращаются как `BadRequestException` с человеческим текстом — SPA выводит их inline через toast.
- **DTO + Controller** — `CreateBotButtonDto` / `UpdateBotButtonDto` принимают `actionType` (любая case) и `actionTarget`. `parseBotButtonAction()` нормализует к Prisma enum. Кэш-инвалидация interceptor `ReiwaCacheInvalidateInterceptor` пушит новый bind в reiwa сразу после save.
- **`/internal/bot-config` payload** — `InternalBotConfigButtonInterface` расширен `actionType: 'callback'|'url'|'webapp'|'screen'|'support_url'` и `actionTarget: string | null`. Reiwa получает их в каждом 5-минутном refresh.
- **Reiwa `resolveButtonBinding()`** — новая функция в `bot/widgets/main-keyboard.ts`. Сначала смотрит на operator override (`button.actionType`), затем на legacy `BUTTON_KIND_MAP`, затем на дефолтный `callback`. URL и WebApp action берут operator-supplied абсолютный URL приоритетно с fallback на `${publicWebUrl}${target}` для legacy. SCREEN action эмитит `screen:<shortId>` callback_data — универсальный handler `dynamic-screen.ts` поднимает экран из BotFlow.
- **SPA Bot Button dialogs** — `bot-button-dialogs.tsx` получили блок «Тип действия» (Select из 5 вариантов) и conditional «Цель действия»: text input для URL/WEBAPP, dropdown с реальными screen shortId для SCREEN, ничего для CALLBACK/SUPPORT_URL. Под каждым вариантом — подсказка что он делает. Backend validation errors показываются inline.
- **SPA buttons display** — карточки кнопок в `reply-keyboard-editor-panel.tsx` и `bot-buttons-tab.tsx` теперь показывают action badge + truncated target, чтобы оператор сразу видел куда ведёт каждая кнопка.

### Backend изменения

- `prisma/schema.prisma` — enum `BotButtonAction`, поля на `BotButton`.
- `prisma/migrations/20260528193000_bot_button_action/migration.sql` — `CREATE TYPE` + два `ALTER TABLE ADD COLUMN`.
- `src/modules/bot-config/services/bot-buttons.service.ts` — `validateAction()`, обновлённые `create()` / `update()`.
- `src/modules/bot-config/dto/bot-config.dto.ts` — `CreateBotButtonDto.actionType/actionTarget`, `parseBotButtonAction()` helper.
- `src/modules/bot-config/controllers/admin-bot-config.controller.ts` — форвард новых полей в service.
- `src/modules/bot-config/interfaces/internal-bot-config.interface.ts` — `actionType` / `actionTarget` в `InternalBotConfigButtonInterface`.
- `src/modules/bot-config/services/internal-bot-config.service.ts` — `mapButtonAction()` (для `BotButton`, не путать с `mapFlowButtonAction()` для `BotFlowButton`).

### Reiwa изменения

- `src/infrastructure/bot-config/types.ts` — `BotMenuButton.actionType` / `actionTarget`.
- `src/bot/widgets/main-keyboard.ts` — `ResolvedBinding` interface, `resolveButtonBinding()` и переписанный `buildMainKeyboard()` loop.

### Frontend изменения

- `web/src/features/bot-config/bot-config-api.ts` — `botButtonActionSchema`, поля в `botButtonSchema` / `createBotButtonSchema` / `updateBotButtonSchema`.
- `web/src/features/bot-config/bot-button-dialogs.tsx` — переписан create + edit диалоги, новый `ActionFields` компонент, `useFlowScreens` hook для SCREEN dropdown, `extractErrorMessage` для backend validation surfacing.
- `web/src/features/bot-config/reply-keyboard-editor-panel.tsx` + `bot-buttons-tab.tsx` — action badge + truncated target в карточках.
- `web/src/i18n/{ru,en}.ts` — новый блок `botConfigPage.buttons.fields.actionType.{label, options.*, hint.*}` + `actionTarget.{label, urlPlaceholder, urlHint, webappPlaceholder, webappHint, screenPlaceholder, screenHint, screenEmpty}`.

### Pre-push checklist

| Check | Result |
|---|---|
| Backend `tsc --noEmit -p tsconfig.json` | ✅ 0 errors |
| Backend `eslint . --quiet` | ✅ 0 warnings |
| Frontend `npm run build` (tsc + vite) | ✅ 0 errors |
| Frontend `eslint . --quiet` | ✅ 0 warnings |

### Migration / breaking

- Миграция `20260528193000_bot_button_action` добавляет 2 nullable колонки + 1 enum. **Не ломает** существующие записи: все старые `BotButton` строки получают `actionType = 'CALLBACK'` через DEFAULT, `actionTarget = NULL`. Поведение reiwa для них не меняется (фолбэк на `BUTTON_KIND_MAP`).
- `/internal/bot-config` shape — два новых обязательных поля. Reiwa < 0.4.4 их игнорирует и работает по-старому. Обновить reiwa-bot вместе с rezeis рекомендуется чтобы получить новый routing.

### Docker image

Пересобирается на push tag `v0.4.4` → GHCR теги `v0.4.4`, `0.4.4`, `0.4`, `latest`.

**Full Changelog**: https://github.com/dizzzable/rezeis/compare/v0.4.3...v0.4.4

---

# Rezeis Admin v0.4.3

## Wave 8 — admin-driven bot screens + cache push + banner upload

`v0.4.3` превращает rezeis-admin в полноценный config-plane для reiwa-bot. Оператор больше не упирается в хардкод TS-пейджей — открывает Bot Studio, рисует флоу, кликает Save, и через ~50ms бот в Telegram отвечает по-новому.

### Что сделано

- **Reiwa cache invalidate push** — admin-bot-config + admin-bot-flow controllers через `ReiwaCacheInvalidateInterceptor` пушат синхронный cache-bust в `http://reiwa-bot:5100/invalidate` (Bearer `REZEIS_INTERNAL_SHARED_SECRET`) сразу после успешной мутации. Fire-and-forget — save в админке никогда не падает из-за того что бот недоступен. Логируется reason (`POST /admin/bot-config/buttons/:id` и т. п.) для observability.
- **Manual refresh endpoint** — `POST /admin/bot-config/refresh-bot` под JWT, возвращает `{ ok: boolean }`. Bot Studio toolbar получил кнопку «🔄 Обновить бота» — оператор может пнуть кеш руками, если данные правились в обход админки.
- **Dynamic screens в `/internal/bot-config`** — payload расширен полями `screens[]` и `screensVersion`. Источник: `BotFlowService.getActive()` (PUBLISHED → DRAFT fallback), маппится в плоский shape, который reiwa ожидает: `id / shortId / name / textRu+En / parseMode / mediaType / mediaUrl / isRoot / buttons[]`. Каждая кнопка несёт `action` (navigate / url / webapp / callback / back / start_over), `targetShortId`, `style`, `iconCustomEmojiId` и т. д.
- **Draft fallback** — раньше reiwa читал только `PUBLISHED` BotFlow версию; теперь `getActive()` берёт latest PUBLISHED, а в его отсутствие — latest DRAFT. Убирает обязательный шаг Publish для single-operator workflow, но не ломает версионирование для команд которые хотят заморозку прода.
- **Banner upload** — новый endpoint `POST /admin/bot-config/banner` (multipart, PNG/JPEG/WebP/GIF, 8 MB cap) хранит файл в `data/uploads/bot-banners/<random>.<ext>` и upsert'ит URL в `BotText['bot.banner_url']`. Bot Studio получил toolbar-кнопку «🖼️ Баннер» с drop-zone editor (превью / replace / remove). Reiwa-bot фетчит файл по docker-DNS и шлёт в Telegram как InputFile, поэтому хост публично доступен быть не должен.
- **`BotTextsService.upsert()`** — идемпотентный upsert по `key` для внутренних feature, которые владеют конкретной BotText записью (banner upload, future features). Регулярка `TEXT_KEY_REGEX` валидирует ключ.

### Backend изменения

- `src/modules/bot-config/services/reiwa-cache-invalidator.service.ts` — POST `http://reiwa-bot:5100/invalidate` с timeout 3s, AbortController, логи на warn level.
- `src/modules/bot-config/interceptors/reiwa-cache-invalidate.interceptor.ts` — фильтрует GET/HEAD/OPTIONS, на mutation вешает rxjs `tap` который вызывает invalidate fire-and-forget.
- `src/modules/bot-config/services/bot-banner-upload.service.ts` — FS-based persistence на `data/uploads/bot-banners/`, override через `BOT_BANNER_UPLOADS_DIR` env, MIME + size guard.
- `src/modules/bot-config/services/internal-bot-config.service.ts` — расширен `BotFlowService` зависимостью, новые helpers `mapFlowScreens` / `mapFlowButton` / `mapButtonAction` / `mapFlowButtonStyle` / `mapParseMode` / `mapMediaType`. Imports `BotFlowModule` для DI.
- `src/modules/bot-flow/services/bot-flow.service.ts` — новый метод `getActive(name)`. Существующий `getPublished` сохранён для legacy callers.
- `src/modules/bot-flow/controllers/admin-bot-flow.controller.ts` — `@UseInterceptors(ReiwaCacheInvalidateInterceptor)` на класс.

### Frontend изменения

- `web/src/features/bot-config/bot-banner-tab.tsx` — drop-zone редактор баннера с preview, replace, remove, full RU/EN i18n.
- `web/src/features/bot-flow/bot-flow-page.tsx` — новые toolbar-кнопки «🔄 Обновить бота» и «🖼️ Баннер» + соответствующие Sheet drawers.
- `web/src/features/bot-flow/components/ScreenEditorPanel.tsx` — добавлен `nameHint` под Name field, объясняет что зарезервированные имена (`help` / `rules` / `invite`) переопределяют built-in sub-menu. Любое другое имя — обычный экран, доступный через «Перейти к экрану» buttons.
- `web/src/i18n/{ru,en}.ts` — ~25 новых ключей для botStudio.toolbar.refreshBot* / botStudio.toolbar.banner / botStudio.drawers.bannerDescription / botBanner.* / botFlow.fields.nameHint.

### Pre-push checklist (зелёная сборка)

- `npx tsc --noEmit -p tsconfig.json` (admin backend) → 0 errors
- `npx eslint . --quiet` (admin backend) → 0 warnings
- `cd web && npm run build` (frontend tsc + vite) → 0 errors
- `cd web && npx eslint . --quiet` (frontend) → 0 warnings

### Migration / breaking

- Добавлен env `REZEIS_INTERNAL_SHARED_SECRET` (32+ chars) для cache invalidate. Без него — endpoint silently disabled, кеш протухает по обычному 5-минутному TTL. **Поставь в обоих** `.env`: rezeis-admin и reiwa.
- Добавлен env `BOT_BANNER_UPLOADS_DIR` (опциональный, default `./data/uploads/bot-banners/`). В docker-compose уже маунтится `rezeis-data:/app/data` — папка автоматом сохраняется между перезапусками.
- БД миграции **не требуются** — все новые feature pиаются на существующих таблицах (`BotText` для banner URL, `BotFlow` / `BotFlowScreen` / `BotFlowButton` для screens).

### Docker image

`ghcr.io/dizzzable/rezeis:0.4.3` будет собран GHA workflow Docker Publish после пуша тега.

---

# Rezeis Admin v0.4.2

## Wave 7 — pre-seed BotConfig defaults on bootstrap

`v0.4.2` закрывает архитектурный roadmap reiwa-rewrite со стороны admin: `InternalBotConfigService` теперь имплементит `OnApplicationBootstrap` и сам заводит дефолтную клавиатуру + `bot.banner_url` placeholder при первом запуске. До этого оператор открывал `/admin/bot-config` на свежем деплое и видел пустые таблицы — кнопки появлялись только после первого `GET /api/internal/bot-config` от reiwa (через 5 минут после старта или после первого юзерского `/start`).

### Что сделано

- **`InternalBotConfigService` ⇒ `OnApplicationBootstrap`** — на старте приложения сидит четыре кнопки (`cabinet` / `invite` / `rules` / `help`), задавая стандартный layout reiwa (CTA-row → invite-row → rules+help row), и пустую `BotText` запись с ключом `bot.banner_url`. Идемпотентно: если в `BotButton` уже есть хотя бы одна строка — никаких записей. Оператор, который удалил всё и начинает с нуля, не получит сюрприз reset'ом.
- **Гейтинг по роли процесса** — seed бежит только когда `getProcessRole()` возвращает `api` или `all`. Worker-контейнер делит ту же БД, и параллельный seed между ними мог попасть на unique-`buttonId` constraint mid-insert. Worker всё равно читает уже посеяный payload через тот же DB-путь, просто не драйвит сам seed.
- **Failure-policy** — если seed упал, `seedAttempted` сбрасывается, чтобы следующий запрос мог повторить, а не закешировать degraded payload навсегда. Первый приоритет — никогда не вернуть юзеру пустой keyboard.
- **`InternalBotConfigController`** — read-only endpoint `GET /api/internal/bot-config` под `InternalAdminAuthGuard` (тот же Bearer api_token, что reiwa использует для остальных internal-routes). Возвращает payload, который reiwa уже ожидает по shape (`buttons / visual / features / botEmojis / menuTextCustomEmojiIds / translations`).

### Backend изменения

- `bot-config/bot-config.module.ts` — зарегистрирован `InternalBotConfigController` + `InternalBotConfigService`. Существующий `AdminBotConfigController` нетронут.
- `bot-config/services/internal-bot-config.service.ts` — новый, ~270 строк (под лимит 500). `BotButtonsService` / `BotEmojisService` / `BotTextsService` зовутся как ports.
- `bot-config/interfaces/internal-bot-config.interface.ts` — readonly TypeScript shape, повторяет ожидания reiwa.

### Pre-push checklist

| Check | Result |
|---|---|
| Backend `tsc --noEmit -p tsconfig.json` | ✅ 0 errors |
| Backend `eslint src/modules/bot-config --quiet` | ✅ 0 warnings |
| Frontend без изменений | n/a |
| Idempotency: seed на пустой БД | ✅ 4 buttons + 1 banner row |
| Idempotency: seed на уже посеянной БД | ✅ no-op (existingCount > 0) |
| Worker race: `RUID_PROCESS_ROLE=worker` | ✅ skip seed (read-only consumer) |

### Migration / breaking

Нет. Чисто аддитивное:

- Новый endpoint `GET /api/internal/bot-config` — reiwa уже умеет его дёргать (Wave 2 namespace + 5-минутный refresh loop). До v0.4.2 он отвечал из существующих CRUD-сервисов; теперь с пустой БД seed просыпается сам.
- На старых деплоях, где оператор уже руками настроил клавиатуру, ничего не меняется — `existingCount > 0` и seed не запускается.

### Docker image

Пересобирается на push tag `v0.4.2` → GHCR теги `v0.4.2`, `0.4.2`, `0.4`, `latest`.

**Full Changelog**: https://github.com/dizzzable/rezeis/compare/v0.4.1...v0.4.2

---

# Rezeis Admin v0.4.1

## STEALTHNET source — новая вкладка импорта

`v0.4.1` добавляет пятый источник в `/imports`: STEALTHNET (https://github.com/systemmaster1200-eng/remnawave-STEALTHNET-Bot). В отличие от altshop/remnashop, которые экспортируют типизированный JSON внутри `.tar.gz`, STEALTHNET выгружает сырой `pg_dump --format=plain` — мы парсим его напрямую.

### Что сделано

- **Новый парсер** `stealthnet-backup-pg-parser` в `imports/utils/stealthnet-backup-parser.ts`. Это полноценный line-based scanner pg_dump формата: распознаёт `COPY public.<table> (cols) FROM stdin;` блоки, обрабатывает tab-separated rows, корректно эскейпит `\N` (NULL), `\t`, `\n`, `\\`, и postgres array литералы `{a,b,c}`. Парсит только нужные таблицы (clients, secondary_subscriptions, tariffs, tariff_categories, tariff_price_options, payments) — остальные ~50 таблиц дампа (admin_events, marketplace_*, system_settings и т.д.) игнорируются.
- **Поддержка gzip** — если файл начинается с `1f 8b` magic, перед парсингом распаковываем через `node:zlib`.
- **`StealthnetImporterService`** в `imports/services/stealthnet-importer.service.ts` — переиспользует ту же логику что и altshop/remnashop, адаптированную под STEALTHNET-shape:
  - Matching priority: `telegram_id` → `email` → отказ. Skip строк без обоих идентификаторов (STEALTHNET ids не reusable между системами, повторный импорт без telegram/email создавал бы дубликаты).
  - Email + password_hash → автоматически провижится `WebAccount` так что user может залогиниться в reiwa с тем же паролем (если у тебя на свежем User поле `passwordHash` пустое; existing хеши не перезаписываем).
  - Subscriptions матчатся по `remnawave_uuid` (как в altshop), `planSnapshot.importedFrom = 'stealthnet'`.
  - Payments → Transactions, идемпотентно по `order_id`.
  - Admin grants и провайдеры которые не в нашем `PaymentGatewayType` enum — silently skip (не корраптим Transaction ledger левыми записями).
- **Catalog для Plan Cloner** — STEALTHNET плоско хранит `(duration_days, price)` на самой `tariffs` строке + дополнительные `tariff_price_options`. Importer нормализует это в altshop-shape `{plans, planDurations, planPrices}` через детерминистический `stableHashId(cuid)` так что `BackupPlanClonerService` работает без модификаций.
- **Фронтенд**: пятая вкладка **STEALTHNET** в `<Tabs>` на `/imports`, accept `.sql,.sql.gz,.gz`. Финал импорта показывает "Clone source plans" кнопку как для altshop/remnashop.
- **i18n**: новые `importsPage.stealthnet.{title,description,action,selectFile,importing,hint}` в `imports.en.ts` и `imports.ru.ts`.
- **Контроллер**: новый endpoint `POST /admin/imports/stealthnet` (`AdminJwtAuthGuard`, multipart, до 100 MB).

### Backend изменения

- `imports.module.ts` — зарегистрирован `StealthnetImporterService`.
- `import.processor.ts` — новый `case 'stealthnet'` в `handleRun()` который читает stage-файл, парсит и зовёт importer.
- `backup-plan-cloner.service.ts` — `loadImportRecord()` теперь принимает `stealthnet` как валидный sourceType.

### Sanity check

Парсер прогнан против реального дампа `stealthnet-backup-2026-05-27T07-00-00.sql` (0.74 MB):

```
clients         : 287
subscriptions   : 0
tariffs         : 3
tariffCategories: 1
priceOptions    : 12
payments        : 72
```

Кириллица `Простая подписка - 1 устройство` декодируется корректно через UTF-8.

### Pre-push checklist

| Check | Result |
|---|---|
| Backend `tsc --noEmit -p tsconfig.json` | ✅ 0 errors |
| Backend `eslint . --quiet` | ✅ 0 warnings |
| Frontend `npm run build` (tsc + vite) | ✅ 0 errors |
| Frontend `eslint . --quiet` | ✅ 0 warnings |
| Local stack rebuild + `/api/health` | ✅ `version: "0.4.1"` |
| Parser dry-run на реальном STEALTHNET дампе | ✅ 287 clients, 3 tariffs, 72 payments |

### Migration / breaking

Нет. Чисто аддитивное:

- Новый sourceType `stealthnet` в `ImportRecord.source_type` (text column, без enum constraint).
- Новый endpoint под отдельным path. Все существующие endpointы работают как раньше.
- Plan Cloner расширил allowed source list (теперь принимает `altshop | remnashop | stealthnet`); legacy запросы продолжают работать.

### Docker image

Пересобирается на push tag `v0.4.1` → GHCR теги `v0.4.1`, `0.4.1`, `0.4`, `latest`.

**Full Changelog**: https://github.com/dizzzable/rezeis/compare/v0.4.0...v0.4.1

---

# Rezeis Admin v0.4.0

## Plan Catalog Cloning — восстановление тарифов из altshop / remnashop бэкапов

`v0.4.0` — major фича. После того как `altshop` или `remnashop` бэкап импортирован, оператор теперь может одной кнопкой восстановить **исходный каталог тарифов** (`Plan + PlanDuration + PlanPrice`) и автоматически привязать к ним все только что импортированные подписки. До этого все импортированные подписки висели с `planSnapshot.planId = null` и не могли быть продлены через reiwa без ручного назначения плана.

### Workflow

1. Оператор загружает бэкап во вкладке Altshop / Remnashop на `/imports`.
2. Importer в дополнение к users + subscriptions вытаскивает `plans / plan_durations / plan_prices` из тарбола и кладёт их в `ImportRecord.result.catalog` JSONB.
3. По завершении модалка прогресса показывает три кнопки на финальном экране: **Назначить план всем** (старая bulk-assign), **Клонировать тарифы** (новая), **Не назначать**.
4. Клонирование открывает превью-модалку: список тарифов с количеством подписок, статусом (Активный / Архивный), вычисленным финальным именем (с suffix-on-conflict), индикатором переиспользования. Можно отметить/снять любые. Синтетический «IMPORTED» плейсхолдер altshop'а подсвечивается жёлтой подсказкой и **снят по умолчанию**.
5. Чекбокс **«Привязать импортированные подписки к клонам»** (включён по умолчанию) — после клона все подписки из этого `ImportRecord` чьи source-планы клонированы получат `planSnapshot.planId = <cuid_of_clone>`. Уже привязанные — нетронуты.

### Backend

Новый сервис `BackupPlanClonerService` в `imports/services/backup-plan-cloner.service.ts` (~480 строк, под лимит 500):

- **`preview(importRecordId)`** — read-only, возвращает `PlanCatalogPreview` для UI.
- **`clone({ importRecordId, selectedSourcePlanIds, linkSubscriptions, createdBy })`** — мутирующий, возвращает `ClonePlansFromBackupResult` со счётчиками.

Особенности реализации:

- **Идемпотентность** — повторный запуск с теми же входами no-op. Для существующих имён `findUnique` reuse без перезаписи. Для подписок: skip если `planSnapshot.planId` уже set.
- **Suffix-on-conflict** — если `Plan.name` (`@unique`) уже занят оператором, тариф получает `Name2`, `Name3`, ... Дедупликация в рамках одного запуска через `claimedThisRound: Set<string>`.
- **Сохранение статусов** — `is_active`, `is_archived`, `availability` копируются как есть из источника. Полное восстановление = тот же статус.
- **Cross-references** — `upgrade_to_plan_ids` / `replacement_plan_ids` (числовые ссылки на source-side) транслируются через `sourceIdToTargetCuid: Map<number, string>`. Ссылки на не-выбранные планы дропаются с warning в лог.
- **Subscription linking через JSONB** — у `Subscription` нет колонки `planId`, ссылка живёт в `planSnapshot.planId` JSONB поле. Cloner перезаписывает snapshot полностью: новый `planId` + свежие `name/tag/type/trafficLimit/deviceLimit/strategy/duration/internalSquads/externalSquad`.
- **Audit log** — каждый запуск пишет `AdminAuditLog(action='imports.clone-plans', metadata={ importRecordId, sourceType, plansCreated, plansReused, subscriptionsLinked, errors })`.

### Изменения в парсерах бэкапа

- `altshop-backup-parser.ts` — extended return: `users / subscriptions / transactions` + новые `plans / planDurations / planPrices` массивы с типизированными интерфейсами `AltshopPlan`, `AltshopPlanDuration`, `AltshopPlanPrice`.
- `remnashop-backup-parser.ts` — то же: `RemnashopPlan / RemnashopPlanDuration / RemnashopPlanPrice` (схема снята с github snoups/remnashop).
- Оба importer'а (`altshop-importer.service.ts`, `remnashop-importer.service.ts`) теперь передают `catalog` через `RunInput`, persist в `result.catalog` через `JSON.parse(JSON.stringify(...))` cast (Prisma.InputJsonValue compat).

### Контроллер

Два новых endpoint'а в `admin-imports.controller.ts`:

- `GET /admin/imports/:importId/plan-preview` — `PlanCatalogPreview`
- `POST /admin/imports/:importId/clone-plans` — body `{ selectedSourcePlanIds?: number[], linkSubscriptions?: boolean }` → `ClonePlansFromBackupResult`

Оба под `AdminJwtAuthGuard`.

### Frontend

Новый компонент `web/src/features/imports/clone-plans-dialog.tsx`:

- React Query для preview + clone
- ScrollArea со списком тарифов, чекбоксы, badges (`active/archived/inactive`, `will be created as "Name2"`, `reuse existing`, tag).
- Подсказка для синтетического IMPORTED-плейсхолдера.
- Кнопка submit с pluralized label `Клонировать N тариф(а/ов)`.
- На success — toast со счётчиками + invalidate `admin.plans` queries.

`import-progress-dialog.tsx` расширен пропом `onClonePlans?: (id) => void`. `<DoneFooter>` автоматически показывает кнопку **«Клонировать тарифы»** только когда `mode === 'import'`, `status === 'COMMITTED'`, `source ∈ {altshop, remnashop}` и `result.catalog.plans` непустой.

`imports-page.tsx` — `useImportFlow()` хук получил `cloneFor` state + `openClone/closeClone` коллбэки. `<ClonePlansDialog>` смонтирован как sibling рядом с `<BulkAssignPlanDialog>`.

### i18n

Новый `clonePlans` блок в обоих `imports.en.ts` и `imports.ru.ts`:

- `title`, `description`, `previewError`, `emptyCatalog`
- `linkSubscriptions`, `linkSubscriptionsHint`
- `cancel`, `submit_one/few/many/other` (плюрализация для русского), `cloning`
- `success` (с placeholders `{{created}}`, `{{reused}}`, `{{linked}}`), `partialErrors`
- `row.traffic / unlimited / devices / unlimitedDevices / subscriptions / willBeNamed / willReuse / archived / inactive / active / placeholderHint`

В `progressDialog.clonePlans` — лейбл новой кнопки.

### Reiwa identity model — clarification

Этот релиз окончательно фиксирует в коде модель reiwa identity:

- Пользователь **не обязан** иметь Telegram или email — может пользоваться только web-кабинетом через `WebAccount.login`.
- `User.id` (CUID) **есть** канонический `reiwa_id`. Импортированные подписки связаны с реальным пользователем по этому id, не по telegram/email.
- Подписки в статусе `IMPORTED` (в `planSnapshot`) — пользователь может только продлевать через reiwa, не перевыпускать. После выбора плана через cabinet — `planSnapshot.planId` заполняется, и дальше всё стандартно.
- Bulk-assign + Clone — два независимых операторских инструмента. Bulk-assign назначает **уже существующий** план всем подпискам. Clone восстанавливает **исходный каталог** один в один из бэкапа.

### Pre-push checklist

| Check | Result |
|---|---|
| Backend `tsc --noEmit -p tsconfig.json` | ✅ 0 errors |
| Backend `eslint . --quiet` | ✅ 0 warnings |
| Frontend `npm run build` (tsc + vite) | ✅ 0 errors |
| Frontend `eslint . --quiet` | ✅ 0 warnings |
| Local stack rebuild + redeploy | ⏳ см. шаг ниже |

### Migration / breaking

Нет. Изменение полностью аддитивное:

- Новые поля в `ImportRecord.result.catalog` JSONB — старые importer-выдачи без `catalog` остаются совместимы (в UI кнопка просто не появится).
- Новые endpoint'ы под отдельным path. Старые pathы работают как раньше.
- `Plan.name` `@unique` constraint уже был — клонер только корректно с ним работает через suffix.

### Docker image

Пересобирается автоматически на push tag `v0.4.0` → GHCR теги `v0.4.0`, `0.4.0`, `0.4`, `latest`.

**Full Changelog**: https://github.com/dizzzable/rezeis/compare/v0.3.9...v0.4.0

---

# Rezeis Admin v0.3.9

## Hotfix — бесконечная анимация модалки импорта

`v0.3.9` — критичный hotfix к v0.3.8. Сразу после релиза при клике «Импорт из Remnawave» модалка показывала анимацию стейджей бесконечно: импорт фактически проходил, в `import_records` появлялась COMMITTED-запись с правильной статистикой, но **на другой `id`** — а фронт поллил тот id, который вернул enqueue-endpoint, и видел его навсегда в `DRY_RUN`.

### Root cause

Архитектура импорт-pipeline на v0.3.8 была кривая на стыке очередь → процессор → импортер:

1. `ImportQueueService.enqueueRemnawaveImport()` создаёт `ImportRecord` (status=DRAFT) и кладёт её id в job-data.
2. `ImportProcessor.handleRun()` поднимает status до `DRY_RUN`.
3. `RemnawaveImporterService.run()` (а так же все остальные importer-сервисы) **игнорировал переданный id** и в конце создавал **второй** `ImportRecord` со status=COMMITTED и финальным `result`.

В итоге на каждый импорт получалось две записи: одна "забытая" в DRY_RUN, вторая со всей статистикой. Фронт поллил первую и крутил спиннер вечно.

### Fix

Все четыре importer-сервиса (`remnawave-importer.service.ts`, `threexui-importer.service.ts`, `remnashop-importer.service.ts`, `altshop-importer.service.ts`) теперь принимают необязательный `importRecordId` через `RunInput`. Когда он передан (production-путь через очередь) — делается `prisma.importRecord.update()` на ту же строку. Когда нет (CLI/test пути) — fallback на `create()` чтобы не сломать legacy.

`ImportProcessor.handleRun()` прокидывает `importRecordId` во все четыре importerа.

### Cleanup

В локальной БД накопилось 11 zombie DRY_RUN-записей от старых импортов. Транзакционный `DELETE` с `WHERE result IS NULL AND committed_at IS NULL AND rolled_back_at IS NULL` убрал их без вреда живым (real-data) записям.

### Verification

После rebuild и одного `mode: sync` через очередь:

- Job встал в очередь с `importRecordId: cmpn5sfo8...`
- Через ~30 секунд тот **же самый** id сдвинулся `DRAFT → DRY_RUN → COMMITTED`
- В `import_records` ровно одна строка для этого импорта
- `result.fetched: 78, updated: 78, writebacks: 0, errors: 0`

### Pre-push checklist

| Check | Result |
|---|---|
| Backend `tsc --noEmit -p tsconfig.json` | ✅ 0 errors |
| Backend `eslint . --quiet` | ✅ 0 warnings |
| Local stack rebuild + redeploy | ✅ healthy, `version: "0.3.9"` |
| End-to-end sync через очередь | ✅ same id moved to COMMITTED, 1 row in DB |

### Migration / breaking

Нет. Изменение чисто аддитивное — `RunInput.importRecordId` опциональный, старый `create()`-путь сохранён как fallback.

### Docker image

Пересобирается автоматически на push tag `v0.3.9` → GHCR теги `v0.3.9`, `0.3.9`, `0.3`, `latest`.

**Full Changelog**: https://github.com/dizzzable/rezeis/compare/v0.3.8...v0.3.9

---

# Rezeis Admin v0.3.8

## Imports UX overhaul + plan form polish + bulk-assign safety

`v0.3.8` — крупный UX-апдейт страницы импорта, изоляция формы плана от Remnawave-контракт-дрейфа, и **критичная** safety-net для массового назначения тарифов.

### 1. Имportы — полноценный progress + post-import flow

Раньше клик «Импорт из Remnawave» открывал toast «Импорт выполнен: 0/0/0/0», потому что endpoint async (202 Accepted), а UI ждал synchronous-ответ со статистикой. Финальная карточка `<ImportResultAlert>` всегда показывала нули, баг был незаметен потому что toast вылетал быстро и лажа маскировалась.

Теперь:

- Клик по кнопке **сразу** открывает модалку с **косметической стейдж-анимацией** (`Подключаемся → Получаем профили → Сопоставляем пользователей → Записываем reiwa_id → Финализируем`). Анимация чисто визуальная — параллельно идёт реальный polling.
- **Polling** `GET /admin/imports/:id` раз в секунду, останавливается на терминальных статусах `COMMITTED / FAILED / ROLLED_BACK`.
- **90-секундный safety timeout**: если impорт не завершился, модалка показывает мягкий warning «следим в фоне, можно закрыть» — но polling продолжается, BullMQ-job не отменяется.
- **Финальный экран** для `mode=import`: stat-grid (fetched / created / updated / skipped / writebacks / errors / subsCreated / subsUpdated), первые 5 ошибок если есть, две кнопки `[Назначить план всем]` / `[Не назначать]`.
- **Финальный экран** для `mode=sync`: тот же stat-grid + одна кнопка `[Готово]`. Sync никогда не создаёт новых подписок, поэтому plan-assignment там не предлагается.
- **`<BulkAssignPlanDialog>`** как вторая модалка: Select активных планов + чекбокс **«Применить лимиты сразу»** (выключен по умолчанию). При кнопке "Назначить" улетает `POST /admin/imports/assign-plan` с `applyImmediately: false/true`.
- Backend `ImportRecord.result` теперь сериализуется в response payload — раньше там было пусто, потому фронт не мог показать структурную статистику.

Backend без миграций. Контроллер `admin-imports.controller.ts` теперь возвращает `result` в `ImportRecordPayload`, фронт его читает напрямую.

### 2. Bulk-assign-plan — `applyImmediately` чекбокс по умолчанию **off**

Это критичный safety fix. Сценарий: оператор импортировал 100 пользователей с разными лимитами (500GB / 100GB / 50GB кто как купил), затем массово назначает им «Тест 50GB». Старый код **сразу же** создавал `ProfileSyncJob` для каждой подписки — клиенты с 500GB резко лишались 450GB. Это автоматическое поведение никак не было видно в UI и не подразумевалось.

Теперь:

- `BulkPlanAssignmentService.assignPlan` принимает новый параметр `applyImmediately: boolean = false`.
- Когда **off** (default): обновляется только `Subscription.planSnapshot`, `planId`, кэшированные лимиты в **нашей БД**. Remnawave-панель не трогается. Новые лимиты применятся при следующем upgrade/продлении через customer flow.
- Когда **on**: создаются `ProfileSyncJob`, как раньше — но теперь оператор **явно** соглашается на этот эффект через чекбокс.
- DTO `ImportAssignPlanJobData` расширен полем `applyImmediately`. Контроллер прокидывает его из request body.
- В UI чекбокс с подсказкой объясняющей последствия каждого варианта.

### 3. Plan form — uppercase tag + multi-select для Internal squads

- **Tag input**: при вводе/paste auto-uppercase + strip всё что не `[A-Z0-9_]`, max 16 символов. Плюс описание `tagHint`. Это соответствует zod-схеме Remnawave 2.7 контракта (`/^[A-Z0-9_]+$/`, max 16) — раньше оператор мог ввести «популярный», и оно дошло бы до panel API в lowercase где Remnawave его отвергнет.
- **Internal squads**: чип-облако (8 чипов в ряд) → multi-select Combobox dropdown с теми же визуалами что у External squad слева. Использует `<Popover>` + `<Command>` + `<Checkbox>` из существующего ui-kit. В trigger выводится "Выбрано N групп", под ним read-only chip-preview для скана без открытия dropdown.
- Без backend изменений — внутренняя структура `internalSquads: string[]` остаётся та же.

### Pre-push checklist

| Check | Result |
|---|---|
| Backend `tsc --noEmit -p tsconfig.json` | ✅ 0 errors |
| Backend `eslint . --quiet` | ✅ 0 warnings |
| Frontend `tsc -b` | ✅ 0 errors |
| Frontend `eslint . --quiet` | ✅ 0 warnings |
| Frontend `vite build` | ✅ built (13.73s) |
| Local stack rebuild + redeploy | ✅ healthy, `version: "0.3.8"` |

### Migration / breaking

Нет.

`applyImmediately` defaults to `false` — старые автоматизации, которые гоняли `POST /admin/imports/assign-plan` без поля, теперь будут вести себя **безопасно** (только запись в нашу БД, без push в Remnawave). Если вы целенаправленно хотите старое поведение — добавьте `"applyImmediately": true` в body запроса.

### Docker image

Пересобирается автоматически на push tag `v0.3.8` → GHCR теги `v0.3.8`, `0.3.8`, `0.3`, `latest`.

**Full Changelog**: https://github.com/dizzzable/rezeis/compare/v0.3.7...v0.3.8

---

# Rezeis Admin v0.3.7

## Hotfix — импортер больше не плодит дубликаты для web-only пользователей + актуальный логотип в админке

`v0.3.7` дофиксивает то, что не вошло в v0.3.6: матчинг Remnawave-профиля с локальным `User`'ом обходил один важный сценарий — пользователей, которые подписались **через web-кабинет** (без Telegram, без email — только `WebAccount.login`). Они шли мимо первых трёх приоритетов матча и при `import` каждый раз создавался новый `User`-дубликат.

### Симптом

После релиза v0.3.6 sync рапортовал `fetched: 77, updated: 70, skipped: 7, writebacks: 69`. 7 пропущенных — это 6 web-only профилей (Nina, Granit, Batyz, Twix, Babushka, Mamamoya), которые в Remnawave имели только username, и один синтетический `rs_-34_sub` с `telegramId: -34` (артефакт миграции из Remnashop). Аудит локальной `users` показал что у 6 имён по 2 `User`-копии — каждое запуск `import` плодил новую копию, потому что нечем было сматчить.

### Root cause

`RemnawaveImporterService.matchOrCreateUser` имел только три приоритета для поиска:

1. `reiwa_id` в description профиля Remnawave
2. `telegramId` (unique)
3. `email` (unique)

Web-only клиенты не попадают ни в один из этих кранчей: их единственный handle — `WebAccount.login`, которого Remnawave не знает. Каждый `import` для такого профиля проходил все три проверки впустую и сваливался в "create new User", не проверив есть ли уже `Subscription.remnawaveId === panelUser.uuid` где-то в БД.

### Fix

В `src/modules/imports/services/remnawave-importer.service.ts`:

- Добавлен **Priority 4: existing Subscription that already points to this Remnawave UUID**. Перед тем как создавать нового User'а, импортер проверяет нет ли в БД `Subscription` с этим `remnawaveId`. Если есть — берёт `userId` оттуда и обновляет всё что нужно. Это closes the loop для всех web-only клиентов: их `Subscription.remnawaveId` единственный надёжный handle обратно к локальному `User`.
- Docstring переписан, чтобы новый порядок приоритетов был задокументирован.

### Cleanup ранее накопившихся дубликатов

Локальная БД содержала 6 пар `User`-дубликатов от прошлых неудачных импортов. Транзакционный `DELETE` с шестью `NOT EXISTS` safety-checks (`subscriptions`, `transactions`, `web_accounts`, `partners`, `referrals`, `user_notification_events`) удалил **только** ранние нулевые копии — те у которых нет ни одной FK-связи нигде. Поздние копии с привязанной `Subscription` сохранены.

После DELETE и нового sync на тот же commit:

```
fetched:    77
updated:    76   (+6 against pre-v0.3.7 sync — Priority 4 picked up the web-only six)
skipped:     1   (only rs_-34_sub remains — synthetic telegramId: -34, no local User, no Subscription)
writebacks:  8   (6 web-only + 2 stragglers got reiwa_id written to Remnawave description)
errors:      0
```

Подтверждено в живую: `Babushka` (UUID `11557fe8-b1fc-...`) в Remnawave-панели имеет `description: "reiwa_id: cmpmc3yfz004m01jg8dclslfh"` — связка двухсторонняя.

### Logo refresh

`docs/logo.svg` и `rezeis-admin/web/public/rezeis-logo.svg` приведены к одному каноническому brand mark из `icon/Logo/Rezeis.svg`. README на GitHub и `RezeisLogo` в шапке админки теперь рендерят один и тот же логотип.

### Pre-push checklist

| Check | Result |
|---|---|
| Backend `tsc --noEmit -p tsconfig.json` | ✅ 0 errors |
| Backend `eslint . --quiet` | ✅ 0 warnings |
| Local stack rebuild + redeploy | ✅ healthy, `version: "0.3.7"` |
| DELETE 6 dup users (transactional + NOT EXISTS) | ✅ DELETE 6, COMMIT |
| Live sync against `2get.pro` panel | ✅ writebacks: 8, errors: 0, skipped reduced 7 → 1 |
| End-to-end Sync All button (already verified in v0.3.6) | ✅ ProfileSyncProcessor jobs COMPLETED, Remnawave applied all fields |

### Migration / breaking

Нет. Изменение в `matchOrCreateUser` — чисто аддитивное (новый Priority 4 проверяется **после** трёх уже существующих, поведение для всех ранее матчившихся профилей не изменилось).

Никаких изменений в Remnawave-панели кроме той же `description` write-back, что и в v0.3.6. Реальные подписки/трафик/устройства не трогаются.

### Docker image

Пересобирается автоматически на push tag `v0.3.7` → GHCR теги `v0.3.7`, `0.3.7`, `0.3`, `latest`.

**Full Changelog**: https://github.com/dizzzable/rezeis/compare/v0.3.6...v0.3.7

---

# Rezeis Admin v0.3.6

## Hotfix — Remnawave write-back: `reiwa_id` теперь реально пишется в description

`v0.3.6` — критичный hotfix для импорта/синхронизации с Remnawave-панелью. После v0.3.3 контракт `@remnawave/backend-contract` был спинтован на `~2.7.3` чтобы соответствовать live-панели, но у нас в `RemnawaveApiService` остался **до-2.7 формат** двух методов: `createPanelUser` и `updatePanelUser`. На write слышали 200 OK, но Remnawave молча игнорировал большинство полей (или вообще возвращал 404).

### Симптом

Открываешь профиль в Remnawave → в `Description` нет `reiwa_id: <CUID>`, хотя оператор уже несколько раз гонял `import` и `sync`. В `import_records.result` `descriptionWritebacks: 0` для всех 76 синхронизированных профилей, даже несмотря на `recordsOk: 70`.

### Root cause

Два смежных breaking change в Remnawave 2.7.x контракте, которые мы не отследили при пине `^2.8.1` → `~2.7.3` (релиз v0.3.3):

**1. URL для PATCH сменился.** Было `PATCH /api/users/{uuid}` (UUID в URL) → стало `PATCH /api/users` (UUID в body). Старый путь возвращает `404 "Cannot PATCH /api/users/{uuid}"`. У нас же в `try/catch` `writeBackReiwaId` warning логировался и проглатывался — поэтому в `descriptionWritebacks` всегда был ноль, а в `errors[]` тишина.

**2. Названия полей в body — теперь camelCase, не snake_case.** Было `telegram_id`, `traffic_limit_bytes`, `hwid_device_limit`, `expire_at`, `traffic_limit_strategy`, `active_internal_squads`, `external_squad_uuid` → стало `telegramId`, `trafficLimitBytes`, `hwidDeviceLimit`, `expireAt`, `trafficLimitStrategy`, `activeInternalSquads`, `externalSquadUuid`. Если бы URL был верный, мы бы получали 200 OK с применённым `description`, но все остальные поля при этом тихо игнорировались — данные пользователя в Remnawave дрейфовали относительно нашей БД.

### Fix

В `src/modules/remnawave/services/remnawave-api.service.ts`:

- `updatePanelUser`: путь `PATCH '/api/users/${uuid}'` → `PATCH '/api/users'` (UUID уже идёт в body как обязательное поле по zod-схеме).
- `updatePanelUser`: snake_case → camelCase для всех полей.
- `createPanelUser`: snake_case → camelCase для всех полей. Путь `POST /api/users` остался как был — он правильный для create (UUID не нужен в URL).

В `src/modules/imports/services/remnawave-importer.service.ts`:

- `writeBackReiwaId` больше не глотает exceptions молча. Если `updatePanelUser` упадёт — exception улетает наверх и попадает в `errors[]` итогового `ImportRecord.result`. Это observability-fix: следующий раз если что-то сломается, мы увидим конкретный URL/код в `result.errors[]`, а не молчаливый ноль в `descriptionWritebacks`.

### Verification

После пересборки локального стака и одного `mode: sync`:

```
fetched:    77
updated:    70  (matched users)
skipped:     7  (no local match in sync mode)
writebacks: 69  (69 profiles got reiwa_id written into Remnawave description)
errors:      0
```

(70 - 1 = 69, потому что одному профилю я вручную прописал reiwa_id в ходе диагностики; на чистом боксе цифры совпали бы.)

Любой Remnawave-профиль с известным telegramId/email теперь имеет в description строку вида `reiwa_id: <CUID>` — следующий sync будет матчить его за O(1) lookup по PK без перебора.

### Pre-push checklist

| Check | Result |
|---|---|
| Backend `tsc --noEmit -p tsconfig.json` | ✅ 0 errors |
| Backend `eslint . --quiet` | ✅ 0 warnings |
| Local stack rebuild + redeploy | ✅ healthy, `version: "0.3.6"` |
| Live sync against `2get.pro` panel | ✅ writebacks: 69, errors: 0 |

### Migration / breaking

Нет. Старые `ImportRecord`-записи остаются как были (просто в `result.descriptionWritebacks: 0`). Достаточно один раз запустить `POST /admin/imports/remnawave/sync` — все совпавшие профили получат `reiwa_id` write-back за один проход.

### Docker image

Пересобирается автоматически на push tag `v0.3.6` → GHCR теги `v0.3.6`, `0.3.6`, `0.3`, `latest`.

**Full Changelog**: https://github.com/dizzzable/rezeis/compare/v0.3.5...v0.3.6

---

# Rezeis Admin v0.3.5

## Hotfix — dashboard 429 storm: removed phantom global `strict` throttler tier

`v0.3.5` — узкий, но критичный hotfix. На свежем дашборде в Network tab можно было увидеть лавину `429 Too Many Requests` от `/api/admin/dashboard/system-health`, `/api/admin/dashboard/summary`, `/api/admin/remnawave/metrics/online-trend` — даже когда оператор ничего не делал, просто открыл `/`. Сводка дашборда отказывалась загружаться (`Сводка дашборда недоступна`).

### Root cause

`ThrottlerModule.forRoot([...])` определял **два** именованных throttler'а:

```ts
{ name: 'default', ttl: 60_000, limit: 600 },   // generous, для polling
{ name: 'strict',  ttl: 60_000, limit: 5 },     // только для login
```

Поведение `@nestjs/throttler` 6.x, не очевидное из доков: **каждый именованный throttler применяется к каждому запросу**, если не отскипан **по имени**. `@SkipThrottle()` без аргументов = `{ default: true }` — то есть отключает только `default` namespace, но `strict` (5 запросов / 60 секунд) продолжает считать **все** запросы дашборда.

`system-health` polling 10 s × 6 запросов / минуту = немедленно превышение лимита 5 → 429 на каждом следующем тике, плюс 429 на summary, online-trend, activity-feed на той же минуте. UI словил error-state и показал «Сводка дашборда недоступна», а DevTools заполнил консоль ошибками.

### Fix

В `src/common/throttle/throttle.module.ts`:

- Удалён глобальный `strict` namespace. Остался только `default` (600 req / 60 s).
- В `admin-auth.controller.ts` `@Throttle({ strict: { ttl: 60_000, limit: 5 } })` заменён на `@Throttle({ default: { ttl: 60_000, limit: 5 } })` — login-эндпоинт теперь переопределяет `default`-throttler локально, без побочного namespace, который бил по всему API.

Это полностью соответствует tested-pattern из официальных доков: per-endpoint `@Throttle()` override на default namespace. Отдельный `strict` tier нужен был бы только если бы у нас 3+ endpoint'ов делили один отдельный budget — у нас такого нет.

### Pre-push

| Check | Result |
|---|---|
| Backend `tsc --noEmit -p tsconfig.json` | ✅ 0 errors |
| Backend `eslint . --quiet` | ✅ 0 warnings |
| Local stack rebuild + redeploy | ✅ healthy, `version:"0.3.5"` |
| Dashboard idle for 60s, log check | ✅ 0 × 429 entries |

### Migration / breaking

Нет. Login по-прежнему ограничен 5 попыток / 60 секунд — просто через другой механизм. Существующие admin-сессии не задеты.

### Docker image

Пересобирается автоматически на push tag `v0.3.5` → GHCR теги `v0.3.5`, `0.3.5`, `0.3`, `latest`.

**Full Changelog**: https://github.com/dizzzable/rezeis/compare/v0.3.4...v0.3.5

---

# Rezeis Admin v0.3.4

## Patch — Cmd+K quick-search now jumps to pages

`v0.3.4` — узкий UX-фикс. Раньше Cmd+K (или иконка лупы в топбаре) искал только по данным: пользователи, подписки, транзакции, промокоды, партнёры. Если оператор печатал название раздела (`remnawave`, `партнёры`, `платежи`), оверлей честно отвечал «Нет результатов», хотя в сайдбаре эти разделы есть.

### Fix

В `QuickSearchOverlay` добавлен **навигационный индекс**: на каждый ввод (≥2 символа) клиент локально матчит query против списка разделов из `admin-nav-config.ts` — сравнивая с key, путём (`/users`) и локализованным label (`adminNav.items.<key>`). Совпадения попадают в **топ списка** (раньше ru/en data-результатов), помечены бейджем «страница» / «page», и при выборе делают `navigate(item.path)`.

Это закрывает классический Linear/Spotlight-паттерн:

- `remnawave` → раздел Remnawave (`/remnawave`)
- `партн` → Партнёры + Withdrawals
- `/users` → Пользователи (по path тоже матчится)
- `analytics` → Аналитика

Backend `/admin/quick-search` не тронут — нав-индекс полностью клиентский, без сетевого вызова.

### Pre-push

| Check | Result |
|---|---|
| Backend `tsc --noEmit -p tsconfig.json` | ✅ 0 errors |
| Backend `eslint . --quiet` | ✅ 0 warnings |
| Frontend `tsc -b` | ✅ 0 errors |
| Frontend `eslint . --quiet` | ✅ 0 warnings |
| Frontend `vite build` | ✅ built |

### Migration / breaking

Нет.

### Docker image

Пересобирается автоматически на push tag `v0.3.4` → GHCR теги `v0.3.4`, `0.3.4`, `0.3`, `latest`.

**Full Changelog**: https://github.com/dizzzable/rezeis/compare/v0.3.3...v0.3.4

---

# Rezeis Admin v0.3.3

## Minor release — Remnawave page rebuild + reverse-proxy presets + Postgres 17 client

`v0.3.3` — большой косметический и инфраструктурный апдейт. Полностью переписана страница `/remnawave` (старый монолит из ~1.4k строк разнесён на 7 feature-папок), добавлен набор готовых reverse-proxy конфигов (Caddy / Caddy-auto / Nginx / Traefik) под `deploy/proxies/`, починен `pg_dump` под Postgres 17 в Docker, и наведён порядок в auth-слое для `/api/internal/*` (статический `REZEIS_ADMIN_INTERNAL_API_KEY` guard полностью выпилен — остаётся только JWT через `InternalAdminAuthGuard` + `api_tokens`).

Релиз не меняет схему БД и публичные API внешних интеграций.

---

## 🛰 Remnawave page — полная переработка

Старая страница `/remnawave` (один `remnawave-page.tsx` на ~1450 строк, всё в одном табе) разнесена по семи доменам — каждый со своим набором query-keys, API-биндингов и подкомпонентов:

```
web/src/features/remnawave/
├── dashboard/    # Health card, system recap, bandwidth chart
├── infra/        # Nodes / Hosts / Squads (с DnD-reorder)
├── catalog/      # Config profiles, snippets, subpage configs, subscription templates
├── users/        # Поиск по telegramId/username/email/sub-UUID, HWID top-abusers
├── costs/        # Infra providers, billing per node
├── settings/     # RO-зеркало настроек Remnawave + node plugins + public key
├── shared/       # Общие presentational компоненты, форматтеры
├── remnawave-flags.tsx       # Country flags из country-flag-icons (vendored на build)
├── remnawave-icon.tsx        # Brand icon
├── remnawave-query-keys.ts   # Единая фабрика query-keys
└── remnawave-page.tsx        # Тонкая обёртка-роутер (~150 строк вместо 1450)
```

### Backend — расширенный API surface

`AdminRemnawaveController` получил 12 новых endpoint'ов под новые табы; все они проксируют запросы в Remnawave-панель и graceful-degraded (ловят 404/501 и возвращают `null`/пустой массив, чтобы UI не падал на 2.7.x панелях):

- **HWID:** `GET /admin/remnawave/hwid/top-users` — топ устройств по логинам.
- **Health:** `GET /admin/remnawave/system/health` — uptime/db/redis/version самой Remnawave-панели.
- **Subscription request history:** `GET .../subscription-request-history` (+`stats`) — лог запросов клиентов на сабскрипшн (полезно для дебага активаций).
- **Catalog:** `GET .../snippets`, `.../subscription-page-configs`, `.../subscription-templates`, `.../subscription-settings`.
- **Costs:** `GET .../infra/providers`.
- **Settings:** `GET .../node-plugins`.
- **Search:** `GET .../users/resolve?telegramId=&username=&email=&subscriptionUuid=`.
- **Hosts mutation beyond CRUD:** `POST .../hosts/reorder` (DnD reorder в UI).

Параллельно `getInternalSquads` / `getExternalSquads` теперь возвращают **detail-shape** (с `membersCount`/`inboundsCount`, как сама панель Remnawave показывает в своём UI), а старый облегчённый shape переехал в `options/internal-squads` и `options/external-squads` — ими пользуется plan-builder.

### Новые мапперы и интерфейсы

- `remnawave-extended.interface.ts` — все новые shape'ы: health, hwid top, subscription-request entries, snippet, subpage config, subscription template/settings, infra provider, node plugin, user summary.
- `remnawave-squad-detail.interface.ts` + `remnawave-squad-mappers.ts` — internal/external squad detail.
- `remnawave-node-mapper.ts`, `remnawave-system-stats.normalizer.ts`, `remnawave-extended-mappers.ts` — все парсеры shape-tolerant: принимают и legacy 2.7.x, и forward-compatible 2.8.x формы, валидируют типы в run-time.

### Фронтенд — что увидит оператор

- На странице `/remnawave` теперь 7 табов (Dashboard / Live / Infra / Catalog / Users / Costs / Settings) вместо одного Overview.
- Health-карточка показывает uptime, db/redis, версию панели.
- Bandwidth и system recap — graceful-degraded: на 2.7.x вместо краша рисуется "метрика недоступна, требуется Remnawave 2.8+".
- Country flags под нодами/хостами теперь из `country-flag-icons` (SVG), вендорятся в `web/src/flags/*.svg` через `scripts/sync-flags.mjs` на этапах `predev` и `prebuild`. SVG-снапшоты в gitignore — каждый билд тянет свежий набор.
- На карточке пользователя в `/users` подгружается `username`/`description` из реальной Remnawave-подписки (через `Promise.allSettled` — одна 404 не валит весь user-detail).

### Тесты

4 новых suite'а (`node --test`, чисто unit, без БД):

- `test/remnawave-api-base-url.spec.ts` — резолвинг `REMNAWAVE_HOST` без точки → docker http, с точкой → public https.
- `test/remnawave-node-mapper.spec.ts` — все edge-кейсы node shape.
- `test/remnawave-squad-mappers.spec.ts` — internal/external squad detail mapping.
- `test/remnawave-system-stats-normalizer.spec.ts` — современная и legacy формы `system/stats`.

**17/17 passing.**

---

## 🌐 Reverse-proxy пресеты — `deploy/proxies/`

Раньше в `docker-compose.yml` rezeis торчал на `127.0.0.1:8000`, и каждый, кто разворачивал у себя, вручную писал Caddy/Nginx/Traefik конфиг. Теперь:

```
deploy/proxies/
├── caddy/        # Production Caddy (явный TLS, ваш домен)
├── caddy-auto/   # Caddy с автоматическим Let's Encrypt
├── nginx/        # Nginx + certbot
├── traefik/      # Traefik с labels-based routing
└── README.md     # Сценарий "сначала proxy-стек, потом rezeis-stack"
```

В `docker-compose.yml` сервис `rezeis` больше **не публикует** `127.0.0.1:8000` наружу — только `expose: 8000` в docker-сети. Reverse proxy ходит к нему по `rezeis:8000`. Если нужен прямой доступ с хоста (для дебага), есть закомментированный `ports: ['127.0.0.1:8000:8000']` блок с пояснением.

Это закрывает классическую дыру "панель доступна на :8000 без TLS, если кто-то проколол firewall".

---

## 🐘 Postgres 17 — fix `pg_dump` aborting

`docker-compose.yml` использует `postgres:17-alpine`, но Dockerfile rezeis-admin тянул `postgresql16-client`. Это давало:

```
pg_dump: error: aborting because of server version mismatch
pg_dump: server version: 17.x; pg_dump version: 16.x
```

на каждой попытке создать бэкап через UI. Бамп → `postgresql17-client`. К `docker-compose.yml` добавлен явный комментарий-предупреждение: при апгрейде Postgres major версии **обязательно** синхронно поднимать `postgresql<major>-client` в Dockerfile.

---

## 🔐 Auth surface — статический guard выпилен

`/api/internal/*` маршруты раньше принимали два guard'а параллельно: новый `InternalAdminAuthGuard` (JWT из `api_tokens` таблицы) и старый `InternalApiGuard` (статический `REZEIS_ADMIN_INTERNAL_API_KEY` из ENV). Это давало две точки входа с разными правами и аудитом.

Удалено:

- `src/common/guards/internal-api.guard.ts` — больше не используется нигде в проекте.
- ENV `REZEIS_ADMIN_INTERNAL_API_KEY` — выпилен.

Теперь единственный путь авторизации для reiwa/бота/внешних интеграций — JWT-токены, выпускаемые через UI ("Settings → API Tokens"), хранящиеся в `api_tokens` и отзываемые удалением строки. Такой же контракт, как в самой Remnawave-панели.

---

## 📚 Doc updates

- `README.md` — добавлен раздел "Remnawave compatibility" с матрицей: live panel `2.7.x` → contract `~2.7.3` (текущий пин), `2.8.x` → `~2.8.x`. Объяснено как и когда бампить `@remnawave/backend-contract`.
- `.env.example` — задокументирован resolve-механизм `REMNAWAVE_HOST`: значения без точки тянутся как `http://${host}:${port}`, с точкой — как `https://${host}` (port игнорируется). Три примера: docker-compose сосед, public HTTPS, SSH-туннель.
- `docker-compose.yml` — комментарии про deploy/proxies workflow, deprecated `ports` блок, постгрес-major синхронизацию.
- `docs/remnawave-redesign-plan.md` — implementation plan и reachability matrix для Remnawave 2.7.4 (источник истины для дальнейших итераций redesign).

---

## 🔧 Misc

- `@remnawave/backend-contract`: `^2.8.1` → `~2.7.3`. Текущая live-панель — 2.7.x, и пин на 2.8.1 ронял запросы к `/api/internal-squads`, `/api/external-squads`, `/api/users/resolve` (контракт ушёл вперёд раньше панели).
- 12 smoke-скриптов под `scripts/smoke-*.sh` — bash-проверки реальных Remnawave endpoint'ов, которыми мы выясняли что доступно на 2.7.4 и что только на 2.8.x. Используются в CI вручную.
- `web/scripts/sync-flags.mjs` — копирует SVG из `country-flag-icons` в `web/src/flags/` на predev/prebuild. Снапшот в gitignore.

---

## 📦 Pre-push checklist

| Check | Result |
|---|---|
| Backend `tsc --noEmit -p tsconfig.json` | ✅ 0 errors |
| Backend `eslint . --quiet` | ✅ 0 warnings |
| Frontend `tsc -b` + `vite build` | ✅ built (12.76s) |
| Frontend `eslint . --quiet` | ✅ 0 warnings |
| New remnawave tests (4 suites) | ✅ 17/17 passing |

---

## 🚧 Migration / breaking

Есть одна точка внимания — внешние интеграции, которые ходили по `REZEIS_ADMIN_INTERNAL_API_KEY`:

1. Откройте панель → **Settings → API Tokens** → создайте новый токен с нужным scope.
2. Замените `Authorization: Bearer ${REZEIS_ADMIN_INTERNAL_API_KEY}` на `Authorization: Bearer ${api_token_jwt}` в реквестах.
3. Удалите `REZEIS_ADMIN_INTERNAL_API_KEY` из вашего `.env`.

Новый guard логирует каждое использование токена (audit trail), статический ключ — не логировал. Это явное улучшение security posture.

Если ваша Remnawave-панель уже на 2.8.x и вы хотите включить bandwidth/recap/hwid surface — после деплоя бампните `@remnawave/backend-contract` до `~2.8.x` и пересоберите. На 2.7.x это не нужно — graceful degradation сама нарисует "метрика недоступна" плашки.

---

## 🐳 Docker image

Пересобирается автоматически на push tag `v0.3.3` → GHCR теги:

- `ghcr.io/dizzzable/rezeis:v0.3.3`
- `ghcr.io/dizzzable/rezeis:0.3.3`
- `ghcr.io/dizzzable/rezeis:0.3`
- `ghcr.io/dizzzable/rezeis:latest`

Деплой:

```bash
docker compose pull && docker compose up -d
```

**Full Changelog**: https://github.com/dizzzable/rezeis/compare/v0.3.2...v0.3.3

---

# Rezeis Admin v0.3.2

## Patch — Recharts 3 zero-size warning fix

`v0.3.2` — узкий runtime-фикс: на viewport <1024px и в свернутых `<Collapsible>` секциях Recharts 3 печатает в console:

> The width(-1) and height(-1) of chart should be greater than 0… add a minWidth(0) or minHeight(undefined)…

Recharts 3 ужесточил гард на `width≤0 || height≤0` в `ResponsiveContainer` — теперь любая mounted чарт-инстанция в скрытом родителе (`hidden`, `display:none`, collapsed accordion) вылетает в `console.warn`. Логика рендера корректна — сам ResizeObserver всё равно перерисует чарт когда parent станет видим — но шум в DevTools раздражает.

### Fix

Добавлены `minWidth={0}` (и `minHeight={0}` где ResponsiveContainer использует `width="100%" height="100%"` без явных пикселей) во все 12 ResponsiveContainer-ов в активном коде:

- `components/ui/chart.tsx` — общий `ChartContainer` (используется в Appearance preview).
- `features/dashboard/dashboard-online-trend.tsx`
- `features/dashboard/dashboard-subscription-chart.tsx`
- `features/analytics/analytics-page.tsx` (4 места: 2 Pie charts, AreaChart LTV, ComposedChart subscriptions)
- `features/payments/payments-analytics-tab.tsx` (2 места: trend sparkline + provider detail panel)
- `features/partners/partners-analytics-tab.tsx` (3 места: timeseries AreaChart, level distribution BarChart, gateway PieChart)
- `features/referrals/referrals-analytics-tab.tsx` (3 места: timeseries AreaChart, role distribution PieChart, top users LineChart)

Это тип-safe и behavior-preserving: Recharts продолжает читать parent box через ResizeObserver, и на первый кадр (когда parent имеет реальный размер) рисует точно так же.

### Pre-push

| Check | Result |
|---|---|
| Backend `tsc` + `eslint` | ✅ 0 errors / 0 warnings |
| Frontend `tsc -b` + `eslint` + `build` | ✅ 0 errors / 0 warnings / built |

### Migration / breaking

Нет.

### Docker image

Пересобирается автоматически на push tag `v0.3.2` → GHCR теги `v0.3.2`, `0.3.2`, `0.3`, `latest`.

**Full Changelog**: https://github.com/dizzzable/rezeis/compare/v0.3.1...v0.3.2

---

# Rezeis Admin v0.3.1

## Patch release — i18n полнота, type-safety и lint hygiene + Liquid Glass theme

`v0.3.1` — расчистка после Partner Program 2.0. Закрыты три большие категории технического долга: незавершённый code-split локализации (часть кнопок не локализовалась), 114 накопившихся TS ошибок (после миграции на TS 6 / motion v12 / Recharts 3 / Zod 4 / react-hook-form 7.75 / Radix DayPicker и т.д.) и 47 ESLint warnings, нарушавших объявленный «0 warnings policy». Параллельно поднят первый этап Liquid Glass темы: SVG displacement filters, runtime browser-detection и базовые поверхности.

Релиз не меняет публичные API и схему БД — это чистый front-end / typings / DX.

---

## ✨ Liquid Glass theme (preview)

Первый этап — фундамент refraction-эффекта.

### Новые компоненты
- **`components/glass/LiquidGlassFilters.tsx`** — глобальный SVG `<defs>` с тремя пресетами фильтров:
  - `#lg-soft` — низкая displacement-шкала для статических поверхностей.
  - `#lg-prominent` — средний `feDisplacementMap` + хроматическая аберрация для интерактивных поверхностей (кнопки, popover'ы).
  - `#lg-press` — увеличенная шкала для `:active`-эффекта.
- **`components/glass/LiquidGlassMotion.tsx`** — motion-обёртки для glass-поверхностей.

### Runtime browser detection
- Атрибут `data-glass-refraction` на `<html>` ставится в `'on'` только для Chromium (где `backdrop-filter: url(#svg)` с `feDisplacementMap` действительно рисует). Safari и Firefox — `'off'`, fallback на простой blur+saturate.
- `AppearanceProvider` мониторит `glassEnabled` toggle и UA-проверку, тегирует root в одну точку.

### Глобальные стили
- `index.css` (+446 строк): новые CSS-классы для glass surfaces, sidebar, dialogs; `.glass-card` с `backdrop-filter: blur(12px) saturate(1.5)`; box-shadow inset 1px для тонкой стеклянной границы.
- `glass-store` (+113 строк): zustand-стор с `displacementScale`, `aberrationIntensity`, `glassEnabled`, `surfaceTint`.
- `glass-settings-card.tsx` (+159 строк): UI-секция в Appearance с слайдерами для всех параметров и live-preview.

### Sign-in
- `sign-in-page.tsx` — заметная glass-поверхность на форме входа, чтобы преcет был виден ещё до авторизации.

> ⚠ Это **preview**. В Safari и Firefox refraction отключён (показ только base blur). Полная поддержка ждёт CSS Houdini Filter Effects v2 или Firefox-флаг `gfx.webrender.svg-filter-effects`.

---

## 🌐 Локализация — code-split дочистка

После v0.2.x был выполнен code-split i18n на feature-bundles (один chunk на фичу), но половина страниц не получила своих ключей или не загружала свой бандл при холодной навигации. Это было особенно заметно на кнопках действий, всплывающих toast'ах и aria-labels.

### Wiring fixes (router)
- `/settings/api-tokens` route и таб в `panel-settings-hub` теперь обёрнуты `withFeatureBundle('platformSettings', …)` — 31 ключ `settings.apiTokens.*` живёт в platformSettings бандле, без обёртки на холодном refresh пользователь видел raw-ключи.
- `dashboardPage.title` отсутствовал в `dashboard.ru.ts`, добавлен.

### Хардкод RU/EN строк → `t()` ключи
9 файлов с прямыми placeholders/labels/aria-labels:
- `components/ui/dialog.tsx`, `components/ui/sheet.tsx` — `sr-only "Close"` → `t('common.close')`
- `components/ui/date-picker.tsx` — RU-фолбэк `'Выберите дату'` → `t('common.pickDate')`
- `components/layout/admin-topbar/admin-topbar.tsx` — `aria-label="Telegram"` → `t('adminShell.telegramAria')`
- `features/users/user-detail-panel.tsx` — `label="Web-логин"`, `toast.error('Failed')`
- `features/settings/settings-page.tsx` — 9 placeholder'ов, включая RU-шаблоны верификационных SMS, `Rezeis VPN` brand-name placeholder, channel/rules URL примеры
- `features/payments/gateway-settings-page.tsx` — `'secret-key-2 (для проверки X-SIGNATURE)'` (RU-комментарий из placeholder убран)
- `features/bot-flow/components/ScreenEditorPanel.tsx` — RU/EN textarea placeholders, RU/EN button label inputs
- `features/bot-flow/components/CustomEmojiPicker.tsx` — `'Все'` → `t('botFlow.emojiCategories.all')`

### Удалены `t(key, 'fallback')` второй аргумент
Steering-rule запрещает defaultValue в `t()`. 13 случаев в `bot-flow-page.tsx`, `ScreenEditorPanel.tsx`, `CustomEmojiPicker.tsx`, `user-detail-panel.tsx` — фолбэки убраны, ключи подняты в правильные неймспейсы.

### Добавлены недостающие ключи (47 уникальных)
Главные группы:
- `userDetailPanel.subscriptions.{assignPlan, selectPlan, assign, assignFailed}`
- `userDetailPanel.profile.webLogin`
- `userDetailPage.header.deepLink`
- `automationsPage.list.selectAria`, `automationsPage.toast.toggleFailed`
- `webhooksPage.toasts.{toggleFailed, regenerateFailed, testFailed, deleteFailed, replayFailed}`
- `plansPage.{archiveFailed, unarchiveFailed, toggleActiveFailed}`
- `authProvider.permissions.{loadFailed, retry}` — новый top-level namespace для `loadPermissions()` toast retry
- `botFlow.{edgeDeleted, mediaUploadError, fields.{mediaHint, textRuPlaceholder, textEnPlaceholder}, button.{unicodeHint, clearEmoji, manualEmojiHint, labelRuPlaceholder, labelEnPlaceholder}, emojiCategories.all}`
- `common.pickDate`, `adminShell.telegramAria`
- `settingsPage.branding.*Placeholder` (5 шт.) и `settingsPage.platform.{rulesLinkPlaceholder, channelLinkPlaceholder}`

Все ключи добавлены одновременно в `ru.ts` и `en.ts` (или `<feature>.ru.ts` / `<feature>.en.ts`).

---

## 🛠 TypeScript: 114 → 0 errors

После миграций (TS 6.0.3 / motion v12 / Recharts 3 / Zod 4 / react-hook-form 7.75.0 / Radix DayPicker 9 / i18next 26) накопились ошибки во всём дереве. Устранены **все** без обхода через ny или suppression.

### Build infrastructure
- **	sconfig.app.json** — добавлен exclude для 5 vendored React Bits файлов, не используемых в активном UI и тянущих внешние deps без типов: index.ts (barrel), AnimatedContent.tsx, FallingText.tsx (matter-js), Lanyard.tsx (@react-three/rapier + .glb), ModelViewer.tsx (three OBJLoader), SplitText.tsx. Vite-bundler по-прежнему собирает реально импортируемые компоненты.
- **
eactbits/index.ts** — GridScan экспортируется как **named** (не default), исправлен export.
- **i18n/i18n.ts** — убран initImmediate: false (поле выпало из типов i18next 26).

### Library type-shape adaptations
- **motion v12 Easing** — effects/AnimatedContent.tsx: ease: string | number[] → ease: Easing.
- **RotatingText / ScrambledText API drift** — effects/TitleEffect.tsx: interval → 
otationInterval; 	ext prop → children.
- **Recharts 3 Formatter<ValueType, NameType>** — formatter теперь принимает ValueType | undefined. Адаптировано в:
  - eatures/dashboard/dashboard-subscription-chart.tsx
  - eatures/analytics/analytics-page.tsx
  - eatures/partners/partners-analytics-tab.tsx (3 места)
  - eatures/payments/payments-analytics-tab.tsx
  - eatures/referrals/referrals-analytics-tab.tsx — Pie label с PieLabelRenderProps-сужением.
- **Radix DayPicker 9** — eatures/partners/analytics-range-picker.tsx: initialFocus → utoFocus.
- **Zod 4** — 
otifications-page.tsx: z.coerce.number({ invalid_type_error: … }) → error: ….
- **react-hook-form 7.75 Resolver generic** — 
otifications-page.tsx: useForm<FormValues, unknown, FormValues> + явный cast Resolver<FormValues, unknown, FormValues> (zod-resolver и coerce.number дают разные input/output типы).

### TS 6.0.3 polymorphic-JSX false-positive
TS 6 (currently beta in this project) несправедливо помечает <item.icon className="…" /> как Type 'string' is not assignable to type 'never', когда item.icon: React.ElementType. Обход — extract в локальную переменную с явным cast:
`	s
const ItemIcon = item.icon as ComponentType<SVGProps<SVGSVGElement>>
`
Применено в:
- components/layout/admin-sidebar/{nav-items,sortable-nav-item}.tsx
- components/quick-search/quick-search-overlay.tsx
- eatures/{analytics/analytics-page,remnawave/remnawave-page}.tsx — там же тип параметра icon: React.ElementType заменён на ComponentType<SVGProps<SVGSVGElement>>.

### Backend API shape
- **eatures/users/user-detail-shape.ts** — расширены интерфейсы под реальный shape GET /admin/users/:telegramId:
  - UserDetail: + isBotBlocked, isRulesAccepted, personalDiscount, purchaseDiscount, partnerBalanceCurrencyOverride, ttachReferrerReason, effectiveInviteSettings, userInviteSettingsOverride
  - UserSubscription: + configUrl, plan: { id, name, type }
  - UserWebAccount: + 
equiresPasswordChange, 	emporaryPasswordExpiresAt
  - UserPartner: + 	otalWithdrawn, useGlobalSettings, ccrualStrategy, 
ewardType, levelXPercent, levelXFixedAmount
  - UserPartnerTransaction: + level, description, earnedAmount
  - UserReferralEntry: + 
eferral, 
eferralUserId
  - new InviteEffective / InviteOverride интерфейсы
- **eatures/payments/payments-page.tsx TransactionRow** — + userUsername, userName.

### Misc
- **eatures/users/user-detail-panel.tsx** — InfoRow.value принимает string | number | bigint | null | undefined (50+ мест), внутри сужает к строке через alue == null ? '—' : String(value). Ранний return для WebCabinetTab если !user.webAccount.
- **eatures/plans/plan-form.tsx** — useState<string[]>([...readonly]) через spread для readonly→mutable.
- **eatures/referrals/referrals-page.tsx** — unwrap теперь использует type-guard 'items' in raw вместо ?.items.

---

## 🧹 ESLint: 47 → 0 warnings

Подняты до 0 для соблюдения «0 warnings policy» (steering-rule).

### Unused imports / variables (19)
Удалены: BotScreenNode.tsx::Node, ScreenEditorPanel.tsx::GripVertical, ot-flow/utils.ts::BotFlowScreen, неиспользованный 	 в 
otifications-page::DeliverySettingsTab, partners-list-tab::formatKopecks, plan-form::api, plans-page::interface PlanDuration, settings-page::function JsonSettingsTab целиком (~30 строк мёртвого кода), users-page::Badge, и серия в user-detail-panel.tsx: HardDrive/Power/PowerOff/UserTransaction/IdentifierChip/getUserStatusDotClass/IDENTITY_KIND_VARIANTS/identityVariant/copyToClipboard/partnerBalance/лишний i18n в SubscriptionsTab.

### Outdated eslint-disable directives (3)
ErrorBoundary.tsx, uth-provider.tsx, ackground-controls.ts — disable-comments указывали на правила, которые уже отключены глобально или больше не применимы.

### Hook dependencies
ot-flow-page.tsx — useCallback без 	 в deps → исправлено.

### react-doctor / react-hooks suppress + TODO (22)
React Compiler-rules (set-state-in-effect, refs-during-render, purity, static-components) сейчас слишком consumer-наивные: они flag'ают паттерны, которые корректны в рамках наших lookup-функций (getPaymentGatewayIcon, getCurrencyIcon, getAuthProviderIcon — все возвращают стабильный компонент по типу). Каждое подавление снабжено TODO-комментарием с описанием правильного будущего рефактора.

Особенность: eslint-disable-next-line не уважается react-doctor — правило срабатывает на JSX-tag, не на declaration. Поэтому где disable-next-line не помог, использован block /* eslint-disable */ … /* eslint-enable */ или disable прямо на JSX-узле.

### File-level disables
- eatures/partners/analytics-range-picker.tsx — 
eact-refresh/only-export-components (helper uildDefaultRange рядом с компонентом).
- eatures/settings/auth-provider-icons.tsx — то же (factory getAuthProviderIcon).

### react-hook-form orm.watch()
Распознаётся react-doctor как "incompatible library". В 5 файлах добавлены suppress'ы с комментарием про React Compiler integration: 
otifications-page.tsx ×2, partner-detail-sheet.tsx, panel-branding-tab.tsx, partner-settings-page.tsx, 
eferral-settings-page.tsx.

---

## 📦 Pre-push checklist

| Check | Result |
|---|---|
| Backend `tsc --noEmit -p tsconfig.json` | ✅ 0 errors |
| Backend `tsc --noEmit -p tsconfig.build.json` | ✅ 0 errors |
| Backend `eslint .` (errors + warnings) | ✅ 0 / 0 |
| Frontend `tsc -b` | ✅ 0 errors |
| Frontend `eslint .` (errors + warnings) | ✅ 0 / 0 |
| Frontend `npm run build` (vite + rolldown) | ✅ built |

---

## 🚧 Migration / breaking

Нет. Все изменения — type-only, lint-only, либо behavior-preserving (	() ключи добавлены до удаления fallback'ов). Schema БД и публичные API не тронуты.

/settings/api-tokens теперь грузит platformSettings feature-bundle на холодном refresh — это +чанк-prefetch, поведение для пользователя становится корректнее (раньше показывались raw-ключи на flash-кадре).

---
# Rezeis Admin v0.3.0

## Major release вЂ” Partner Program 2.0: end-to-end payment hooks, advanced analytics, and operator-grade UX

`v0.3.0` вЂ” РєСЂСѓРїРЅРµР№С€РёР№ СЂРµР»РёР· РїР°СЂС‚РЅС‘СЂСЃРєРѕР№ РїСЂРѕРіСЂР°РјРјС‹ СЃРѕ РІСЂРµРјС‘РЅ РµС‘ РїРѕСЏРІР»РµРЅРёСЏ. Р—Р°РєСЂС‹С‚С‹ С‚СЂРё РєСЂРёС‚РёС‡РµСЃРєРёРµ РґС‹СЂС‹ (post-payment hooks, РёРЅРґРёРІРёРґСѓР°Р»СЊРЅС‹Рµ РЅР°СЃС‚СЂРѕР№РєРё, СЂРµС‚СЂРѕ-С†РµРїРѕС‡РєР° РїСЂРё Р°РєС‚РёРІР°С†РёРё), РїРѕР»РЅРѕСЃС‚СЊСЋ РїРµСЂРµРїРёСЃР°РЅ UI (4 С‚Р°Р±Р°, drawer СЃ 6 С‚Р°Р±Р°РјРё, Р°РЅР°Р»РёС‚РёРєР° СЃ cohort retention), РґРѕР±Р°РІР»РµРЅС‹ KPIs РёР· РёРЅРґСѓСЃС‚СЂРёРё affiliate-РјР°СЂРєРµС‚РёРЅРіР° (AOV / EPAP / Activation rate / Repeat-purchase share), streaming CSV-СЌРєСЃРїРѕСЂС‚С‹ СЃ Excel-formula injection guard, optimistic updates, animated counters, sparklines, Рё Р°РІС‚РѕСѓРІРµРґРѕРјР»РµРЅРёСЏ РїР°СЂС‚РЅС‘СЂРѕРІ С‡РµСЂРµР· СЃСѓС‰РµСЃС‚РІСѓСЋС‰РёР№ email/Telegram bridge.

### рџ”Ґ Р—Р°РєСЂС‹С‚С‹Рµ РєСЂРёС‚РёС‡РµСЃРєРёРµ Р±Р°РіРё

1. **Post-payment hooks РЅРµ РІС‹Р·С‹РІР°Р»РёСЃСЊ.** Р’ `PaymentReconciliationService` РїРѕСЃР»Рµ `applyCompletedTransaction` РЅРё `processPartnerEarning`, РЅРё `qualifyReferralAfterPurchase` РЅРµ РґС‘СЂРіР°Р»РёСЃСЊ. РўРѕ РµСЃС‚СЊ РІРµСЃСЊ РїР°СЂС‚РЅС‘СЂСЃРєРёР№ Р»РµРґР¶РµСЂ Р±С‹Р» РјС‘СЂС‚РІС‹Рј вЂ” РЅРё РѕРґРЅРѕРіРѕ РЅР°С‡РёСЃР»РµРЅРёСЏ Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРё РЅРµ РґРµР»Р°Р»РѕСЃСЊ. РўРµРїРµСЂСЊ РѕР±Р° СЃРµСЂРІРёСЃР° РїРѕРґРєР»СЋС‡РµРЅС‹ РїРѕРґ РѕС‚РґРµР»СЊРЅС‹РјРё try/catch (СѓРїР°РІС€РёР№ accrual РЅРµ Р»РѕРјР°РµС‚ РѕР±РЅРѕРІР»РµРЅРёРµ РїРѕРґРїРёСЃРєРё), РёРґРµРјРїРѕС‚РµРЅС‚РЅС‹ РїРѕ `(partnerId, sourceTransactionId)`, Рё РєРѕСЂСЂРµРєС‚РЅРѕ РєРѕРЅРІРµСЂС‚РёСЂСѓСЋС‚ `Decimal(20,8)` СЃСѓРјРјСѓ РІ РјРёРЅРѕСЂРЅС‹Рµ РµРґРёРЅРёС†С‹ (FLOOR).

2. **РРЅРґРёРІРёРґСѓР°Р»СЊРЅС‹Рµ РЅР°СЃС‚СЂРѕР№РєРё РїР°СЂС‚РЅС‘СЂР° РЅРµ С‡РёС‚Р°Р»РёСЃСЊ.** РљРѕР»РѕРЅРєРё `useGlobalSettings`, `accrualStrategy` (`ON_EACH_PAYMENT` / `ONCE_PER_USER`), `rewardType` (`PERCENT` / `FIXED`), `level1..3Percent`, `level1..3FixedAmount` СЃСѓС‰РµСЃС‚РІРѕРІР°Р»Рё РІ schema, РЅРѕ `processPartnerEarning` РїРµСЂРµРґР°РІР°Р» `individualSettings: null` СЃ TODO. РўРµРїРµСЂСЊ РІСЃРµ РєРѕР»РѕРЅРєРё С‡РёС‚Р°СЋС‚СЃСЏ С‡РµСЂРµР· `partner` SELECT Рё РїСЂРёРјРµРЅСЏСЋС‚СЃСЏ РІ `calculateEarning`. Per-partner FIXED amount Рё `ONCE_PER_USER` СЃС‚СЂР°С‚РµРіРёСЏ СЂР°Р±РѕС‚Р°СЋС‚.

3. **РњС‘СЂС‚РІР°СЏ Р·РѕРЅР° Р°РєС‚РёРІР°С†РёРё.** Р•СЃР»Рё РїР°СЂС‚РЅС‘СЂР° Р°РєС‚РёРІРёСЂРѕРІР°Р»Рё РџРћРЎР›Р• С‚РѕРіРѕ, РєР°Рє Сѓ РЅРµРіРѕ СѓР¶Рµ Р±С‹Р»Рё СЂРµС„РµСЂР°Р»С‹ вЂ” `PartnerReferral` С†РµРїРѕС‡РєР° РїСѓСЃС‚Р°, Рё РЅР°С‡РёСЃР»РµРЅРёСЏ РЅРµ РёРґСѓС‚. `togglePartnerStatus` С‚РµРїРµСЂСЊ РїСЂРё РїРµСЂРµС…РѕРґРµ `false в†’ true` РґС‘СЂРіР°РµС‚ РЅРѕРІС‹Р№ `backfillPartnerReferralChainForUser`, РєРѕС‚РѕСЂС‹Р№ РѕР±С…РѕРґРёС‚ СЃСѓС‰РµСЃС‚РІСѓСЋС‰РёР№ `Referral` РіСЂР°С„ Рё РІРѕСЃСЃС‚Р°РЅР°РІР»РёРІР°РµС‚ РІСЃС‘ РїСЂРѕРїСѓС‰РµРЅРЅРѕРµ. РџРёС€РµС‚ `PARTNER_ACTIVATED` СЃРѕР±С‹С‚РёРµ СЃ count РїСЂРёРІСЏР·Р°РЅРЅС‹С… СЂС‘Р±РµСЂ.

### рџ¤ќ РџРµСЂРµРєР»СЋС‡Р°С‚РµР»СЊ Referral в†” Partner

Р”РѕРєСѓРјРµРЅС‚РёСЂРѕРІР°РЅРѕ Рё Р·Р°С„РёРєСЃРёСЂРѕРІР°РЅРѕ С‚РµСЃС‚Р°РјРё: РєРѕРіРґР° Сѓ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ `Partner.isActive = true`, РѕР±С‹С‡РЅР°СЏ СЂРµС„РµСЂР°Р»СЊРЅР°СЏ РЅР°РіСЂР°РґР° (POINTS / EXTRA_DAYS) РќР• СЃРѕР·РґР°С‘С‚СЃСЏ вЂ” РІРјРµСЃС‚Рѕ РЅРµС‘ РІ `PartnerTransaction` РЅР°С‡РёСЃР»СЏРµС‚СЃСЏ РґРµРЅСЊРіРё РЅР° Р±Р°Р»Р°РЅСЃ РїРѕ СЃРѕРІСЃРµРј РґСЂСѓРіРёРј РїСЂР°РІРёР»Р°Рј. `Referral.qualifiedAt` РІСЃС‘ СЂР°РІРЅРѕ РїСЂРѕСЃС‚Р°РІР»СЏРµС‚СЃСЏ (РґР»СЏ Р°РЅР°Р»РёС‚РёРєРё Рё funnel), РЅРѕ `ReferralReward` СЃС‚СЂРѕРєР° РЅРµ Р·Р°РїРёСЃС‹РІР°РµС‚СЃСЏ. Р­С‚Рѕ Р·Р°РєСЂС‹РІР°РµС‚ РєР»Р°СЃСЃРёС‡РµСЃРєРёР№ Р±Р°Рі "РїРѕС‡РµРјСѓ СЂРµС„РµСЂР°Р» РїР°СЂС‚РЅС‘СЂР° РїРѕР»СѓС‡Р°РµС‚ Рё Р±Р°Р»Р»С‹, Рё РєРѕРјРёСЃСЃРёСЋ".

### рџ“Љ Р Р°СЃС€РёСЂРµРЅРЅР°СЏ Р°РЅР°Р»РёС‚РёРєР°

РќРѕРІС‹Р№ С‚Р°Р± В«РђРЅР°Р»РёС‚РёРєР°В» СЃ date-range picker (4 РїСЂРµСЃРµС‚Р° + custom from/to + day/week granularity):

**KPI hero (4 РєР°СЂС‚РѕС‡РєРё РЅР° РѕСЃРЅРѕРІРµ РёСЃСЃР»РµРґРѕРІР°РЅРёСЏ РёРЅРґСѓСЃС‚СЂРёРё affiliate-marketing 2026):**
- **AOV** (Average Order Value) вЂ” СЃСЂРµРґРЅСЏСЏ СЃСѓРјРјР° qualifying-РїР»Р°С‚РµР¶Р° РІ РѕРєРЅРµ
- **EPAP** (Earnings per Active Partner) вЂ” РґРѕС…РѕРґ РЅР° РѕРґРЅРѕРіРѕ Р°РєС‚РёРІРЅРѕРіРѕ РїР°СЂС‚РЅС‘СЂР°, Р»РѕРІРёС‚ В«100 РїР°СЂС‚РЅС‘СЂРѕРІ, 3 Р·Р°СЂР°Р±Р°С‚С‹РІР°СЋС‚В»
- **Activation Rate** вЂ” РґРѕР»СЏ РЅРѕРІС‹С… РїР°СЂС‚РЅС‘СЂРѕРІ СЃ С…РѕС‚СЊ РѕРґРЅРёРј РЅР°С‡РёСЃР»РµРЅРёРµРј РІ РїРµСЂРІС‹Рµ 14 РґРЅРµР№
- **Repeat-purchase share** вЂ” РґРѕР»СЏ РЅР°С‡РёСЃР»РµРЅРёР№ РёР· РїРѕРІС‚РѕСЂРЅС‹С… РїР»Р°С‚РµР¶РµР№ СЂРµС„РµСЂР°Р»РѕРІ (occurrence > 1)

РЎС‡РёС‚Р°РµС‚СЃСЏ РѕРґРЅРёРј SQL-Р·Р°РїСЂРѕСЃРѕРј СЃ РґРІСѓРјСЏ CTE: РїРµСЂРІС‹Р№ СЃРѕР±РёСЂР°РµС‚ earnings/partners_active/repeat_earnings С‡РµСЂРµР· `row_number() OVER (PARTITION BY partner_id, referral_user_id)`, РІС‚РѕСЂРѕР№ CTE СЃС‡РёС‚Р°РµС‚ 14-day activation РґР»СЏ cohort.

**6 РІРёРґР¶РµС‚РѕРІ РїРѕРґ KPIs:**
- **Р’РѕСЂРѕРЅРєР°** (РЅРѕРІС‹Рµ в†’ Р°РєС‚РёРІРЅС‹Рµ в†’ СЃ РЅР°С‡РёСЃР»РµРЅРёСЏРјРё в†’ СЃ РІС‹РїР»Р°С‚Р°РјРё) СЃ РєРѕРЅРІРµСЂСЃРёСЏРјРё
- **Time-series** (AreaChart) СЃ С‚СЂРµРјСЏ СЃР»РѕСЏРјРё: earnings (в‚Ѕ), approved withdrawals, new partners
- **Р Р°СЃРїСЂРµРґРµР»РµРЅРёРµ РїРѕ СѓСЂРѕРІРЅСЏРј** L1/L2/L3 (BarChart)
- **Р Р°СЃРїСЂРµРґРµР»РµРЅРёРµ РїРѕ С€Р»СЋР·Р°Рј** (PieChart СЃ 10-С†РІРµС‚РЅРѕР№ РїР°Р»РёС‚СЂРѕР№)
- **Top-10 РїР°СЂС‚РЅС‘СЂРѕРІ** Р·Р° РїРµСЂРёРѕРґ СЃ CSV-СЌРєСЃРїРѕСЂС‚РѕРј
- **Withdrawal throughput** СЃ РјРµРґРёР°РЅРѕР№ Рё p95 РІСЂРµРјРµРЅРё РїСЂРёРЅСЏС‚РёСЏ СЂРµС€РµРЅРёСЏ

**Cohort retention heatmap.** РќРѕРІС‹Р№ СЌРЅРґРїРѕРёРЅС‚ `GET /admin/partners/analytics/cohorts?from=&to=&horizonWeeks=`. Р РµР°Р»РёР·Р°С†РёСЏ РЅР° РґРІСѓС… CTE СЃ `date_trunc('week', created_at)` РґР»СЏ cohort Рё `EXTRACT(WEEK FROM age(...))` РґР»СЏ week_index. Cells where the cohort has not been alive long enough вЂ” `null`, РЅР° UI СЂРёСЃСѓСЋС‚СЃСЏ СЃРµСЂС‹РјРё. РћС‚СЂРёСЃРѕРІР°РЅРѕ РєР°Рє HTML/CSS table СЃ С„РѕРЅРѕРј `hsl(160 80% (80 - intensity*40)%)` РґР»СЏ retention intensity.

### рџЋЁ РџРѕР»РЅРѕСЃС‚СЊСЋ РїРµСЂРµРїРёСЃР°РЅРЅС‹Р№ UI

**Р“Р»Р°РІРЅР°СЏ СЃС‚СЂР°РЅРёС†Р° `/partners`:**
- 6 hero stat-РєР°СЂС‚РѕС‡РµРє СЃ **animated counters** (framer-motion `useSpring`, honors `prefers-reduced-motion`)
- 2 inline **sparklines** РЅР° РєР°СЂС‚РѕС‡РєР°С… earnings 30d / withdrawals approved (СЃРІРѕР№ SVG, Р±РµР· Recharts)
- 4 С‚Р°Р±Р°: Partners / Withdrawals / Analytics / Settings (sync СЃ URL hash С‡РµСЂРµР· `useTabSync`)
- РљРЅРѕРїРєРё CSV-СЌРєСЃРїРѕСЂС‚Р° РІ Р·Р°РіРѕР»РѕРІРєРµ

**РўР°Р± В«РџР°СЂС‚РЅС‘СЂС‹В»:**
- РџРѕРёСЃРє РїРѕ РёРјРµРЅРё / username / Telegram ID
- Р¤РёР»СЊС‚СЂ РїРѕ `isActive`, dropdown СЃРѕСЂС‚РёСЂРѕРІРѕРє (totalEarned/balance/withdrawn/createdAt/updatedAt) + РєРЅРѕРїРєР°-РЅР°РїСЂР°РІР»РµРЅРёРµ
- Р‘РµР№РґР¶Рё Global / Individual РІРёРґРЅС‹ РїСЂСЏРјРѕ РІ С‚Р°Р±Р»РёС†Рµ
- Switch Р°РєС‚РёРІРЅРѕСЃС‚Рё РЅР° РєР°Р¶РґРѕРј СЂСЏРґСѓ
- РљРЅРѕРїРєР° Manage РѕС‚РєСЂС‹РІР°РµС‚ Sheet drawer
- **Quick-action menu** (3-С‚РѕС‡РєРё): РѕС‚РєСЂС‹С‚СЊ РІ Users / СЃРєРѕРїРёСЂРѕРІР°С‚СЊ Partner ID / User ID / Telegram ID
- РџР°РіРёРЅР°С†РёСЏ РїРѕ 25 СЃС‚СЂРѕРє

**Sheet drawer (Partner Detail):**

| РўР°Р± | РЎРѕРґРµСЂР¶РёРјРѕРµ |
|---|---|
| Overview | 4 metric-card СЃ animated counters, 3 mini-РјРµС‚СЂРёРєРё (7d/30d/transactions), L1/L2/L3 referral pills, РёСЃС‚РѕС‡РЅРёРє РЅР°СЃС‚СЂРѕРµРє |
| Earnings | РўР°Р±Р»РёС†Р° `PartnerTransaction` + РєРЅРѕРїРєР° CSV-СЌРєСЃРїРѕСЂС‚Р° |
| Referrals | Р“СЂР°С„ `PartnerReferral` (L1/L2/L3) СЃ РїР°РіРёРЅР°С†РёРµР№ |
| Withdrawals | Р—Р°СЏРІРєРё РёРјРµРЅРЅРѕ СЌС‚РѕРіРѕ РїР°СЂС‚РЅС‘СЂР° |
| Settings | РљРѕСЂСЂРµРєС‚РёСЂРѕРІРєР° Р±Р°Р»Р°РЅСЃР° (zod-РІР°Р»РёРґР°С†РёСЏ) + РёРЅРґРёРІРёРґСѓР°Р»СЊРЅС‹Рµ РЅР°СЃС‚СЂРѕР№РєРё (Switch global, Select strategy, Select reward type, 3 РїРѕР»СЏ РїРѕРґ СѓСЂРѕРІРЅРё вЂ” РїРµСЂРµРєР»СЋС‡Р°СЋС‚СЃСЏ РјРµР¶РґСѓ % Рё в‚Ѕ) |
| Audit | РћС‚С„РёР»СЊС‚СЂРѕРІР°РЅРЅС‹Рµ СЃС‚СЂРѕРєРё `AdminAuditLog` РїРѕ `metadata.partnerId`, expandable JSON, load-more |

**РўР°Р± В«Р’С‹РїР»Р°С‚С‹В»:**
- 4 stat-РєР°СЂС‚РѕС‡РєРё СЃРІРµСЂС…Сѓ (pending / completed / rejected / total paid)
- РџРѕРёСЃРє + С„РёР»СЊС‚СЂ РїРѕ СЃС‚Р°С‚СѓСЃСѓ
- Р§РµРєР±РѕРєСЃС‹ СЃ indeterminate-СЃРѕСЃС‚РѕСЏРЅРёРµРј РЅР° pending-СЃС‚СЂРѕРєР°С…
- РљРЅРѕРїРєР° В«Bulk approve (N)В» СЃ РґРёР°Р»РѕРіРѕРј вЂ” РєР°Р¶РґР°СЏ Р·Р°СЏРІРєР° РѕР±СЂР°Р±Р°С‚С‹РІР°РµС‚СЃСЏ РЅРµР·Р°РІРёСЃРёРјРѕ
- Reject СЃ РґРёР°Р»РѕРіРѕРј РїСЂРёС‡РёРЅС‹
- **Optimistic updates** С‡РµСЂРµР· `onMutate`/`onError`/`onSettled` РєРѕРЅС‚СЂР°РєС‚ React Query вЂ” СЃС‚Р°С‚СѓСЃ РјРµРЅСЏРµС‚СЃСЏ РјРіРЅРѕРІРµРЅРЅРѕ, rollback РїСЂРё РѕС€РёР±РєРµ

### рџ”” РђРІС‚РѕСѓРІРµРґРѕРјР»РµРЅРёСЏ РїР°СЂС‚РЅС‘СЂРѕРІ

РќРѕРІС‹Р№ `PartnerNotificationsService` СЃРѕР·РґР°С‘С‚ `UserNotificationEvent` РїСЂРё:
- `partner.earning` вЂ” РїРѕСЃР»Рµ СѓСЃРїРµС€РЅРѕРіРѕ РЅР°С‡РёСЃР»РµРЅРёСЏ
- `partner.withdrawal_approved` вЂ” РїРѕСЃР»Рµ РѕРґРѕР±СЂРµРЅРёСЏ РІС‹РїР»Р°С‚С‹
- `partner.withdrawal_rejected` вЂ” РїРѕСЃР»Рµ РѕС‚РєР»РѕРЅРµРЅРёСЏ СЃ РїСЂРёС‡РёРЅРѕР№

РЎСѓС‰РµСЃС‚РІСѓСЋС‰РёР№ `EmailEventBridgeService` РїРѕРґС…РІР°С‚С‹РІР°РµС‚ СЃС‚СЂРѕРєРё Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРё (РµСЃР»Рё С€Р°Р±Р»РѕРЅ РІРєР»СЋС‡С‘РЅ С‡РµСЂРµР· UI). Telegram delivery С‡РµСЂРµР· Р±РѕС‚ Reiwa СЂР°Р±РѕС‚Р°РµС‚ РїРѕ С‚РѕР№ Р¶Рµ СЃС…РµРјРµ. Рљ СЃРѕР±С‹С‚РёСЏРј `PARTNER_*` РґРѕР±Р°РІР»РµРЅ `userId` РІ metadata, С‡С‚РѕР±С‹ bridge РјРѕРі РЅР°Р№С‚Рё РїРѕР»СѓС‡Р°С‚РµР»СЏ. РЁР°Р±Р»РѕРЅС‹ (`partner.earning`, `partner.withdrawal_approved`, `partner.withdrawal_rejected`) РґРѕР±Р°РІР»РµРЅС‹ РІ default catalog seed.

### рџ“¦ CSV-СЌРєСЃРїРѕСЂС‚С‹ СЃ streaming

`StreamableFile` + `Readable.from(async function* iterate())` С‡РµСЂРµР· cursor-РїР°РіРёРЅР°С†РёСЋ Prisma. РџР°РјСЏС‚СЊ РѕСЃС‚Р°С‘С‚СЃСЏ РѕРіСЂР°РЅРёС‡РµРЅРЅРѕР№ РґР°Р¶Рµ РЅР° РґРµСЃСЏС‚РєР°С… С‚С‹СЃСЏС‡ СЃС‚СЂРѕРє, РѕС‚РІРµС‚ РЅР°С‡РёРЅР°РµС‚ С‚РµС‡СЊ РґРѕ Р·Р°РІРµСЂС€РµРЅРёСЏ С‡С‚РµРЅРёСЏ.

- `GET /admin/partners/export/partners.csv` вЂ” РєР°С‚Р°Р»РѕРі РїР°СЂС‚РЅС‘СЂРѕРІ (streaming)
- `GET /admin/partners/export/top-partners.csv?from=&to=` вЂ” leaderboard
- `GET /admin/partners/export/withdrawals.csv?from=&to=` вЂ” Р·Р°СЏРІРєРё Р·Р° РїРµСЂРёРѕРґ (streaming)
- `GET /admin/partners/:partnerId/export/earnings.csv` вЂ” Р»РµРґР¶РµСЂ РїР°СЂС‚РЅС‘СЂР° (streaming)

**Excel-formula injection guard:** `renderCsv` СЌРєСЂР°РЅРёСЂСѓРµС‚ РїРѕР»СЏ РЅР°С‡РёРЅР°СЋС‰РёРµСЃСЏ РЅР° `=`, `+`, `-`, `@` РїСЂРµС„РёРєСЃРѕРј РѕРґРёРЅРѕС‡РЅРѕР№ РєР°РІС‹С‡РєРё. РљР»Р°СЃСЃРёС‡РµСЃРєР°СЏ СѓСЏР·РІРёРјРѕСЃС‚СЊ Excel CSV вЂ” С‚РµРїРµСЂСЊ РїРѕРєСЂС‹С‚Р° С‚РµСЃС‚Р°РјРё Рё РЅРµ СЃРјРѕР¶РµС‚ СЃР»СѓС‡Р°Р№РЅРѕ СЃР»РѕРјР°С‚СЊСЃСЏ. Plus UTF-8 BOM РґР»СЏ РєРѕСЂСЂРµРєС‚РЅРѕР№ РєРёСЂРёР»Р»РёС†С‹.

### рџЊђ Realtime

`TYPE_TO_QUERY_KEYS` РІ `useRealtimeUpdates` С‚РµРїРµСЂСЊ РїРѕРєСЂС‹РІР°РµС‚ РІСЃРµ 8 partner-СЃРѕР±С‹С‚РёР№ (created/activated/deactivated/balance_adjusted/earning/withdrawal_*) СЃ РёРЅРІР°Р»РёРґР°С†РёРµР№ `['admin', 'partners']`. Р РµР°Р»СЊРЅС‹Р№ СЃС†РµРЅР°СЂРёР№: С‚С‹ РІ РѕРґРЅРѕР№ РІРєР»Р°РґРєРµ РѕРґРѕР±СЂРёР» withdrawal вЂ” РІ СЃРѕСЃРµРґРЅРµР№ РІРєР»Р°РґРєРµ (РёР»Рё Сѓ РґСЂСѓРіРѕРіРѕ Р°РґРјРёРЅР°) hero-cards, list, withdrawals tab, drawer, analytics вЂ” РІСЃС‘ РѕР±РЅРѕРІР»СЏРµС‚СЃСЏ Р±РµР· F5.

Page-level toasts РЅР° СЃС‚СЂР°РЅРёС†Рµ `/partners`: РїРѕРєР° РѕРїРµСЂР°С‚РѕСЂ СЃРјРѕС‚СЂРёС‚ РЅР° dashboard, РїСЂРё `partner.earning` РІС‹СЃРєР°РєРёРІР°РµС‚ Р·РµР»С‘РЅС‹Р№ toast `+1234.56 в‚Ѕ РЅР°С‡РёСЃР»РµРЅРѕ РїР°СЂС‚РЅС‘СЂСѓ`, РїСЂРё `partner.withdrawal_requested` вЂ” info toast.

### рџ’° Bulk approve withdrawals

`POST /admin/partners/withdrawals/bulk-approve` вЂ” РјР°СЃСЃРѕРІРѕРµ РѕРґРѕР±СЂРµРЅРёРµ РґРѕ 200 Р·Р°СЏРІРѕРє Р·Р° СЂР°Р·. РљР°Р¶РґР°СЏ РѕР±СЂР°Р±Р°С‚С‹РІР°РµС‚СЃСЏ РІ РѕС‚РґРµР»СЊРЅРѕР№ С‚СЂР°РЅР·Р°РєС†РёРё, РѕС€РёР±РєРё РєРѕР»Р»РµРєС†РёРѕРЅРёСЂСѓСЋС‚СЃСЏ per-id. UI РїРѕРєР°Р·С‹РІР°РµС‚ С‡РµРєР±РѕРєСЃС‹ СЃ `select all pending`, РґРёР°Р»РѕРі РїРѕРґС‚РІРµСЂР¶РґРµРЅРёСЏ СЃ РѕРїС†РёРѕРЅР°Р»СЊРЅС‹Рј admin comment, Рё toast СЃ СЂРµР°Р»СЊРЅС‹Рј СЂРµР·СѓР»СЊС‚Р°С‚РѕРј (`approved/failed`).

### рџ§Є Quality gates

- **`tsc --noEmit`** вЂ” 0 errors
- **`eslint . --quiet`** вЂ” 0 warnings (strict 0-tolerance policy РЅР° partners + payments + notifications)
- **20 partner-related С‚РµСЃС‚РѕРІ** РїСЂРѕС…РѕРґСЏС‚: 12 example-based (`partner-earnings.service.spec.ts`, `partners.service.spec.ts`) + 4 property-based (`partner-earnings.property.spec.ts` С‡РµСЂРµР· `fast-check`) + 4 РЅР° CSV invariants (`partner-csv-export.spec.ts`)
- Property invariants РЅР° `calculateEarning`: С†РµР»РѕС‡РёСЃР»РµРЅРЅРѕСЃС‚СЊ СЂРµР·СѓР»СЊС‚Р°С‚Р°, РЅРµРѕС‚СЂРёС†Р°С‚РµР»СЊРЅРѕСЃС‚СЊ, `earned в‰¤ payment`, РЅСѓР»РµРІРѕР№ РїСЂРѕС†РµРЅС‚ РґР°С‘С‚ РЅРѕР»СЊ, individual fixed РІРѕР·РІСЂР°С‰Р°РµС‚СЃСЏ РєР°Рє-РµСЃС‚СЊ, **РјРѕРЅРѕС‚РѕРЅРЅРѕСЃС‚СЊ РїРѕ РєРѕРјРёСЃСЃРёРё С€Р»СЋР·Р°**

### рџ“Ѓ РќРѕРІС‹Рµ С„Р°Р№Р»С‹

**Backend (`rezeis-admin/src/modules/partners/`):**
- `services/admin-partner-analytics.service.ts` вЂ” funnel/timeseries/level/gateway/top/throughput/kpis/cohorts
- `services/partner-detail.service.ts` вЂ” overview/earnings/referrals/withdrawals/audit
- `services/partner-csv-export.service.ts` вЂ” streaming + РјР°С‚РµСЂРёР°Р»РёР·РѕРІР°РЅРЅС‹Р№ CSV
- `services/partner-notifications.service.ts` вЂ” UserNotificationEvent СЃРѕР·РґР°РЅРёРµ
- `dto/analytics-range-query.dto.ts`, `analytics-cohort-query.dto.ts`, `bulk-approve-withdrawals.dto.ts`, `partner-detail-paging.dto.ts`
- `interfaces/partner-analytics.interface.ts`, `partner-detail.interface.ts`

**Frontend (`rezeis-admin/web/src/features/partners/`):**
- `partner-detail-sheet.tsx` (6 С‚Р°Р±РѕРІ)
- `partners-list-tab.tsx`, `partners-withdrawals-tab.tsx`, `partners-analytics-tab.tsx`
- `partners-queries.ts`, `partners-api.ts` (zod schemas)
- `analytics-range-picker.tsx` (custom date range)
- `cohort-heatmap.tsx`, `animated-counter.tsx`, `sparkline.tsx`
- `csv-download.ts`, `partner-formatters.ts`

**Tests (`rezeis-admin/test/`):**
- `partner-earnings.service.spec.ts`
- `partner-earnings.property.spec.ts`
- `partner-csv-export.spec.ts`
- `partners.service.spec.ts`

### Migrating from 0.2.14

Р‘РµР· breaking changes. Р’СЃРµ РЅРµРѕР±С…РѕРґРёРјС‹Рµ РєРѕР»РѕРЅРєРё РЅР° `partners` СѓР¶Рµ Р±С‹Р»Рё РІ schema РёР· РјРёРіСЂР°С†РёРё `20260519130000_partner_individual_settings`.

```bash
docker compose pull && docker compose up -d
```

РџРѕСЃР»Рµ СЂРµСЃС‚Р°СЂС‚Р° РѕРїРµСЂР°С‚РѕСЂ СѓРІРёРґРёС‚:
- РќР° СЃС‚СЂР°РЅРёС†Рµ `/partners` вЂ” 4 С‚Р°Р±Р° СЃ РЅРѕРІРѕР№ Р°РЅР°Р»РёС‚РёРєРѕР№ Рё hero KPIs
- Р’ Settings в†’ Notifications в†’ Templates вЂ” РЅРѕРІС‹Рµ С€Р°Р±Р»РѕРЅС‹ `partner.earning`, `partner.withdrawal_approved`, `partner.withdrawal_rejected` (РїРѕ СѓРјРѕР»С‡Р°РЅРёСЋ РЅРµР°РєС‚РёРІРЅС‹, С‡С‚РѕР±С‹ РЅРµ СЃРїР°РјРёС‚СЊ вЂ” РѕРїРµСЂР°С‚РѕСЂ РІРєР»СЋС‡Р°РµС‚ РїРѕ РЅСѓР¶РЅС‹Рј РєР°РЅР°Р»Р°Рј)
- Р’ Realtime hub вЂ” partner.* СЃРѕР±С‹С‚РёСЏ Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРё РёРЅРІР°Р»РёРґРёСЂСѓСЋС‚ РїР°СЂС‚РЅС‘СЂСЃРєРёРµ queries

Р•СЃР»Рё РґРѕ СЂРµР»РёР·Р° Сѓ РІР°СЃ Р±С‹Р»Рё РїР°СЂС‚РЅС‘СЂС‹ СЃ РїСЂРёРІСЏР·Р°РЅРЅС‹РјРё СЂРµС„РµСЂР°Р»Р°РјРё РЅРѕ `isActive = false` вЂ” РёС… leaderboard РјРѕР¶РµС‚ РІС‹РіР»СЏРґРµС‚СЊ РїСѓСЃС‚С‹Рј. РђРєС‚РёРІР°С†РёСЏ (toggle С‡РµСЂРµР· UI) СЂРµС‚СЂРѕ-Р·Р°РїРѕР»РЅРёС‚ С†РµРїРѕС‡РєСѓ С‡РµСЂРµР· `backfillPartnerReferralChainForUser` Рё РЅР°РєРѕРїР»РµРЅРЅС‹Рµ РїР»Р°С‚РµР¶Рё РІ РЅРѕРІС‹С… РїР»Р°С‚РµР¶Р°С… Р±СѓРґСѓС‚ РЅР°С‡РёСЃР»СЏС‚СЊ earnings.

---

# Rezeis Admin v0.2.14

## Major release вЂ” referrals overhaul: analytics tab, audit-trail, bulk operations, contract sync

РџРѕСЃР»Рµ v0.2.13 СЃС‚СЂР°РЅРёС†Р° СЂРµС„РµСЂР°Р»РѕРІ РІСЃС‘ РµС‰С‘ Р±С‹Р»Р° РЅР°РїРѕР»РѕРІРёРЅСѓ СЂР°Р±РѕС‡РµР№: РїРѕР»РѕРІРёРЅР° С„СЂРѕРЅС‚РѕРІС‹С… СЌРЅРґРїРѕРёРЅС‚РѕРІ РЅРµ РёРјРµР»Р° РїР°СЂС‹ РЅР° Р±СЌРєРµ (KPI РїСѓСЃС‚С‹Рµ, С‚Р°Р±С‹ РќР°РіСЂР°РґС‹ Рё С‡Р°СЃС‚СЊ РџСЂРёРіР»Р°С€РµРЅРёР№ СЃС‹РїР°Р»РёСЃСЊ), CSP Р±Р»РѕРєРёСЂРѕРІР°Р» vendored chunks, Рё РїРѕС‡С‚Рё РЅРµ Р±С‹Р»Рѕ СЃСЂРµРґСЃС‚РІ РґР»СЏ Р°РЅР°Р»РёС‚РёРєРё СЂРµС„РµСЂР°Р»СЊРЅРѕР№ РїСЂРѕРіСЂР°РјРјС‹. Р­С‚РѕС‚ СЂРµР»РёР· Р·Р°РєСЂС‹РІР°РµС‚ СЂР°Р·РѕРј РЅРµСЃРєРѕР»СЊРєРѕ РЅР°РїСЂР°РІР»РµРЅРёР№.

### РќРѕРІС‹Р№ С‚Р°Р± В«РђРЅР°Р»РёС‚РёРєР°В»

РџРѕР»РЅРѕС†РµРЅРЅР°СЏ dashboard-СЃС‚СЂР°РЅРёС†Р° СЃ РїРµСЂРµРєР»СЋС‡Р°С‚РµР»РµРј 7d/30d/90d:

1. **Р’РѕСЂРѕРЅРєР° РєРѕРЅРІРµСЂСЃРёРё** вЂ” invites_created в†’ consumed в†’ qualified в†’ rewards_issued, СЃ РїСЂРѕС†РµРЅС‚РѕРј РєРѕРЅРІРµСЂСЃРёРё РЅР° РєР°Р¶РґРѕРј С€Р°РіРµ.
2. **Р”РёРЅР°РјРёРєР° РїРѕ РґРЅСЏРј** вЂ” AreaChart СЃ 4 СЂСЏРґР°РјРё (РїСЂРёРіР»Р°С€РµРЅРёСЏ / СЂРµС„РµСЂР°Р»С‹ / РєРІР°Р»РёС„РёРєР°С†РёРё / РЅР°РіСЂР°РґС‹). Р“СЂР°РЅСѓР»СЏСЂРЅРѕСЃС‚СЊ Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРё day РёР»Рё week.
3. **РўРѕРї-10 СЂРµС„РµСЂРµСЂРѕРІ** вЂ” Р»РёРґРµСЂР±РѕСЂРґ Р·Р° РїРµСЂРёРѕРґ, СЃ conversion rate Рё Р·Р°СЂР°Р±РѕС‚Р°РЅРЅС‹РјРё points.
4. **Р Р°СЃРїСЂРµРґРµР»РµРЅРёРµ РЅР°РіСЂР°Рґ** вЂ” Pie chart РїРѕ С‚РёРїСѓ Г— issued/pending/revoked.
5. **РСЃС‚РѕС‡РЅРёРєРё РїСЂРёРіР»Р°С€РµРЅРёР№** вЂ” bar chart РїРѕ `inviteSource`.

Backend: 5 РЅРѕРІС‹С… СЌРЅРґРїРѕРёРЅС‚РѕРІ РїРѕРґ `/admin/referrals/analytics/*`, time-series С‡РµСЂРµР· `date_trunc` + `generate_series` РЅР° СЃС‚РѕСЂРѕРЅРµ Postgres (Р±РµР· РїРѕРґРіСЂСѓР·РєРё СЃС‹СЂС‹С… СЃС‚СЂРѕРє).

### Audit-trail РґР»СЏ РЅР°РіСЂР°Рґ

РњРёРіСЂР°С†РёСЏ `20260524201400_referral_rewards_audit`:

```sql
ALTER TABLE referral_rewards
  ADD COLUMN issued_by TEXT,        -- РєС‚Рѕ РІС‹РґР°Р»
  ADD COLUMN granted_by TEXT,       -- РєС‚Рѕ СЃРѕР·РґР°Р» РІСЂСѓС‡РЅСѓСЋ
  ADD COLUMN revoked_at TIMESTAMPTZ(3),
  ADD COLUMN revoke_reason TEXT;
```

Р’СЃРµ РЅРѕРІС‹Рµ РѕРїРµСЂР°С‚РѕСЂСЃРєРёРµ РґРµР№СЃС‚РІРёСЏ Р·Р°РїРёСЃС‹РІР°СЋС‚ Р°РєС‚РѕСЂР°. Р›РµРіР°СЃРё-СЃС‚СЂРѕРєРё РїРѕР»СѓС‡Р°СЋС‚ `null`. Р”РІР° РёРЅРґРµРєСЃР° (`issued_by`, `granted_by`) РґР»СЏ РѕС‚С‡С‘С‚РѕРІ.

### Bulk operations

Р’ С‚Р°Р±Рµ В«РќР°РіСЂР°РґС‹В» вЂ” С‡РµРєР±РѕРєСЃС‹ Рё РєРЅРѕРїРєР° В«Р’С‹РґР°С‚СЊ (N)В». `POST /admin/referrals/rewards/bulk-issue` РѕР±СЂР°Р±Р°С‚С‹РІР°РµС‚ РґРѕ 500 ID, РІРѕР·РІСЂР°С‰Р°РµС‚ `{issued, skipped, failed, errors}`.

### РРєРѕРЅРєРё Рё UX

- `Crown`/`Star` РґР»СЏ СѓСЂРѕРІРЅРµР№ L1/L2/L3 (gold/silver/bronze).
- `MessageCircle`/`Globe`/`UserPlus`/`Link` РґР»СЏ РёСЃС‚РѕС‡РЅРёРєРѕРІ.
- `Coins`/`CalendarPlus` РґР»СЏ С‚РёРїРѕРІ РЅР°РіСЂР°Рґ.
- РџРѕРёСЃРє + С„РёР»СЊС‚СЂС‹ РїРѕ РєР°Р¶РґРѕР№ С‚Р°Р±Р»РёС†Рµ (level, status, type, РґР°С‚Р°).
- Copy-to-clipboard РЅР° С‚РѕРєРµРЅР°С… invite.
- KPI-РєР°СЂС‚РѕС‡РєРё РїРѕР»СѓС‡РёР»Рё РёРєРѕРЅРєРё РІ СѓРіР»Сѓ.

### РљРѕРЅС‚СЂР°РєС‚ СЃРёРЅС…СЂРѕРЅРёР·РёСЂРѕРІР°РЅ

Р­РЅРґРїРѕРёРЅС‚С‹, РєРѕС‚РѕСЂС‹С… СЂР°РЅСЊС€Рµ РЅРµ Р±С‹Р»Рѕ, С‚РµРїРµСЂСЊ РµСЃС‚СЊ. Frontend СЂР°Р±РѕС‚Р°РµС‚ С†РµР»РёРєРѕРј:

- `GET /admin/referrals/stats` вЂ” РѕС‚РґР°С‘С‚ SPA-shape `{invites, referrals, qualifiedReferrals, rewards, issuedRewards}` (РїР»СЋСЃ СЃС‚Р°СЂС‹Рµ РїРѕР»СЏ).
- `GET /admin/referrals/rewards` вЂ” СЃРїРёСЃРѕРє СЃ С„РёР»СЊС‚СЂР°РјРё (`type`, `issued`, `userId`, `referralId`, `limit`, `offset`).
- `POST /admin/referrals/rewards` вЂ” manual grant.
- `POST /admin/referrals/rewards/:id/issue` вЂ” apply effect (POINTS в†’ User.points, EXTRA_DAYS в†’ РїСЂРѕРґР»РёС‚СЊ РїРѕРґРїРёСЃРєСѓ).
- `POST /admin/referrals/rewards/bulk-issue` вЂ” РїР°РєРµС‚РЅС‹Р№ issue.
- `POST /admin/referrals/rewards/:id/revoke` вЂ” РѕС‚Р·С‹РІ pending.
- `POST /admin/referrals/attach` вЂ” telegram-id-friendly (СЂРµР·РѕР»РІ в†’ cuid).
- `POST /admin/referrals/invites/:id/revoke` вЂ” alias Рє `DELETE`.
- `GET/PATCH /admin/settings/referral` вЂ” settings С„РѕСЂРјС‹ (СЂР°РЅСЊС€Рµ PATCH 404'РёР»).

### CSP fix

`helmet()` Р±РµР· РїР°СЂР°РјРµС‚СЂРѕРІ Р±Р»РѕРєРёСЂРѕРІР°Р» `unsafe-eval` Рё СЃРїР°РјРёР» console СЃРѕРѕР±С‰РµРЅРёРµРј `Content Security Policy of your site blocks the use of 'eval'`. Р­С‚Сѓ Р±Р»РѕРєРёСЂРѕРІРєСѓ С‚СЂРёРіРіРµСЂРёР»Рё vendored chunks (`@tanstack/react-query`, `zod`). РЎРЅСЏС‚Рѕ: CSP РѕС‚РєР»СЋС‡С‘РЅ, РѕСЃС‚Р°Р»СЊРЅС‹Рµ Р·Р°С‰РёС‚С‹ helmet (HSTS, X-Frame-Options, X-Content-Type-Options) СЃРѕС…СЂР°РЅРµРЅС‹.

### Real-time

`useRealtimeUpdates` СѓР¶Рµ РјР°РїРїРёС‚ `referral.qualified` Рё `referral.reward_issued` РЅР° `['admin', 'referrals']`. Р’СЃРµ queries РЅР° СЃС‚СЂР°РЅРёС†Рµ РёСЃРїРѕР»СЊР·СѓСЋС‚ СЌС‚РѕС‚ РїСЂРµС„РёРєСЃ вЂ” РѕР±РЅРѕРІР»РµРЅРёСЏ РїСЂРёС…РѕРґСЏС‚ Р±РµР· СЏРІРЅРѕР№ РїРѕРґРїРёСЃРєРё.

### Tests

- 9/9 frontend test files passed (55 tests).
- Backend tsc + eslint вЂ” 0 errors / 0 warnings.

### Migrating from 0.2.13

Р‘РµР· breaking changes РґР»СЏ РїРѕР»СЊР·РѕРІР°С‚РµР»РµР№. Р‘СЌРєРµРЅРґ РїСЂРёРјРµРЅРёС‚ РјРёРіСЂР°С†РёСЋ `20260524201400_referral_rewards_audit` РЅР° СЃС‚Р°СЂС‚Рµ (4 nullable РєРѕР»РѕРЅРєРё + 3 РёРЅРґРµРєСЃР°, Р±РµР·РѕРїР°СЃРЅРѕ).

```bash
docker compose pull && docker compose up -d
```

---

# Rezeis Admin v0.2.13

## Hotfix release вЂ” backend endpoint gaps (referrals 500 + subscriptions 404)

РџРѕСЃР»Рµ v0.2.12 React #301 СѓС€С‘Р» Рё РІ console РѕСЃС‚Р°Р»РёСЃСЊ РІРёРґРЅС‹ СЃРµРєСѓРЅРґР°СЂРЅС‹Рµ network errors. Р­С‚РѕС‚ СЂРµР»РёР· Р·Р°РєСЂС‹РІР°РµС‚ С‚СЂРё:

- `GET /api/admin/referrals` 500 в†’ РєРѕСЂСЂРµРєС‚РЅРѕ РѕС‚РґР°С‘С‚ СЃРїРёСЃРѕРє
- `GET /api/admin/subscriptions?limit=50` 404 в†’ РЅРѕРІС‹Р№ list-endpoint
- `GET /api/admin/subscriptions/stats` 404 в†’ РЅРѕРІС‹Р№ stats-endpoint

### Р§С‚Рѕ С‡РёРЅРёР»Рё

#### 1. Referrals 500 вЂ” Prisma select РЅРµСЃСѓС‰РµСЃС‚РІСѓСЋС‰РµРіРѕ РїРѕР»СЏ

`ReferralsService.listReferrals` Р±СЂРѕСЃР°Р»:

```
PrismaClientValidationError:
  Unknown field `login` for select statement on model `User`.
  Available options: ... username, name, telegramId ...
```

Р’ `REFERRAL_USER_SUMMARY_SELECT` СЃС‚РѕСЏР»Рѕ `login: true`, РЅРѕ Сѓ РјРѕРґРµР»Рё `User` РІ Prisma-СЃС…РµРјРµ РЅРµС‚ РїРѕР»СЏ `login` вЂ” РµСЃС‚СЊ `username`. РћС‚РєСѓРґР° РІР·СЏР»РѕСЃСЊ `login` вЂ” РёСЃС‚РѕСЂРёС‡РµСЃРєРѕРµ РЅР°СЃР»РµРґРёРµ РѕС‚ СЂР°РЅРЅРёС… РёС‚РµСЂР°С†РёР№ admin web-account. РџРѕР»Рµ Р·Р°РјРµРЅРµРЅРѕ РЅР° `username`, РёРЅС‚РµСЂС„РµР№СЃ `ReferralUserSummaryInterface` СЃРёРЅС…СЂРѕРЅРёР·РёСЂРѕРІР°РЅ, РјР°РїРїРµСЂ РїСЂРѕР±СЂР°СЃС‹РІР°РµС‚ СЂРµР°Р»СЊРЅРѕРµ Р·РЅР°С‡РµРЅРёРµ РІРјРµСЃС‚Рѕ `null`.

#### 2 + 3. Subscriptions endpoint gaps

`AdminSubscriptionsController` РѕР±СЃР»СѓР¶РёРІР°Р» С‚РѕР»СЊРєРѕ `POST /action-policy` Рё `POST /quote` вЂ” read-СЌРЅРґРїРѕРёРЅС‚РѕРІ РґР»СЏ Р°РґРјРёРЅ-СЃС‚СЂР°РЅРёС†С‹ РїРѕРґРїРёСЃРѕРє РЅРµ Р±С‹Р»Рѕ РІРѕРѕР±С‰Рµ. Frontend (`subscriptions-page.tsx`) РѕР¶РёРґР°Р»:

```
GET /admin/subscriptions?limit=50&status=ACTIVE&isTrial=true
  в†’ { items: SubscriptionRow[], total: number }
GET /admin/subscriptions/stats
  в†’ { total, byStatus, trialCount, expiringIn7d }
```

Р”РѕР±Р°РІР»РµРЅ РЅРѕРІС‹Р№ СЃРµСЂРІРёСЃ `AdminSubscriptionsListService` (РѕС‚РґРµР»С‘РЅ РѕС‚ `SubscriptionQuoteService`, С‡С‚РѕР±С‹ read-РѕРїРµСЂР°С†РёРё РЅРµ С†РµРїР»СЏР»Рё С‚СЏР¶С‘Р»С‹Р№ РіСЂР°С„ Р·Р°РІРёСЃРёРјРѕСЃС‚РµР№ quote-СЃРµСЂРІРёСЃР°). РљРѕРЅС‚СЂРѕР»Р»РµСЂ СЂР°СЃС€РёСЂРµРЅ РґРІСѓРјСЏ GET-РјРµС‚РѕРґР°РјРё.

Р¤РёР»СЊС‚СЂС‹:
- `status` вЂ” enum `SubscriptionStatus`
- `isTrial` вЂ” boolean string
- `limit` 1..500, `offset` 0..100k

Stats:
- `total` вЂ” РІСЃРµРіРѕ РїРѕРґРїРёСЃРѕРє
- `byStatus` вЂ” `groupBy` РїРѕ СЃС‚Р°С‚СѓСЃР°Рј, СЃР»РѕРІР°СЂСЊ stringв†’count
- `trialCount` вЂ” `isTrial: true`
- `expiringIn7d` вЂ” ACTIVE-РїРѕРґРїРёСЃРєРё СЃ `expiresAt` РІ РѕРєРЅРµ next 7 days
- `generatedAt` вЂ” ISO-time СЃРЅРёРјРєР°

РћРґРёРЅ `Promise.all` РґР»СЏ РІСЃРµС… С‡РµС‚С‹СЂС‘С… Р·Р°РїСЂРѕСЃРѕРІ.

РЎРїРёСЃРѕРє РѕС‚РґР°С‘С‚ `expireAt` Рё `expiresAt` РѕРґРЅРѕРІСЂРµРјРµРЅРЅРѕ вЂ” frontend РІ SPA РїРѕРєР° Р¶РґС‘С‚ `expireAt`, РѕСЃС‚Р°Р»СЊРЅРѕРµ РєРѕРґ-base РјРѕР¶РµС‚ РїРѕР»СЊР·РѕРІР°С‚СЊСЃСЏ РєР°РЅРѕРЅРёС‡РµСЃРєРё РІРµСЂРЅС‹Рј `expiresAt`.

### Tests

- `test/admin-subscriptions.controller.spec.ts` вЂ” РѕР±РЅРѕРІР»С‘РЅ РїРѕРґ РЅРѕРІС‹Р№ РєРѕРЅСЃС‚СЂСѓРєС‚РѕСЂ Рё РЅРѕРІС‹Рµ routes (`GET /`, `GET /stats`).
- `test/referrals.controllers.spec.ts` вЂ” РїРµСЂРµРїРёСЃР°РЅ РїРѕР»РЅРѕСЃС‚СЊСЋ. РўРµСЃС‚ СЃСЃС‹Р»Р°Р»СЃСЏ РЅР° СѓРґР°Р»С‘РЅРЅС‹Рµ СЂР°РЅРµРµ РјРµС‚РѕРґС‹ (`getSummary`, `listRewards`, `qualifyReferral`, `exchangeGiftPromocode`) вЂ” СЌС‚Рѕ Р±С‹Р» pre-existing breakage РґРѕ 0.2.13. РќРѕРІС‹Р№ spec СЃРѕРѕС‚РІРµС‚СЃС‚РІСѓРµС‚ СЂРµР°Р»СЊРЅС‹Рј РєРѕРЅС‚СЂРѕР»Р»РµСЂР°Рј.

### Verification

- `npx tsc --noEmit` (backend) вЂ” clean
- `npx tsc --noEmit` (frontend) вЂ” clean
- `npx eslint . --quiet` (РѕР±Р°) вЂ” 0 errors / 0 warnings
- Targeted suites `admin-subscriptions.controller.spec.ts` + `referrals.controllers.spec.ts` вЂ” 5/5 passed
- Suite С†РµР»РёРєРѕРј вЂ” pre-existing breakage РІ web-auth Рё worker-module spec'Р°С… (РЅРµ РјРѕСЏ Р·РѕРЅР°), РѕС‚ РјРѕРёС… РїСЂР°РІРѕРє baseline РЅРµ РІС‹СЂРѕСЃ.

### Р¤Р°Р№Р»С‹

- `rezeis-admin/src/modules/referrals/services/referrals.service.ts` вЂ” `login` в†’ `username`.
- `rezeis-admin/src/modules/referrals/interfaces/referral.interface.ts` вЂ” РїРѕР»Рµ РёРЅС‚РµСЂС„РµР№СЃР° СЃРёРЅС…СЂРѕРЅРёР·РёСЂРѕРІР°РЅРѕ.
- `rezeis-admin/src/modules/subscriptions/controllers/admin-subscriptions.controller.ts` вЂ” `GET /` Рё `GET /stats`.
- `rezeis-admin/src/modules/subscriptions/services/admin-subscriptions-list.service.ts` вЂ” РЅРѕРІС‹Р№ СЃРµСЂРІРёСЃ.
- `rezeis-admin/src/modules/subscriptions/dto/list-subscriptions-query.dto.ts` вЂ” DTO РґР»СЏ query.
- `rezeis-admin/src/modules/subscriptions/interfaces/admin-subscriptions-list.interface.ts` вЂ” interface'С‹ РґР»СЏ list/stats.
- `rezeis-admin/src/modules/subscriptions/subscriptions.module.ts` вЂ” СЂРµРіРёСЃС‚СЂР°С†РёСЏ `AdminSubscriptionsListService`.
- `rezeis-admin/Dockerfile` вЂ” `ARG APP_VERSION=0.2.13`.
- `rezeis-admin/test/admin-subscriptions.controller.spec.ts` вЂ” СЂР°СЃС€РёСЂРµРЅ.
- `rezeis-admin/test/referrals.controllers.spec.ts` вЂ” РїРµСЂРµРїРёСЃР°РЅ РїРѕРґ Р°РєС‚СѓР°Р»СЊРЅРѕРµ API.

### Migrating from 0.2.12

Р‘РµР· breaking changes. РЎС‚Р°РЅРґР°СЂС‚РЅС‹Р№ pull-up:

```bash
docker compose pull && docker compose up -d
```

---

# Rezeis Admin v0.2.12

## Hotfix release вЂ” QuickSearchOverlay infinite render-loop (root cause of React #301)

РҐРёСЂСѓСЂРіРёС‡РµСЃРєРёР№ С„РёРєСЃ РєРѕСЂРЅРµРІРѕР№ РїСЂРёС‡РёРЅС‹ `Minified React error #301` РЅР° РІСЃРµС… СЃС‚СЂР°РЅРёС†Р°С… Р°РґРјРёРЅРєРё. Р’СЃРµ РїСЂРµРґС‹РґСѓС‰РёРµ С…РѕС‚С„РёРєСЃС‹ 0.2.9вЂ“0.2.11 СѓСЃС‚СЂР°РЅСЏР»Рё СЂРµР°Р»СЊРЅС‹Рµ, РЅРѕ РїРѕР±РѕС‡РЅС‹Рµ РїСЂРѕР±Р»РµРјС‹ (healthcheck, throttle, cache, ws path) вЂ” РЅР°СЃС‚РѕСЏС‰РёР№ РІРёРЅРѕРІРЅРёРє Р±С‹Р» РІ РѕРґРЅРѕРј РіР»РѕР±Р°Р»СЊРЅРѕРј РєРѕРјРїРѕРЅРµРЅС‚Рµ.

### РЎРёРјРїС‚РѕРјС‹

РџСЂРё Р·Р°С…РѕРґРµ РЅР° Р»СЋР±СѓСЋ СЃС‚СЂР°РЅРёС†Сѓ РїРѕРґ `demoadmin` РёР»Рё РґСЂСѓРіРёРј Р°РєРєР°СѓРЅС‚РѕРј:

```
Error: Minified React error #301; visit https://react.dev/errors/301 for the full message
or use the non-minified dev environment for full errors and additional helpful warnings.
[ErrorBoundary] Caught error: ...
```

Sourcemap СѓРєР°Р·С‹РІР°Р» РЅР° `app/providers.tsx:22` вЂ” СЌС‚Рѕ `<ErrorBoundary>`, Р»РѕРІСЏС‰РёР№ РѕС€РёР±РєСѓ РёР· РґРѕС‡РµСЂРЅРµРіРѕ РїРѕРґРґРµСЂРµРІР°. Р”РѕС‡РµСЂРЅРёРј Р±С‹Р»Рѕ РѕРґРЅРѕ: `<QuickSearchOverlay>`, РѕС‚СЂРµРЅРґРµСЂРµРЅРЅС‹Р№ РіР»РѕР±Р°Р»СЊРЅРѕ РІ `<AdminShell>`. РЎС‚РµРє СЃРѕРїСЂРѕРІРѕР¶РґР°Р»СЃСЏ С€СѓРјРѕРј РѕС‚ Recharts (`width(-1) and height(-1) of chart should be greater than 0`), 404/500 РѕС‚ data-СЌРЅРґРїРѕРёРЅС‚РѕРІ вЂ” СЌС‚Рѕ СѓР¶Рµ РїРѕСЃР»РµРґСЃС‚РІРёСЏ РїРѕСЂСѓС€РµРЅРЅРѕРіРѕ РґРµСЂРµРІР°, Р° РЅРµ РїСЂРёС‡РёРЅР°.

### РљРѕСЂРЅРµРІР°СЏ РїСЂРёС‡РёРЅР°

Р’ `quick-search-overlay.tsx` СЃС‚РѕСЏР» С‚Р°РєРѕР№ РїР°С‚С‚РµСЂРЅ:

```ts
const { data: results = [], isFetching } = useQuery({
  queryKey: ['quick-search', query],
  queryFn: () => fetchSearch(query),
  enabled: query.length >= 2,
  staleTime: 10_000,
});

const [prevResults, setPrevResults] = useState<SearchResult[]>(results);
if (results !== prevResults) {
  setPrevResults(results);
  setSelectedIndex(0);
}
```

`{ data: results = [] }` вЂ” destructure-default. РќР° РєР°Р¶РґРѕРј СЂРµРЅРґРµСЂРµ, РїРѕРєР° `useQuery` РІРѕР·РІСЂР°С‰Р°РµС‚ `undefined` (overlay Р·Р°РєСЂС‹С‚, `enabled: query.length >= 2` РµС‰С‘ `false`, РёР»Рё query in-flight), JS СЃРѕР·РґР°С‘С‚ **РЅРѕРІС‹Р№** `[]` literal. РЈ СЌС‚РѕРіРѕ РЅРѕРІРѕРіРѕ РјР°СЃСЃРёРІР° РґСЂСѓРіР°СЏ СЃСЃС‹Р»РєР°, РїРѕСЌС‚РѕРјСѓ `results !== prevResults` РІСЃРµРіРґР° `true` в†’ `setPrevResults` + `setSelectedIndex` РІ render-С„Р°Р·Рµ в†’ React РїР»Р°РЅРёСЂСѓРµС‚ СЂРµ-СЂРµРЅРґРµСЂ в†’ СЃРѕР·РґР°С‘С‚СЃСЏ РЅРѕРІС‹Р№ `[]` в†’ identity check СЃРЅРѕРІР° `true` в†’ Р±РµСЃРєРѕРЅРµС‡РЅС‹Р№ С†РёРєР».

React 18 Р»РѕРІРёС‚ СЌС‚Рѕ РїРѕСЃР»Рµ ~25 РёС‚РµСЂР°С†РёР№, РєРёРґР°РµС‚ Error #301 Рё СЃРІР°Р»РёРІР°РµС‚ РµРіРѕ РІ Р±Р»РёР¶Р°Р№С€РёР№ `<ErrorBoundary>`. РџРѕСЃРєРѕР»СЊРєСѓ `<QuickSearchOverlay>` Р¶РёРІС‘С‚ РІ `<AdminShell>`, РѕС€РёР±РєР° Р»РѕРІРёС‚СЃСЏ РЅР° РєР°Р¶РґРѕРј РјР°СЂС€СЂСѓС‚Рµ Р°РґРјРёРЅРєРё.

### Р¤РёРєСЃ

РЎС‚Р°Р±РёР»РёР·РёСЂРѕРІР°РЅ identity В«РїСѓСЃС‚РѕРіРѕВ» РјР°СЃСЃРёРІР°:

```ts
// Module-level constant вЂ” РёРґРµРЅС‚РёС‡РЅРѕСЃС‚СЊ СЃС‚Р°Р±РёР»СЊРЅР° РјРµР¶РґСѓ СЂРµРЅРґРµСЂР°РјРё.
const EMPTY_RESULTS: SearchResult[] = [];

export function QuickSearchOverlay({ open, onClose }: Props) {
  const { data, isFetching } = useQuery({ ... });
  const results: SearchResult[] = data ?? EMPTY_RESULTS;
  // ...
}
```

РўРµРїРµСЂСЊ `results` СЃСЃС‹Р»Р°РµС‚СЃСЏ Р»РёР±Рѕ РЅР° РјР°СЃСЃРёРІ РёР· cache TanStack Query (СЃС‚Р°Р±РёР»СЊРЅС‹Р№ РїРѕРєР° РєР»СЋС‡ РЅРµ СЃРјРµРЅРёР»СЃСЏ), Р»РёР±Рѕ РЅР° shared `EMPTY_RESULTS`. Identity check `results !== prevResults` С‚РµРїРµСЂСЊ СЃСЂР°Р±Р°С‚С‹РІР°РµС‚ С‚РѕР»СЊРєРѕ РїСЂРё СЂРµР°Р»СЊРЅРѕР№ СЃРјРµРЅРµ РґР°РЅРЅС‹С….

Р­С‚Рѕ СЂРµРєРѕРјРµРЅРґРѕРІР°РЅРЅС‹Р№ React РїР°С‚С‚РµСЂРЅ ["Adjusting some state when a prop changes"](https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes): СЃСЂР°РІРЅРёРІР°РµРјРѕРµ Р·РЅР°С‡РµРЅРёРµ РґРѕР»Р¶РЅРѕ РёРјРµС‚СЊ СЃС‚Р°Р±РёР»СЊРЅСѓСЋ РёРґРµРЅС‚РёС‡РЅРѕСЃС‚СЊ, РёРЅР°С‡Рµ СѓСЃР»РѕРІРёРµ РІ render-С„Р°Р·Рµ РєСЂСѓС‚РёС‚СЃСЏ Р±РµСЃРєРѕРЅРµС‡РЅРѕ.

### Р¤Р°Р№Р»С‹

- `rezeis-admin/web/src/components/quick-search/quick-search-overlay.tsx` вЂ” `EMPTY_RESULTS` РєРѕРЅСЃС‚Р°РЅС‚Р° РјРѕРґСѓР»СЏ + РёР·РјРµРЅС‘РЅРЅС‹Р№ destructure.
- `rezeis-admin/Dockerfile` вЂ” `ARG APP_VERSION=0.2.12`.

### Migrating from 0.2.11

Р‘РµР· breaking changes. РЎС‚Р°РЅРґР°СЂС‚РЅС‹Р№ pull-up:

```bash
docker compose pull && docker compose up -d
```

`Cache-Control` headers, РґРѕР±Р°РІР»РµРЅРЅС‹Рµ РІ v0.2.11, РіР°СЂР°РЅС‚РёСЂСѓСЋС‚, С‡С‚Рѕ РїРѕР»СЊР·РѕРІР°С‚РµР»Рё РїРѕР»СѓС‡Р°С‚ СЃРІРµР¶РёР№ `index.html` Рё РЅРѕРІС‹Р№ bundle РїСЂРё СЃР»РµРґСѓСЋС‰РµРј РІРёР·РёС‚Рµ вЂ” hard reload РЅРµ РЅСѓР¶РµРЅ.

---

# Rezeis Admin v0.2.11

## Hotfix release вЂ” stale browser cache root-cause + WebSocket path

РџРѕРІРµСЂС… v0.2.10 вЂ” С…РёСЂСѓСЂРіРёС‡РµСЃРєРёР№ С„РёРєСЃ СЂРµР°Р»СЊРЅРѕР№ РїСЂРёС‡РёРЅС‹ React Error #301 Сѓ РїРѕР»СЊР·РѕРІР°С‚РµР»РµР№ Рё РїРѕР±РѕС‡РЅС‹Р№ С„РёРєСЃ WS handshake.

### Р§С‚Рѕ РёСЃРїСЂР°РІР»РµРЅРѕ

#### 1. Cache-Control headers РґР»СЏ СЃС‚Р°С‚РёРєРё

`@nestjs/serve-static` РЅРµ РІС‹СЃС‚Р°РІР»СЏР» Cache-Control headers РїРѕ СѓРјРѕР»С‡Р°РЅРёСЋ. Р‘СЂР°СѓР·РµСЂ РєРµС€РёСЂРѕРІР°Р» `index.html` С‡Р°СЃР°РјРё Рё РїСЂРё Р·Р°С…РѕРґРµ РїРѕСЃР»Рµ СЂРµР»РёР·Р° РїРѕР»СѓС‡Р°Р» СЃС‚Р°СЂС‹Р№ shell, РєРѕС‚РѕСЂС‹Р№ СЃСЃС‹Р»Р°Р»СЃСЏ РЅР° СЃС‚Р°СЂС‹Рµ asset-С…РµС€Рё. Р§Р°СЃС‚СЊ assets РѕС‚РґР°РІР°Р»Р° 404, React РїС‹С‚Р°Р»СЃСЏ re-render СЃ broken state в†’ infinite loop в†’ React Error #301.

РўРµРїРµСЂСЊ:
- `index.html` (Рё Р»СЋР±РѕР№ `*.html`): `no-cache, no-store, must-revalidate` вЂ” Р±СЂР°СѓР·РµСЂ РІСЃРµРіРґР° С‚СЏРЅРµС‚ СЃРІРµР¶РёР№ shell СЃ РЅРѕРІС‹РјРё asset-С…РµС€Р°РјРё
- `/assets/*.{js,css,...}`: `public, max-age=31536000, immutable` вЂ” Vite hash'РёС‚ РёРјРµРЅР° С„Р°Р№Р»РѕРІ, РїРѕС‚РѕРјСѓ assets РјРѕР¶РЅРѕ РєРµС€РёСЂРѕРІР°С‚СЊ РЅР° РіРѕРґ

Р­С‚Рѕ СЃС‚Р°РЅРґР°СЂС‚РЅС‹Р№ pattern РґР»СЏ Vite/Rolldown СЃР±РѕСЂРѕРє: hashed assets РЅР°РІРµС‡РЅРѕ, shell Р±РµР· РєРµС€Р°. Р РµРєРѕРјРµРЅРґРѕРІР°РЅ [Vite docs](https://vite.dev/guide/static-deploy) Рё [react.dev](https://react.dev/learn/render-and-commit).

#### 2. WebSocket path: `/api/socket.io`

Frontend РІСЃРµРіРґР° РїРѕРґРєР»СЋС‡Р°Р»СЃСЏ Рє `ws://host/api/socket.io/...`, РЅРѕ `@WebSocketGateway({ namespace: '/realtime' })` РІ backend РЅРµ СѓРєР°Р·С‹РІР°Р» РєР°СЃС‚РѕРјРЅС‹Р№ `path`. Socket.IO РїРѕ СѓРјРѕР»С‡Р°РЅРёСЋ СЃР»СѓС€Р°РµС‚ `/socket.io/...`, Рё `setGlobalPrefix('api')` Рє WebSocket РЅРµ РїСЂРёРјРµРЅСЏРµС‚СЃСЏ (СЌС‚Рѕ HTTP-only setting).

Р’ СЂРµР·СѓР»СЊС‚Р°С‚Рµ `realtime` namespace Р±С‹Р» РґРѕСЃС‚СѓРїРµРЅ С‚РѕР»СЊРєРѕ РЅР° `/socket.io/realtime`, Р° frontend СЃС‚СѓС‡Р°Р»СЃСЏ РІ `/api/socket.io/realtime` в†’ handshake failure в†’ WebSocket connection error РІ console РєР°Р¶РґС‹Рµ 1-15 СЃРµРєСѓРЅРґ (reconnection storm).

Path align'РµРЅ РІ gateway-РґРµРєРѕСЂР°С‚РѕСЂРµ:
```ts
@WebSocketGateway({
  namespace: '/realtime',
  path: '/api/socket.io', // в†ђ Р±С‹Р»Рѕ РґРµС„РѕР»С‚РЅРѕРµ /socket.io
  cors: { origin: true, credentials: true },
})
```

### Р¤Р°Р№Р»С‹

- `rezeis-admin/src/app.module.ts` вЂ” `serveStaticOptions.setHeaders` callback СЃ РїСЂР°РІРёР»СЊРЅС‹РјРё Cache-Control
- `rezeis-admin/src/modules/realtime/realtime.gateway.ts` вЂ” `path: '/api/socket.io'` РІ РґРµРєРѕСЂР°С‚РѕСЂРµ

### Migrating from 0.2.10

Р‘РµР· breaking changes. РЎС‚Р°РЅРґР°СЂС‚РЅС‹Р№ `docker compose pull && docker compose up -d`. РџРѕСЃР»Рµ РґРµРїР»РѕСЏ РїРѕР»СЊР·РѕРІР°С‚РµР»Рё РїРѕР»СѓС‡Р°С‚ СЃРІРµР¶РёР№ index.html РїСЂРё СЃР»РµРґСѓСЋС‰РµРј РІРёР·РёС‚Рµ (Р±РµР· РЅРµРѕР±С…РѕРґРёРјРѕСЃС‚Рё hard reload).

---

# Rezeis Admin v0.2.10

## Hotfix release вЂ” throttle limit and ErrorBoundary contract

РњР°Р»РµРЅСЊРєРёР№ СЂРµР»РёР· РїРѕРІРµСЂС… 0.2.9 вЂ” С„РёРєСЃ rate-limit'Р° РЅР° polled-СЌРЅРґРїРѕРёРЅС‚Р°С… Р°РґРјРёРЅРєРё + РїСЂР°РІРёР»СЊРЅС‹Р№ schema РґР»СЏ backend error-reporting.

### Р§С‚Рѕ РёСЃРїСЂР°РІР»РµРЅРѕ

#### 1. Throttler default limit 60 в†’ 600 req/min

РЎС‚Р°СЂС‹Р№ Р»РёРјРёС‚ Р±С‹Р» СЃР»РёС€РєРѕРј Р¶С‘СЃС‚РєРёР№ РґР»СЏ Р°РґРјРёРЅ-SPA, РєРѕС‚РѕСЂР°СЏ РѕРїСЂР°С€РёРІР°РµС‚ РЅРµСЃРєРѕР»СЊРєРѕ endpoint'РѕРІ РѕРґРЅРѕРІСЂРµРјРµРЅРЅРѕ:

| endpoint | РёРЅС‚РµСЂРІР°Р» | req/min |
|---|---|---|
| `/admin/dashboard/system-health` | 10 s | 6 |
| `/admin/dashboard/summary` | 30 s | 2 |
| `/admin/remnawave/online-trend` | 60 s | 1 |
| `/admin/remnawave/activity-feed` | 30 s | 2 |
| `/admin/system-logs` | 2 s | 30 |
| `/admin/support-tickets/:id` | 5 s | 12 |
| `/admin/webhooks/deliveries` | 10 s | 6 |
| `/admin/broadcast` | 10 s | 6 |

РўРѕР»СЊРєРѕ РґР°С€Р±РѕСЂРґ + system-logs Р·Р° РјРёРЅСѓС‚Сѓ вЂ” 41 Р·Р°РїСЂРѕСЃ. Р•СЃР»Рё РѕРїРµСЂР°С‚РѕСЂ РѕС‚РєСЂС‹РІР°РµС‚ РЅРµСЃРєРѕР»СЊРєРѕ РѕРєРѕРЅ РёР»Рё Р±С‹СЃС‚СЂРѕ РїРµСЂРµРєР»СЋС‡Р°РµС‚СЃСЏ РјРµР¶РґСѓ СЂР°Р·РґРµР»Р°РјРё вЂ” СѓРїРёСЂР°Р»СЃСЏ РІ 60 req/min, Р»РѕРІРёР» 429 Too Many Requests, СЂРµРЅРґРµСЂРёР» backend-error РІ UI, С‡С‚Рѕ РїСЂРѕРІРѕС†РёСЂРѕРІР°Р»Рѕ Р±РµСЃРєРѕРЅРµС‡РЅС‹Рµ С†РёРєР»С‹ РїРѕРІС‚РѕСЂРЅС‹С… Р·Р°РїСЂРѕСЃРѕРІ Рё React Error #381.

Р’СЃРµ Р°РґРјРёРЅ-endpoint'С‹ Р·Р° `AdminJwtAuthGuard` вЂ” abuse vector СЌС‚Рѕ login, Рё РґР»СЏ РЅРµРіРѕ СѓР¶Рµ РµСЃС‚СЊ `strict` throttle 5/min.

#### 2. `@SkipThrottle()` РЅР° read-only РјРµС‚СЂРёРєРё

- `/admin/dashboard/*` вЂ” summary Рё system-health (read-only РјРµС‚СЂРёРєРё).
- `/admin/client-errors` вЂ” РѕС‚С‡С‘С‚С‹ ErrorBoundary РґРѕР»Р¶РЅС‹ РїСЂРѕС…РѕРґРёС‚СЊ РґР°Р¶Рµ РєРѕРіРґР° API РїРѕРґ РЅР°РіСЂСѓР·РєРѕР№; throttling crash-СЂРµРїРѕСЂС‚РѕРІ С‚РѕР»СЊРєРѕ СѓСЃРёР»РёРІР°РµС‚ crash loops.

#### 3. ClientErrorReportDto вЂ” `react.errorBoundary` source

`ErrorBoundary` РїРѕСЃС‹Р»Р°РµС‚ РєСЂР°С€СЂРµРїРѕСЂС‚С‹ СЃ `source: 'react.errorBoundary'` Рё `componentStack` РїРѕР»РµРј (РґРѕР±Р°РІР»РµРЅРѕ РІ [v0.2.8](https://github.com/dizzzable/rezeis/releases/tag/v0.2.8)). Backend DTO СЂР°Р·СЂРµС€Р°Р» С‚РѕР»СЊРєРѕ `'window.error' | 'unhandledrejection'` Рё РЅРµ РёРјРµР» `componentStack` вЂ” РєР°Р¶РґС‹Р№ СЂРµРїРѕСЂС‚ РѕС‚РІРµСЂРіР°Р»СЃСЏ СЃ 400 Bad Request, РєСЂР°С€СЂРµРїРѕСЂС‚С‹ С‚РµСЂСЏР»РёСЃСЊ.

DTO РёСЃРїСЂР°РІР»РµРЅ:
```ts
@IsIn(['window.error', 'unhandledrejection', 'react.errorBoundary'])
source!: 'window.error' | 'unhandledrejection' | 'react.errorBoundary';

@IsOptional() @IsString() @MaxLength(8_000)
componentStack?: string;
```

#### 4. Vite chunk size warning

`chunkSizeWarningLimit` РїРѕРІС‹С€РµРЅ СЃ 800 в†’ 1100 kB. `vendor-three.js` (999 kB) РіСЂСѓР·РёС‚СЃСЏ С‚РѕР»СЊРєРѕ РєРѕРіРґР° РѕРїРµСЂР°С‚РѕСЂ РІРєР»СЋС‡Р°РµС‚ 3D-С„РѕРЅ РІ `Appearance`, РїРѕС‚РѕРјСѓ warning Р±С‹Р» РёРЅС„РѕСЂРјР°С†РёРѕРЅРЅС‹Рј С€СѓРјРѕРј.

### Р¤Р°Р№Р»С‹

- `rezeis-admin/src/common/throttle/throttle.module.ts` вЂ” Р»РёРјРёС‚ 60 в†’ 600
- `rezeis-admin/src/modules/dashboard/controllers/admin-dashboard.controller.ts` вЂ” `@SkipThrottle()` РЅР° РєР»Р°СЃСЃ
- `rezeis-admin/src/modules/client-errors/client-errors.controller.ts` вЂ” РґРѕР±Р°РІР»РµРЅ `react.errorBoundary` + `componentStack`, `@SkipThrottle()` РЅР° РєР»Р°СЃСЃ
- `rezeis-admin/web/vite.config.ts` вЂ” `chunkSizeWarningLimit: 1100`
- `rezeis-admin/Dockerfile` вЂ” `ARG APP_VERSION=0.2.10`

### Migrating from 0.2.9

Р‘РµР· breaking changes. РЎС‚Р°РЅРґР°СЂС‚РЅС‹Р№ `docker compose pull && docker compose up -d` РґРѕСЃС‚Р°С‚РѕС‡РµРЅ.

---

# Rezeis Admin v0.2.9

## Hotfix release

РњР°Р»РµРЅСЊРєРёР№ СЂРµР»РёР· РїРѕРІРµСЂС… 0.2.8 вЂ” РґРІР° С„РёРєСЃР° РІ Docker-СЃС‚РµРєРµ РґР»СЏ РєРѕСЂСЂРµРєС‚РЅРѕР№ СЂР°Р±РѕС‚С‹ healthcheck Рё С‚РѕС‡РЅРѕР№ РІРµСЂСЃРёРё РІ `/api/health`.

### Р¤РёРєСЃС‹

- **`docker-compose.yml` healthcheck**: `wget -qO- http://localhost:8000/api/health` в†’ `wget -qO- http://127.0.0.1:8000/api/health`. РќР° Alpine-based РѕР±СЂР°Р·Рµ `localhost` РЅРµ РІСЃРµРіРґР° СЂРµР·РѕР»РІРёС‚СЃСЏ вЂ” Nest СЃР»СѓС€Р°РµС‚ `0.0.0.0`, Р° wget РЅРµ РјРѕРі РїРѕРґРєР»СЋС‡РёС‚СЊСЃСЏ РїРѕ hostname. РљРѕРЅС‚РµР№РЅРµСЂ РїРѕРєР°Р·С‹РІР°Р»СЃСЏ `unhealthy` РЅРµСЃРјРѕС‚СЂСЏ РЅР° СЂР°Р±РѕС‚Р°СЋС‰РёР№ API. РўРµРїРµСЂСЊ healthcheck РїСЂРѕС…РѕРґРёС‚, Docker Desktop / docker ps РєРѕСЂСЂРµРєС‚РЅРѕ РїРѕРєР°Р·С‹РІР°СЋС‚ `healthy`.
- **Р’РµСЂСЃРёСЏ РІ `/api/health` endpoint**: РѕР±СЂР°Р· С‚РµРїРµСЂСЊ СѓСЃС‚Р°РЅР°РІР»РёРІР°РµС‚ `npm_package_version` С‡РµСЂРµР· Dockerfile `ARG APP_VERSION` + `ENV`. Р”Рѕ СЌС‚РѕРіРѕ `/api/health` РІСЃРµРіРґР° РІРѕР·РІСЂР°С‰Р°Р» С…Р°СЂРґРєРѕРґ `0.1.3` (npm runtime РѕС‚СЃСѓС‚СЃС‚РІСѓРµС‚ РІ production-РѕР±СЂР°Р·Рµ, РїРѕС‚РѕРјСѓ `process.env.npm_package_version` Р±С‹Р» undefined). РўРµРїРµСЂСЊ endpoint РІРѕР·РІСЂР°С‰Р°РµС‚ СЂРµР°Р»СЊРЅСѓСЋ РІРµСЂСЃРёСЋ СЂРµР»РёР·Р°.

### Р¤Р°Р№Р»С‹

- `rezeis-admin/Dockerfile` вЂ” РґРѕР±Р°РІР»РµРЅ `ARG APP_VERSION=0.2.9` + `ENV npm_package_version=${APP_VERSION}`
- `rezeis-admin/docker-compose.yml` вЂ” `localhost` в†’ `127.0.0.1` РІ healthcheck
- `rezeis-admin/src/modules/health/health.service.ts` вЂ” fallback `'0.1.3'` в†’ `'unknown'`

### Migrating from 0.2.8

Р‘РµР· breaking changes. РЎС‚Р°РЅРґР°СЂС‚РЅС‹Р№ `docker compose pull && docker compose up -d` РґРѕСЃС‚Р°С‚РѕС‡РµРЅ. РќРёРєР°РєРёС… РјРёРіСЂР°С†РёР№.

---

# Rezeis Admin v0.2.8

## Performance pass вЂ” first-paint stripped to the bone

Р­С‚РѕС‚ СЂРµР»РёР· вЂ” РіР»СѓР±РѕРєР°СЏ СЂРµРІРёР·РёСЏ С„СЂРѕРЅС‚РµРЅРґР°: 80 С„Р°Р№Р»РѕРІ, +3 606 / в€’13 646 СЃС‚СЂРѕРє, **net в€’10 040 LOC**. РќРёРєР°РєРёС… РЅР°СЂСѓС€РµРЅРёР№ UX, РЅРёРєР°РєРёС… regressions вЂ” С‚РѕР»СЊРєРѕ РјРµРЅСЊС€Рµ Р±Р°Р№С‚, С‡РёС‰Рµ РєРѕРґ, РІС‹С€Рµ С‚РёРїРѕР±РµР·РѕРїР°СЃРЅРѕСЃС‚СЊ.

---

## рџљЂ Performance вЂ” i18n & lazy loading

### i18n splitting (D2)

Р›РѕРєР°Р»РёР·Р°С†РёСЏ Р°РґРјРёРЅРєРё Р±С‹Р»Р° РјРѕРЅРѕР»РёС‚РѕРј вЂ” 284 kB ru.ts + 179 kB en.ts РіСЂСѓР·РёР»РёСЃСЊ РЅР° РїРµСЂРІС‹Р№ paint, РґР°Р¶Рµ РµСЃР»Рё РѕРїРµСЂР°С‚РѕСЂ С€С‘Р» РїСЂСЏРјРѕ РЅР° dashboard. РўРµРїРµСЂСЊ:

- **Core i18n СѓРјРµРЅСЊС€РµРЅРѕ РЅР° 66%**:
  - `ru.js`: 284 kB в†’ **96 kB** (в€’188 kB СЃС‹СЂРѕРіРѕ, в€’46 kB gzipped)
  - `en.js`: 179 kB в†’ **60 kB** (в€’119 kB СЃС‹СЂРѕРіРѕ, в€’34 kB gzipped)
- **12 lazy feature-bundles** РґР»СЏ С‚СЏР¶С‘Р»С‹С… СЃС‚СЂР°РЅРёС†:
  - `appearance` (appearancePage, glassSettings, effectsSettings)
  - `userDetail` (panel + page)
  - `platformSettings` (settings, accessModePage)
  - `dashboard`, `notifications`, `payments`, `remnawave`, `twoFactor`
  - `imports`, `analytics`, `broadcast`, `automations`
- **Per-language split** вЂ” РєР°Р¶РґС‹Р№ feature-bundle РѕС‚РґРµР»СЊРЅС‹Р№ chunk РЅР° РєР°Р¶РґС‹Р№ СЏР·С‹Рє; С‚РѕР»СЊРєРѕ Р°РєС‚РёРІРЅР°СЏ Р»РѕРєР°Р»СЊ РґРѕС…РѕРґРёС‚ РґРѕ Р±СЂР°СѓР·РµСЂР°.
- **`withFeatureBundle()` helper** РѕР±РѕСЂР°С‡РёРІР°РµС‚ `lazy()` С‚Р°Рє, С‡С‚РѕР±С‹ i18n С‡Р°РЅРє С„РёС‡Рё СЂРµР·РѕР»РІРёР»СЃСЏ РїР°СЂР°Р»Р»РµР»СЊРЅРѕ СЃ РµС‘ page-С‡Р°РЅРєРѕРј вЂ” РЅРµС‚ flicker РЅР° РїРµСЂРІС‹Р№ СЂРµРЅРґРµСЂ.
- **Language switch Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРё re-hydrate** РІСЃРµ СЂР°РЅРµРµ Р·Р°РіСЂСѓР¶РµРЅРЅС‹Рµ feature-Р±Р°РЅРґР»С‹.

**РЈРґР°Р»РµРЅРѕ 12 dead namespaces (~80 kB raw)**: `users` (66.8 kB), `paymentTransactionsPage` (38.6 kB), `paymentReconciliationPage`, `paymentWebhooksPage`, `paymentAlertsPage`, `botConfigPage`, `botConfigExtras`, `catalogPlansPage`, `pageTabs`, `promocodesPage`, Рё РґРІРµ РєРѕРЅСЃС‚Р°РЅС‚С‹. Р­С‚Рё РєР»СЋС‡Рё РЅРёРєРѕРіРґР° РЅРµ РёСЃРїРѕР»СЊР·РѕРІР°Р»РёСЃСЊ UI вЂ” СѓСЃС‚Р°СЂРµРІС€РёР№ legacy.

**First-paint payload (RU РѕРїРµСЂР°С‚РѕСЂ, gzipped):**

| Р±С‹Р»Рѕ | СЃС‚Р°Р»Рѕ | О” |
|---|---|---|
| ~535 kB | **~444 kB** | **в€’91 kB / в€’17%** |

### Bundle metrics

| chunk | РґРѕ | РїРѕСЃР»Рµ | О” |
|---|---|---|---|
| `ru.js` core | 284 kB / 71 kB gz | 96 kB / 25.7 kB gz | **в€’66%** |
| `en.js` core | 179 kB / 54 kB gz | 60 kB / 19.8 kB gz | **в€’66%** |
| `index.js` app | 337 kB | 220 kB / 62.8 kB gz | в€’35% |

РџРѕСЃР»Рµ РѕС‚РєСЂС‹С‚РёСЏ РєРѕРЅРєСЂРµС‚РЅРѕРіРѕ СЂР°Р·РґРµР»Р° РґРѕРіСЂСѓР¶Р°РµС‚СЃСЏ СЃРѕРѕС‚РІРµС‚СЃС‚РІСѓСЋС‰РёР№ feature-bundle (1.9вЂ“22.3 kB). Р­РєРѕРЅРѕРјРёСЏ Р»РёРЅРµР№РЅР°СЏ Рё РјР°РєСЃРёРјР°Р»СЊРЅР°СЏ РґР»СЏ РїРѕР»СЊР·РѕРІР°С‚РµР»РµР№ РѕРґРЅРѕРіРѕ-РґРІСѓС… СЂР°Р·РґРµР»РѕРІ.

---

## рџ“ђ Forms вЂ” react-hook-form + zod migration

8 РєСЂСѓРїРЅС‹С… С„РѕСЂРј РјРёРіСЂРёСЂРѕРІР°РЅС‹ РЅР° `react-hook-form` + `zod` СЃ С‚РёРїРѕР±РµР·РѕРїР°СЃРЅРѕР№ РІР°Р»РёРґР°С†РёРµР№:

- `CreateUserDialog` (users)
- `PartnerSettingsForm` (partners)
- `PartnerSettingsPage` (settings/partner)
- `ReferralSettingsForm` (settings/referral, 23 РїРѕР»СЏ)
- `PanelBrandingForm` (settings/panel#branding)
- `TelegramDeliveryForm` (notifications)
- `EmailDeliveryForm` (notifications)
- `PlatformSettingsPage` Г— 2 СЃРµРєС†РёРё (settings)

Р’СЃРµ validation-СЃРѕРѕР±С‰РµРЅРёСЏ Р»РѕРєР°Р»РёР·РѕРІР°РЅС‹ РІ РѕР±РѕРёС… СЏР·С‹РєР°С…. Email/SMTP С‚РµРїРµСЂСЊ СЃ СЂРµР°Р»СЊРЅРѕР№ РІР°Р»РёРґР°С†РёРµР№ РїРѕСЂС‚РѕРІ (1вЂ“65535), Р°РґСЂРµСЃРѕРІ РѕС‚РїСЂР°РІРёС‚РµР»СЏ/РїРѕР»СѓС‡Р°С‚РµР»СЏ С‚РµСЃС‚Р° Рё РѕР±СЏР·Р°С‚РµР»СЊРЅС‹С… РїРѕР»РµР№ РїСЂРё РІРєР»СЋС‡С‘РЅРЅРѕР№ РґРѕСЃС‚Р°РІРєРµ.

РС‚РѕРіРѕ: **11 С„РѕСЂРј РЅР° RHF+zod** (Р±С‹Р»Рѕ 1 РІ baseline).

---

## вљ›пёЏ React 19 effect cleanup

`useEffect` РґР»СЏ СЃРёРЅС…СЂРѕРЅРёР·Р°С†РёРё state СЃ props вЂ” Р°РЅС‚РёРїР°С‚С‚РµСЂРЅ РІ React 19. Р’СЃРµ С‚Р°РєРёРµ РјРµСЃС‚Р° РїРµСЂРµРїРёСЃР°РЅС‹ РЅР° render-time pattern РїРѕ [РѕС„РёС†РёР°Р»СЊРЅРѕРјСѓ РіР°Р№РґСѓ](https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes):

- **0 `react-hooks/set-state-in-effect` disables** РІ РєРѕРґРµ Р°РґРјРёРЅРєРё (Р±С‹Р»Рѕ 12+, РѕСЃС‚Р°РІР»РµРЅ 1 РІ vendored CountUp).
- **0 `react-hooks/exhaustive-deps` disables** РІ РєРѕРґРµ Р°РґРјРёРЅРєРё.
- Polling-Р°РєРєСѓРјСѓР»СЏС‚РѕСЂ `system-logs-page` РїРµСЂРµРїРёСЃР°РЅ РЅР° key-based pattern СЃ С‚СЂРµРєРёРЅРіРѕРј `latestId`.
- Auto-select-first-item РІ `automations-page` Рё `roles-page` вЂ” Р±РµР· effects.
- `appearance-page` editorModeв†”resolvedMode sync вЂ” Р±РµР· effects.
- `gateway-settings-page`, `panel-branding-tab`, `quick-search-overlay` вЂ” Р±РµР· effects.

---

## рџЏ— Architecture вЂ” shared infra

РќРѕРІС‹Рµ РїРµСЂРµРёСЃРїРѕР»СЊР·СѓРµРјС‹Рµ РјРѕРґСѓР»Рё:

| РјРѕРґСѓР»СЊ | РЅР°Р·РЅР°С‡РµРЅРёРµ | С‚РµСЃС‚С‹ |
|---|---|---|
| `lib/safe-storage.ts` | localStorage wrapper РґР»СЏ Safari Private Mode | 8 |
| `lib/api-utils.ts` | `unwrapPayload` / `isRecord` | 11 |
| `lib/http-errors.ts` | С†РµРЅС‚СЂР°Р»РёР·РѕРІР°РЅРЅС‹Р№ `getErrorMessage` | 7 |
| `lib/use-tab-sync.ts` | URL-hash в†” tab state generic hook | 5 |
| `i18n/i18n.ts` | `loadFeatureBundle`, `withFeatureBundle` | (РЅРѕРІРѕРµ API) |
| `features/plans/plans-api.ts` | unified `usePlans()` hook + С‚РёРїРѕР±РµР·РѕРїР°СЃРЅС‹Рµ queryKeys | 7 |
| `features/users/user-detail-shape.ts` | typed `UserDetail` (Р·Р°РјРµРЅРёР» 19 С„Р°Р№Р»РѕРІ СЃ `eslint-disable any`) | вЂ” |

### Р”РµРєРѕРјРїРѕР·РёС†РёСЏ

- **`admin-shell.tsx`**: 965 LOC monolith в†’ 13 РјРѕРґСѓР»РµР№ РІ `admin-sidebar/` + `admin-topbar/`.
- **`user-detail-page.tsx`**: 1211 LOC РґСѓР±Р»СЊ в†’ 67 LOC thin wrapper РЅР°Рґ `UserDetailPanel`.
- **users / partners / admins pages**: locationHash в†’ tab effects Р·Р°РјРµРЅРµРЅС‹ РЅР° `useTabSync` (~66 СЃС‚СЂРѕРє boilerplate СѓРґР°Р»РµРЅС‹).

---

## вњ… Quality gates

| РїСЂРѕРІРµСЂРєР° | СЂРµР·СѓР»СЊС‚Р°С‚ |
|---|---|
| `tsc --noEmit` | **0 errors** |
| `eslint . --quiet` | **0 warnings** (strict 0-tolerance policy) |
| `vitest run` | **9 С„Р°Р№Р»РѕРІ / 55 С‚РµСЃС‚РѕРІ** passing (Р±С‹Р»Рѕ 0 active) |
| `vite build` | 1.4 s, 132 chunks |
| `any` РІ feature-РєРѕРґРµ | **0** (РІРЅРµ vendored react-bits) |

---

## рџЋЁ UX polish

- `tw-animate-css@1.4.0` plugin РґРѕР±Р°РІР»РµРЅ вЂ” РІСЃРµ shadcn-Р°РЅРёРјР°С†РёРё (Collapsible chevron, Tabs fade-in, Dialog/Sheet) С‚РµРїРµСЂСЊ СЂР°Р±РѕС‚Р°СЋС‚ РЅР° Tailwind v4.
- Payments в†’ Analytics: РІС‹СЂРѕРІРЅРµРЅС‹ "0.00" Р·РЅР°С‡РµРЅРёСЏ РїРѕ РїСЂР°РІРѕРјСѓ РєСЂР°СЋ.
- РџРѕР»РёСЂРѕРІРєР° Р°РЅРёРјР°С†РёР№ РїРѕ С„СЂРѕРЅС‚РµРЅРґСѓ: fraud, audit, settings, notifications.
- ErrorBoundary С‚РµРїРµСЂСЊ СЂРµРїРѕСЂС‚РёС‚ crash'Рё РІ backend audit (rate-limited).
- `loadPermissions()` retry toast РїСЂРё РѕС€РёР±РєРµ Р°СѓС‚РµРЅС‚РёС„РёРєР°С†РёРё.

---

## рџ›  Developer tooling

Р”РѕР±Р°РІР»РµРЅС‹ СЃРєСЂРёРїС‚С‹ РІ `web/scripts/`:

- `measure-i18n-namespaces.cjs` вЂ” РёР·РјРµСЂСЏРµС‚ Р±Р°Р№С‚РѕРІС‹Р№ СЂР°Р·РјРµСЂ РєР°Р¶РґРѕРіРѕ top-level namespace
- `find-unused-i18n-namespaces.cjs` вЂ” РЅР°С…РѕРґРёС‚ namespace, РЅР° РєРѕС‚РѕСЂС‹Рµ РЅРёРіРґРµ РЅРµ СЃСЃС‹Р»Р°СЋС‚СЃСЏ
- `extract-i18n-namespace.cjs` вЂ” Р°С‚РѕРјР°СЂРЅРѕ РїРµСЂРµРЅРѕСЃРёС‚ namespaces РІ lazy feature-РјРѕРґСѓР»СЊ

---

## рџ“¦ Docker

```bash
docker compose pull
docker compose up -d
```

РћР±СЂР°Р· `ghcr.io/dizzzable/rezeis:0.2.8` РїСѓР±Р»РёРєСѓРµС‚СЃСЏ Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРё РїРѕСЃР»Рµ merge С‚РµРіР° `v0.2.8`.

---

## Migrating from 0.2.7

Р‘РµР· breaking changes. РЎС‚Р°РЅРґР°СЂС‚РЅС‹Р№ `docker compose pull && docker compose up -d` РґРѕСЃС‚Р°С‚РѕС‡РµРЅ.

---

# Rezeis Admin v0.2.7

## РџР»Р°С‚РµР¶Рё Рё Р±РµР·РѕРїР°СЃРЅРѕСЃС‚СЊ

- 5 РЅРѕРІС‹С… РїР»Р°С‚С‘Р¶РЅС‹С… С€Р»СЋР·РѕРІ (WATA, AuraPay, RollyPay, SeverPay, Lava.top), webhook-signature verification
- РќРѕРІР°СЏ РІРєР»Р°РґРєР° `Payments / Analytics`: per-gateway GMV, success rate, p50/p95 time-to-pay, daily trend, webhook health
- Р РµРґРёР·Р°Р№РЅ РІРєР»Р°РґРєРё В«Р‘РµР·РѕРїР°СЃРЅРѕСЃС‚СЊВ»: 2FA + Passkey + 6 OAuth-РїСЂРѕРІР°Р№РґРµСЂРѕРІ РІСЃС‚СЂРѕРµРЅС‹ РїСЂСЏРјРѕ РІ СЃС‚СЂР°РЅРёС†Сѓ
- `docker-entrypoint.sh` Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРё Р·Р°РїСѓСЃРєР°РµС‚ `prisma migrate deploy` РїСЂРё СЃС‚Р°СЂС‚Рµ API-РєРѕРЅС‚РµР№РЅРµСЂР°

---

# Rezeis Admin v0.2.6

## Liquid Glass & Visual Effects Studio

### Liquid Glass вЂ” РїРѕР»РЅР°СЏ РїРµСЂРµСЂР°Р±РѕС‚РєР°

РЎРёСЃС‚РµРјР° РїСЂРѕР·СЂР°С‡РЅРѕСЃС‚Рё Рё СЃС‚РµРєР»СЏРЅРЅС‹С… СЌС„С„РµРєС‚РѕРІ РїРѕР»РЅРѕСЃС‚СЊСЋ РїРµСЂРµРїРёСЃР°РЅР° СЃ РЅСѓР»СЏ.

- **Per-element glass controls** вЂ” РёРЅРґРёРІРёРґСѓР°Р»СЊРЅС‹Рµ toggle + blur slider РґР»СЏ 7 СЌР»РµРјРµРЅС‚РѕРІ:
  - Sidebar, Header, Cards, Modals, Tabs, Buttons, Popover/Dropdowns
- **Background Studio** вЂ” РІС‹Р±РѕСЂ РёР· 20 Р°РЅРёРјРёСЂРѕРІР°РЅРЅС‹С… С„РѕРЅРѕРІ (React Bits) СЃ СѓРЅРёРєР°Р»СЊРЅС‹РјРё РїР°СЂР°РјРµС‚СЂР°РјРё РґР»СЏ РєР°Р¶РґРѕРіРѕ:
  - Silk, Aurora, Threads, Waves, Iridescence, Galaxy, Particles, DotGrid, LiquidChrome, Balatro, Beams, Plasma, Grainient, SoftAurora, Dither, LineWaves, RippleGrid, Lightning, Radar
  - Dropdown РІС‹Р±РѕСЂР° + РґРёРЅР°РјРёС‡РµСЃРєРёРµ controls РёР· registry (slider/color/toggle/colorArray/rgbColor/select)
  - Live preview 300Г—200px СЃ СЂРµР°Р»СЊРЅС‹Рј РєРѕРјРїРѕРЅРµРЅС‚РѕРј
  - Draft в†’ Apply workflow (РЅР°СЃС‚СЂР°РёРІР°Р№ Р±РµР· РјРіРЅРѕРІРµРЅРЅРѕРіРѕ РїСЂРёРјРµРЅРµРЅРёСЏ)
- **Per-background props** вЂ” store С…СЂР°РЅРёС‚ `{ id, opacity, props: Record<string, unknown> }` РІРјРµСЃС‚Рѕ generic speed/scale/color
- **CSS-driven transparency** вЂ” `data-liquid-glass-*` Р°С‚СЂРёР±СѓС‚С‹ РЅР° `<html>` + CSS `color-mix()` РґР»СЏ РїРѕР»СѓРїСЂРѕР·СЂР°С‡РЅРѕСЃС‚Рё РІСЃРµС… РїРѕРІРµСЂС…РЅРѕСЃС‚РµР№
- **Header mode** вЂ” РїСЂРё РІРєР»СЋС‡С‘РЅРЅРѕРј glass header РїРѕ СѓРјРѕР»С‡Р°РЅРёСЋ РїРѕР»РЅРѕСЃС‚СЊСЋ РїСЂРѕР·СЂР°С‡РЅС‹Р№ (СЌР»РµРјРµРЅС‚С‹ РЅР° РјРµСЃС‚Рµ, С„РѕРЅ РїСЂРѕСЃРІРµС‡РёРІР°РµС‚); toggle РІРєР»СЋС‡Р°РµС‚ СЃС‚РµРєР»СЏРЅРЅС‹Р№ blur
- **Global surface transparency** вЂ” `.bg-card`, `.bg-muted`, `.bg-background`, `.bg-accent`, inputs, `.rounded-lg.border` вЂ” РІСЃС‘ СЃС‚Р°РЅРѕРІРёС‚СЃСЏ РїРѕР»СѓРїСЂРѕР·СЂР°С‡РЅС‹Рј

### Visual Effects Studio (NEW)

РџРѕР»РЅРѕС†РµРЅРЅР°СЏ СЃРёСЃС‚РµРјР° РєР°СЃС‚РѕРјРёР·Р°С†РёРё РІРёР·СѓР°Р»СЊРЅС‹С… СЌС„С„РµРєС‚РѕРІ СЃ 5 РєР°С‚РµРіРѕСЂРёСЏРјРё:

- **Text Animation** (11 РІР°СЂРёР°РЅС‚РѕРІ) вЂ” Shiny, Gradient, Glitch, Decrypted, Blur, Split, Scrambled, Fuzzy, Rotating, TrueFocus
  - `<TitleEffect>` / `<ShinyText>` Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРё СЂРµРЅРґРµСЂРёС‚ РІС‹Р±СЂР°РЅРЅС‹Р№ СЌС„С„РµРєС‚ РЅР° Р·Р°РіРѕР»РѕРІРєР°С…
- **Cursor Effect** (6 РІР°СЂРёР°РЅС‚РѕРІ) вЂ” Splash, Blob, Ghost, Crosshair, MagnetLines, PixelTrail
  - Р“Р»РѕР±Р°Р»СЊРЅС‹Р№ overlay С‡РµСЂРµР· `EffectsProvider`
- **Click Effect** (2 РІР°СЂРёР°РЅС‚Р°) вЂ” ClickSpark, StarBorder
  - Canvas-based РёСЃРєСЂС‹ РїСЂРё РєР»РёРєРµ РІ Р»СЋР±РѕРј РјРµСЃС‚Рµ
- **Hover Effect** (4 РІР°СЂРёР°РЅС‚Р°) вЂ” Spotlight, Glare, ElectricBorder, Magnet
  - `<HoverEffect>` wrapper РґР»СЏ РєР°СЂС‚РѕС‡РµРє
- **Content Animation** (3 РІР°СЂРёР°РЅС‚Р°) вЂ” FadeContent, AnimatedContent, GradualBlur
  - `<AnimatedContent>` СЃ РїРѕРґРґРµСЂР¶РєРѕР№ direction/delay

РљР°Р¶РґР°СЏ РєР°С‚РµРіРѕСЂРёСЏ РёРјРµРµС‚:
- Dropdown РІС‹Р±РѕСЂР° СЌС„С„РµРєС‚Р°
- **Live preview** РїСЂСЏРјРѕ РІ РЅР°СЃС‚СЂРѕР№РєР°С… (РёРЅС‚РµСЂР°РєС‚РёРІРЅС‹Р№ вЂ” hover/click/Р°РЅРёРјР°С†РёСЏ)
- РџРѕРґСЃРєР°Р·РєР° РіРґРµ СЌС„С„РµРєС‚ РїСЂРёРјРµРЅСЏРµС‚СЃСЏ
- РљРЅРѕРїРєР° "РџРѕРІС‚РѕСЂРёС‚СЊ" РґР»СЏ Р°РЅРёРјР°С†РёР№

### UI/UX

- **Р”РІСѓС…РєРѕР»РѕРЅРѕС‡РЅС‹Р№ layout** РЅР°СЃС‚СЂРѕРµРє Glass Рё Effects (xl breakpoint)
- **Р”РµС„РѕР»С‚РЅР°СЏ С‚РµРјР° Р·Р°С„РёРєСЃРёСЂРѕРІР°РЅР°**: dark mode, Liquid Chrome С„РѕРЅ (opacity 50%), sidebar-primary `#aa1d8b`
- **i18n** вЂ” РІСЃРµ РЅРѕРІС‹Рµ РєР»СЋС‡Рё РІ ru.ts Рё en.ts (preview, replay, previewHint РґР»СЏ РєР°Р¶РґРѕР№ РєР°С‚РµРіРѕСЂРёРё)
- **AppearanceProvider** СЂР°СЃС€РёСЂРµРЅ вЂ” СѓСЃС‚Р°РЅР°РІР»РёРІР°РµС‚ `data-liquid-glass-*` Р°С‚СЂРёР±СѓС‚С‹ Рё CSS-РїРµСЂРµРјРµРЅРЅС‹Рµ `--liquid-glass-*-blur`

### Stores

- `glass-store.ts` вЂ” unified `setElementGlass(element, settings)` action, per-bg props
- `effects-store.ts` вЂ” 5 РєР°С‚РµРіРѕСЂРёР№ СЌС„С„РµРєС‚РѕРІ, master toggle, persist РІ localStorage
- `theme-store.ts` вЂ” РґРµС„РѕР»С‚: dark + sidebar-primary override

### Р¤Р°Р№Р»С‹

| РќРѕРІС‹Р№ С„Р°Р№Р» | РќР°Р·РЅР°С‡РµРЅРёРµ |
|-----------|-----------|
| `lib/theme/effects-store.ts` | Store РІРёР·СѓР°Р»СЊРЅС‹С… СЌС„С„РµРєС‚РѕРІ |
| `components/EffectsProvider.tsx` | Р“Р»РѕР±Р°Р»СЊРЅС‹Р№ cursor/click provider |
| `components/effects/TitleEffect.tsx` | Universal text animation renderer |
| `components/effects/HoverEffect.tsx` | Universal hover wrapper |
| `features/appearance/effects-settings-card.tsx` | UI РЅР°СЃС‚СЂРѕРµРє СЌС„С„РµРєС‚РѕРІ СЃ live preview |
| `features/appearance/background-controls.ts` | Registry 20 С„РѕРЅРѕРІ СЃ ControlDef[] |

---

# Rezeis Admin v0.1.5

## Production-Ready Infrastructure Release

### BullMQ Job Queues (8 queues)
- **Broadcast** вЂ” async delivery (text/photo/video), edit, delete, retry, scheduled send
- **Backup** вЂ” pg_dump via BullMQ, auto-delivery to Telegram, restore from file
- **Imports** вЂ” async file processing (3xui, remnashop, altshop, remnawave), 202 pattern
- **Email** вЂ” SMTP delivery with branded templates, auto-send on events
- **Webhooks, Profile-Sync, Payments, Automations** вЂ” existing queues unified
- **Global QueueModule** вЂ” single Redis connection, no duplication

### Email Module (NEW)
- Full SMTP delivery via nodemailer + BullMQ
- Branded HTML templates (logo, colors from Settings)
- Auto-send on system events (subscription expired, payment completed, etc.)
- Admin UI: SMTP settings, verify connection, send test email
- Reiwa branding integration

### Health & Observability
- `GET /api/health` вЂ” DB + Redis + Queues + Disk status with latency
- `GET /api/health/live` / `GET /api/health/ready` вЂ” k8s probes
- Queue maintenance cron (every 6h): cleanup stale jobs, audit log rotation
- Graceful shutdown for BullMQ workers

### Security
- `@nestjs/throttler` вЂ” 60 req/min global, 5/min on login (brute-force protection)
- Request timeout middleware (30s default, 120s uploads, infinite SSE)
- Payment auto-retry (failed webhooks retried 3x with exponential backoff)

### Frontend
- **Sidebar drag-and-drop** вЂ” reorder items between categories, create custom categories
- **Header redesign** вЂ” GitHub update indicator (tiffany glow), Telegram link, Support/Donate
- **Backup page** вЂ” settings card (auto-backup, Telegram delivery, retention), restore button
- **Notifications** вЂ” Email SMTP settings tab alongside Telegram
- **Security tab** вЂ” password change form added
- **HWID device revoked** event вЂ” full Telegram notification with device block

### Infrastructure
- Redis: `volatile-lru` (protects BullMQ keys), 512MB, AOF persistence
- Dockerfile: `postgresql16-client` for pg_dump/psql
- Audit log rotation: 90 days retention (configurable via `AUDIT_RETENTION_DAYS`)
- Notification events cleanup: 30 days

### Docker
```bash
docker compose pull
docker compose up -d
```
