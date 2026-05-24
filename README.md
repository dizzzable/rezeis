<p align="center">
  <img src="docs/logo.svg" width="80" alt="Rezeis Logo" />
</p>

<h1 align="center">Rezeis Admin Panel</h1>

<p align="center">
  <strong>Полнофункциональная админ-панель для управления VPN-сервисом на базе Remnawave</strong>
</p>

<p align="center">
  <a href="https://github.com/dizzzable/rezeis/releases/latest"><img src="https://img.shields.io/badge/version-0.2.11-blue" alt="Version" /></a>
  <a href="https://github.com/dizzzable/rezeis/pkgs/container/rezeis"><img src="https://img.shields.io/badge/ghcr.io-rezeis-2496ED?logo=docker&logoColor=white" alt="GHCR" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License" /></a>
  <a href="#"><img src="https://img.shields.io/badge/NestJS-11-red" alt="NestJS" /></a>
  <a href="#"><img src="https://img.shields.io/badge/React-19-61dafb" alt="React" /></a>
  <a href="#"><img src="https://img.shields.io/badge/TypeScript-5.9-3178c6" alt="TypeScript" /></a>
  <a href="#"><img src="https://img.shields.io/badge/Prisma-7-2d3748" alt="Prisma" /></a>
  <a href="#"><img src="https://img.shields.io/badge/PostgreSQL-17-336791" alt="PostgreSQL" /></a>
</p>

---

## 🎯 О проекте

Rezeis — продвинутая админ-панель для управления VPN-инфраструктурой, построенной на [Remnawave Panel](https://github.com/remnawave/panel). Один интерфейс для управления пользователями, подписками, платежами, нодами и мониторинга всей системы.

**Ключевые отличия:**
- 🏗 Монорепо: бэкенд + фронтенд + воркер в одном проекте
- 🔗 Глубокая интеграция с Remnawave через `@remnawave/backend-contract` SDK
- 📊 Real-time мониторинг VPS, процесса и VPN-инфраструктуры
- 🛡 Anti-Abuse система с 8 детекторами
- 💰 **15 платёжных шлюзов** + полная аналитика по каждому
- 🔐 **WebAuthn / Passkey** + 6 OAuth-провайдеров для входа в админку
- 🤖 Telegram-бот интеграция (Reiwa)
- 🚀 Docker-образ с автомиграциями Prisma при старте

---

## ✨ Что нового в v0.2.11

Hotfix-релиз: критический фикс stale browser cache + WebSocket path mismatch.

### Корневая причина React Error #301 у пользователей

После релиза v0.2.10 пользователи всё ещё видели ошибки `Minified React error #301` (Too many re-renders) на разных страницах. Корневая причина — **stale browser cache**.

`@nestjs/serve-static` по умолчанию не выставляет `Cache-Control` headers. Браузер кешировал `index.html` агрессивно (часами), и при заходе на сайт после релиза получал старый shell, который ссылался на старые asset-хеши (`vendor-react-CzlTIVs3.js` вместо нового `vendor-react-CzlTIVsJ.js`). Часть assets отдавала 404 → React пытался re-render с broken state → infinite loop → #301.

### Фиксы

- **`Cache-Control` headers для статики**:
  - `index.html` (и любой `*.html`): `no-cache, no-store, must-revalidate` — браузер всегда тянет свежий shell
  - `/assets/*.{js,css,...}`: `public, max-age=31536000, immutable` — assets с hash в имени можно кешировать на год
  
  Это стандартный pattern для Vite-сборок, рекомендованный документацией Vite/React.

- **WebSocket path: `/api/socket.io`**. Frontend всегда подключался к `/api/socket.io/...`, но `@WebSocketGateway` в backend не указывал кастомный path. Socket.IO по умолчанию слушает `/socket.io/...`, и `setGlobalPrefix('api')` к WebSocket не применяется. Путь align'ен в gateway-декораторе. WS connection теперь работает.

### Migrating from 0.2.10

Без breaking changes. Стандартный `docker compose pull && docker compose up -d`. После деплоя пользователи получат свежий index.html при следующем визите (без необходимости hard reload).

---

## ✨ Что нового в v0.2.10

Hotfix-релиз: фикс rate-limit'а на polled-эндпоинтах админки + правильный schema для error-reporting.

### Фиксы

- **Throttler limit повышен с 60 → 600 req/min**. Старый лимит 60 в минуту валился сразу: дашборд один опрашивает `system-health` каждые 10 с (6/min), `summary` каждые 30 с (2/min), `online-trend` каждые 60 с, `activity-feed` каждые 30 с, `system-logs` каждые 2 с (30/min). Открыть дашборд + system-logs одновременно — за минуту перевалить за 60 запросов даже одной вкладкой. Все админ-эндпоинты сидят под `AdminJwtAuthGuard`, потому login (5/min strict) остаётся главной brute-force защитой.
- **`@SkipThrottle()` на read-only метрики**:
  - `/admin/dashboard/*` — summary и system-health опрашиваются часто, abuse vector нулевой.
  - `/admin/client-errors` — отчёты ErrorBoundary должны проходить даже когда основной API под нагрузкой; throttling здесь только усугубляет crash loops.
- **`/api/admin/client-errors` DTO**: добавлен `'react.errorBoundary'` source и `componentStack` поле. До этого ErrorBoundary репортов backend отвергал с 400 Bad Request — крашрепорты терялись.
- **`chunkSizeWarningLimit`** поднят с 800 → 1100 kB в vite.config.ts. `vendor-three.js` (999 kB) грузится только когда оператор включает 3D-фон, потому warning был информационным шумом.

### Migrating from 0.2.9

Без breaking changes. Стандартный `docker compose pull && docker compose up -d` достаточен.

---

## ✨ Что нового в v0.2.9

Hotfix-релиз поверх 0.2.8 — два маленьких но заметных фикса в Docker-стеке.

### Фиксы

- **`docker compose` healthcheck**: `localhost` → `127.0.0.1` в healthcheck главного контейнера. На Alpine `localhost` не всегда резолвится корректно — Nest слушал `0.0.0.0:8000`, а wget не мог подключиться. Контейнер показывался `unhealthy` хотя API работал. Теперь healthcheck проходит.
- **Версия в `/api/health`**: образ теперь экспортирует `npm_package_version` через Dockerfile `ARG APP_VERSION` → ENV. До этого `/api/health` всегда возвращал хардкод `0.1.3`. Теперь возвращает реальную версию релиза.

Обновление безопасно поверх 0.2.8 — никаких миграций, никаких breaking changes.

```bash
docker compose pull
docker compose up -d
```

---

## ✨ Что нового в v0.2.8

### Performance — first-paint stripped

Полная переработка системы локализации админки и aggressive lazy-loading на уровне feature-модулей.

- **i18n-ядро уменьшено на 66%**: `ru.js` 284 → 96 kB, `en.js` 179 → 60 kB. На gzipped first-paint экономия **~46 kB** для русскоязычного оператора.
- **12 lazy feature-bundles** для тяжёлых страниц: `appearance`, `userDetail`, `platformSettings`, `dashboard`, `notifications`, `payments`, `remnawave`, `twoFactor`, `imports`, `analytics`, `broadcast`, `automations`. Каждый split по языку — только активная локаль доходит до браузера.
- **`withFeatureBundle()` helper** оборачивает `lazy()` так, чтобы i18n-чанк фичи резолвился параллельно с её page-чанком — нет flicker на первый рендер.
- **Удалено 12 dead-namespace** (~80 kB сырого размера) — `users`, `paymentTransactionsPage`, `paymentReconciliationPage`, `paymentWebhooksPage`, `paymentAlertsPage`, `botConfigPage`, `botConfigExtras` и др. Эти ключи никогда не использовались в UI.
- **i18n-language switch автоматически re-hydrate**: если оператор открыл несколько фичей и потом переключил язык — все ранее загруженные feature-бандлы перезагружаются на новый язык параллельно.

### Forms — react-hook-form + zod migration

- 8 крупных форм мигрированы на `react-hook-form` + `zod` с типобезопасной валидацией:
  - `CreateUserDialog` (users), `PartnerSettingsForm`, `PartnerSettingsPage`
  - `ReferralSettingsForm` (23 поля), `PanelBrandingForm`
  - `TelegramDeliveryForm`, `EmailDeliveryForm` (notifications)
  - `PlatformSettingsPage` × 2 секции
- Все validation-сообщения локализованы через `t()` ключи в обоих языках.
- Email/SMTP теперь с реальной валидацией портов, адресов отправителя и получателя теста.

### React 19 effect cleanup

- **0 disable-комментариев** `react-hooks/set-state-in-effect` и `react-hooks/exhaustive-deps` в коде админки (было 12+).
- "Reset state when prop changes" effects переписаны на render-time pattern по [официальному гайду React](https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes) — без `useEffect`.
- Polling-аккумулятор `system-logs-page` переписан на key-based pattern с трекингом `latestId`.
- Auto-select-first-item патчи в `automations-page` и `roles-page` — без effects.

### Architecture

- **`useTabSync<T>`** — generic hook для bidirectional URL hash ↔ state sync. Заменяет ~22 строки бойлерплейта в `users-page`, `partners-page`, `admins-page`. С unit-тестами.
- **`safe-storage`** — wrapper для `localStorage` с graceful fallback в Safari Private Mode.
- **`api-utils`** — `unwrapPayload`, `isRecord` helpers + 11 unit-тестов.
- **`http-errors`** — централизованный `getErrorMessage` (NestJS + axios + Error → строка) + 7 unit-тестов.
- **`plans-api.ts`** — unified `usePlans()` hook + типобезопасные queryKeys + 7 unit-тестов.
- **`user-detail-shape.ts`** — типизированный `UserDetail` interface заменил 19 файлов с `eslint-disable @typescript-eslint/no-explicit-any`.
- **`admin-shell.tsx`** разбит с 965 LOC monolith на 13 модулей в `admin-sidebar/` + `admin-topbar/`.
- **`user-detail-page.tsx`** дедуплицирован: 1211 → 67 LOC (thin wrapper над panel).

### Quality gates

- **`tsc --noEmit`** — 0 errors
- **`eslint . --quiet`** — 0 warnings (strict 0-tolerance policy)
- **`vitest`** — 9 файлов / 55 тестов passing (было 0 active)
- **`vite build`** — 1.4s, 132 chunks
- **0 `any`** в feature-коде вне vendored react-bits
- Net: **−10,040 строк** в 80 файлах

### Animations

- `tw-animate-css@1.4.0` plugin добавлен — все shadcn-анимации (Collapsible chevron, Tabs fade-in, Dialog, Sheet) теперь работают на Tailwind v4.
- Полировка анимаций по всему фронтенду: payments-analytics-tab "0.00" alignment, fraud, audit, settings.

### Bundle composition

| chunk | до | после | Δ |
|---|---|---|---|
| `ru.js` (i18n core) | 284 kB / 71 kB gz | **96 kB / 25.7 kB gz** | **-66%** |
| `en.js` (i18n core) | 179 kB / 54 kB gz | **60 kB / 19.8 kB gz** | **-66%** |
| `index.js` (app code) | 337 kB / ? | 220 kB / 62.8 kB gz | -35% |
| First-paint payload (RU, gz) | ~535 kB | **~444 kB** | **-17%** |

После открытия конкретного раздела к нему догружается соответствующий feature-bundle (1.9 – 22.3 kB) — экономия линейная и наибольшая для пользователей, которые работают с одним-двумя разделами.

---

## ✨ Что нового в v0.2.7

### Платежи
- **5 новых шлюзов** добавлены к каталогу: WATA, AuraPay, RollyPay, SeverPay, Lava.top — всего теперь **15 провайдеров**
- **Webhook signature verification** для всех новых интеграций (HMAC-SHA256, RSA, X-Api-Key — каждый по официальной доке провайдера)
- **Новая вкладка `Payments / Analytics`**:
  - Per-gateway: GMV, success rate, conversion, средний чек, p50/p95 time-to-pay
  - Топ причин отказа (парсится из `gateway_data->>'providerStatus'`)
  - Channel mix (web vs telegram), period-over-period delta
  - Daily trend chart на каждый шлюз
  - **Webhook health**: delivery rate, latency p50/p95, replay rate, top errors, reconciliation gap

### Безопасность и вход
- Редизайн вкладки «Безопасность»: 2FA и смена пароля рядом, Passkey с inline-rename и метаданными `synced`/`platform`, OAuth-провайдеры (GitHub, Yandex, Keycloak, PocketID, Generic OAuth2, Telegram) с фирменными SVG-иконками встроены прямо в страницу
- Полные настройки 6 OAuth-провайдеров: Client ID/Secret, Frontend/Backend Domain, Realm, PKCE, Allowed Emails / Telegram IDs
- Новый dialog для регистрации Passkey с именем, бейджи `synced` и `platform`

### Dashboard и UX
- Компактные KPI-карточки одинаковой высоты (4 колонки ≥lg, 2 на sm)
- Фирменные SVG-иконки для всех платёжных шлюзов и OAuth-провайдеров

### Ops
- `docker-entrypoint.sh` автоматически прогоняет `prisma migrate deploy` при старте API-контейнера. Worker миграции пропускает (правильный паттерн для distributed setup).
- `RUID_SKIP_MIGRATIONS=true` — escape hatch для восстановления и отладки.
- CI: убран legacy `0.1.3` тег, добавлен semver `{{major}}.{{minor}}` через `docker/metadata-action`

### Прочее
- ClickSpark canvas больше не накапливает DPR-скейл при ремоунтах (исправлены огромные «зависающие» искры на больших экранах)

---

## 📦 Готовые Docker-образы

GitHub Container Registry публикует образ при каждом push'е в `main` и при создании тега.

```bash
# Latest stable (main branch)
docker pull ghcr.io/dizzzable/rezeis:latest

# Pin to a specific release
docker pull ghcr.io/dizzzable/rezeis:0.2.11

# Pin to a minor line (gets 0.2.x updates automatically)
docker pull ghcr.io/dizzzable/rezeis:0.2
```

Доступные теги: `latest`, `0.2.11`, `0.2`, `v0.2.11`, плюс `sha-<short>` для каждого коммита в `main`.

---

## ✨ Возможности

### 📊 Dashboard
- KPI-карточки с trend-индикаторами и анимацией (компактный layout)
- График онлайн-пользователей за 24ч (real-time)
- Donut chart распределения подписок
- Мониторинг VPS: CPU, RAM, Disk, Load Average, Network
- Мониторинг процесса: RSS, Heap, Event Loop Lag
- Activity Feed — лента событий от Remnawave
- Quick Actions — навигация в 1 клик

### 👥 Пользователи
- Полный CRUD с поиском и фильтрацией
- Детальная карточка пользователя (подписки, платежи, устройства)
- Массовые операции (блокировка, удаление, экспорт)
- HWID устройства — просмотр и управление
- Cmd+K глобальный поиск по всем сущностям

### 💳 Платежи (15 шлюзов)

| Категория | Провайдеры |
|---|---|
| **Карты RU** | YooKassa, Antilopay, OverPay, Paypalych, RioPay, MulenPay, Platega |
| **Карты INT** | WATA, AuraPay, RollyPay, SeverPay, Lava.top |
| **Криптовалюты** | Cryptomus, Heleket |
| **Telegram** | Telegram Stars (XTR) |

Для каждого шлюза:
- Конфигурация через UI (Client ID/Secret, webhook secret, allowed emails и т.д.)
- Полная webhook-верификация (HMAC, RSA, IP allowlist — по требованиям провайдера)
- Per-gateway аналитика: GMV, conversion, time-to-pay percentiles, top failures
- Reconciliation между transactions и webhook events

Дополнительно:
- Мультивалютность: USD, RUB, USDT, XTR, TON, BTC, ETH
- Промокоды с 6 типами наград
- Реферальная система + партнёрская программа

### 🔐 Безопасность
- **Passkey / WebAuthn** через `@simplewebauthn/server` (биометрия + аппаратные ключи)
- **2FA TOTP** с recovery codes
- **6 OAuth-провайдеров**: GitHub, Yandex, Keycloak, PocketID, Telegram, Generic OAuth2 (с PKCE)
- JWT авторизация с token versioning
- RBAC — гранулярные роли и права
- IP Allowlist / Blocklist
- Login Guard (brute-force protection)
- Audit Log — полная история действий

### 🛰 Remnawave интеграция
- Управление нодами (enable/disable/restart/reset traffic)
- Управление хостами и конфиг-профилями
- Squads (internal/external)
- Гео-распределение пользователей по странам
- Метрики: онлайн тренды, bandwidth, system stats
- Webhook-приёмник с HMAC-SHA256 валидацией
- Автоматическая синхронизация профилей через BullMQ

### 🛡 Anti-Abuse
- 8 детекторов: failed payments, referral velocity, promo abuse, rapid churn, HWID anomalies, node traffic, geo concentration, offline nodes
- Автоматические действия по severity (notify / block / freeze)
- Persistent fraud signals с lifecycle (OPEN → ACKNOWLEDGED → RESOLVED)
- Cron-цикл каждые 5 минут

### 📢 Рассылки (Broadcast)
- Создание рассылок по аудиториям (ALL, ACTIVE, EXPIRED, TRIAL)
- Очередь отправки через BullMQ
- Статистика доставки

### ⚙️ Дополнительно
- Bot Flow Editor — визуальный конструктор Telegram-бота
- FAQ Manager с медиа-файлами
- Backup/Restore базы данных
- Config Portability (экспорт/импорт настроек)
- Система уведомлений (Telegram + email)
- WebSocket real-time обновления
- Swagger API документация

---

## 🏗 Архитектура

```
rezeis/
├── rezeis-admin/                    # Основной проект
│   ├── src/                         # NestJS backend (API + Worker)
│   │   ├── common/                  # Shared: config, prisma, guards, filters, cache
│   │   └── modules/                 # 40+ feature modules
│   │       ├── auth/                # JWT + 2FA + Login Guard
│   │       ├── two-factor/          # TOTP enrollment + recovery
│   │       ├── oauth/               # 6 OAuth providers + Passkey
│   │       ├── dashboard/           # KPI summary + System Health
│   │       ├── remnawave/           # Panel integration + Metrics + Webhooks
│   │       ├── anti-fraud/          # 8 detectors + signal lifecycle
│   │       ├── payments/            # 15 gateways + webhook processing
│   │       ├── payment-analytics/   # Per-gateway insights + webhook health
│   │       ├── business-analytics/  # KPI / cohorts / LTV / top payers
│   │       ├── subscriptions/       # Lifecycle + auto-renew
│   │       ├── profile-sync/        # BullMQ → Remnawave provisioning
│   │       ├── broadcast/           # Mass messaging
│   │       ├── bot-flow/            # Visual bot editor
│   │       ├── rbac/                # Roles & permissions
│   │       └── ...                  # ещё 30+ модулей
│   ├── prisma/                      # Schema + migrations (PostgreSQL)
│   ├── web/                         # React SPA
│   │   └── src/
│   │       ├── features/            # Page-per-folder (lazy-loaded)
│   │       ├── components/          # Shared UI (shadcn/ui + reactbits + effects)
│   │       ├── assets/payments/     # Brand SVG icons (15 providers)
│   │       ├── i18n/                # ru.ts + en.ts
│   │       └── lib/                 # API client, utils, stores
│   ├── docker-entrypoint.sh         # Автомиграции Prisma
│   ├── Dockerfile                   # Multi-stage unified image
│   └── docker-compose.yml           # Production stack
├── reiwa/                           # Telegram bot (separate service)
├── docs/                            # Documentation & assets
├── e2e/                             # End-to-end tests
└── .github/workflows/docker-publish.yml  # CI: build + push to GHCR
```

---

## 🛠 Технологический стек

### Backend
| Технология | Версия | Назначение |
|-----------|--------|-----------|
| NestJS | 11 | Application framework |
| Prisma | 7 | ORM + migrations |
| PostgreSQL | 17 | Primary database |
| Valkey (Redis) | 8 | Cache + BullMQ broker |
| BullMQ | 5 | Job queues (profile sync, broadcast) |
| Passport + JWT | — | Authentication |
| `@simplewebauthn/server` | 13 | Passkey / WebAuthn |
| Swagger | 11 | API documentation |
| Socket.IO | 4 | Real-time WebSocket |
| Helmet | 8 | Security headers |
| `@remnawave/backend-contract` | 2.7.3 | Typed Remnawave SDK |

### Frontend
| Технология | Версия | Назначение |
|-----------|--------|-----------|
| React | 19 | UI framework |
| TypeScript | 5.9 | Type safety |
| Vite | 8 | Build tool |
| TanStack Query | 5 | Server state management |
| Zustand | 5 | Client state |
| shadcn/ui (Radix) | — | Component library |
| Tailwind CSS | 4 | Styling |
| Recharts | 3 | Charts & graphs |
| react-i18next | — | Internationalization (ru/en) |
| react-hook-form + Zod | — | Forms & validation |
| Motion (Framer) | — | Animations |
| `@xyflow/react` | 12 | Bot Flow Editor |

### Infrastructure
| Технология | Назначение |
|-----------|-----------|
| Docker + Compose | Containerization |
| Traefik / Caddy | Reverse proxy |
| GitHub Actions | CI/CD |
| GHCR | Container registry |

---

## 🚀 Быстрый старт

### Требования
- Node.js 22+
- PostgreSQL 17
- Redis / Valkey 8
- Docker (для production)

### Локальная разработка

```bash
# Клонировать
git clone https://github.com/dizzzable/rezeis.git
cd rezeis/rezeis-admin

# Backend
npm install
cp .env.example .env          # заполнить переменные
npx prisma generate
npx prisma migrate deploy
npm run start:dev

# Frontend (в отдельном терминале)
cd web
npm install
npm run dev
```

### Docker (Production)

```bash
cd rezeis/rezeis-admin
docker compose up -d
```

Контейнер автоматически прогонит миграции при первом старте через `docker-entrypoint.sh`. Панель будет доступна на порту 8000. Фронтенд раздаётся через `ServeStaticModule` из того же контейнера.

**Чтобы пропустить автомиграции** (для восстановления из бэкапа или ручной отладки):
```bash
RUID_SKIP_MIGRATIONS=true docker compose up -d
```

---

## 📋 Переменные окружения

| Переменная | Обязательная | Описание |
|-----------|:---:|-----------|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `REDIS_URL` | ✅ | Redis/Valkey URL |
| `JWT_SECRET` | ✅ | Secret для JWT токенов |
| `REZEIS_CRYPT_KEY` | ✅ | AES-256 ключ для шифрования TOTP / OAuth secrets |
| `REMNAWAVE_HOST` | — | Хост панели Remnawave |
| `REMNAWAVE_PORT` | — | Порт панели Remnawave |
| `REMNAWAVE_TOKEN` | — | API токен Remnawave |
| `REMNAWAVE_WEBHOOK_SECRET` | — | HMAC ключ для webhook |
| `RUID_PROCESS_ROLE` | — | `api` (default), `worker`, `all` |
| `RUID_SKIP_MIGRATIONS` | — | `true` чтобы пропустить `migrate deploy` при старте |

Полный список — в `rezeis-admin/.env.example`.

---

## 🔌 API

Swagger UI доступен по адресу `/api/docs` после запуска.

Основные группы эндпоинтов:
- `/api/admin/auth/*` — авторизация (login + 2FA)
- `/api/admin/passkey/*` — WebAuthn регистрация и аутентификация
- `/api/admin/oauth/*` — OAuth providers + linked accounts
- `/api/admin/dashboard/*` — дашборд и мониторинг
- `/api/admin/remnawave/*` — Remnawave proxy
- `/api/admin/users/*` — пользователи
- `/api/admin/subscriptions/*` — подписки
- `/api/admin/payments/*` — платежи (gateways + transactions + webhooks)
- `/api/admin/analytics/payments/providers` — per-gateway аналитика
- `/api/admin/analytics/payments/webhooks` — webhook health + reconciliation
- `/api/admin/analytics/overview` — KPI / churn / cohorts
- `/api/admin/fraud/*` — anti-fraud signals
- `/api/webhook/remnawave` — webhook receiver
- `/api/payments/webhook/<GATEWAY_TYPE>` — payment webhook receivers

---

## 🧪 Quality Gates

```bash
# Backend
npx tsc --noEmit -p tsconfig.json    # TypeScript
npx eslint . --quiet                  # ESLint (0 warnings policy)
npm test                              # Unit tests

# Frontend
cd web
npm run build                         # tsc + vite build
npx eslint . --quiet                  # ESLint (0 warnings policy)
npx vitest run                        # Tests
```

---

## 🐳 Docker Build

Единый Dockerfile собирает:
- `dist/main.js` — API сервер
- `dist/worker.js` — Background worker (BullMQ processors, cron jobs)
- `web/dist/` — SPA (раздаётся через ServeStatic)

Роль процесса определяется через `RUID_PROCESS_ROLE`:
- `all` (default) — API + Worker в одном процессе
- `api` — только HTTP, без cron
- `worker` — только фоновые задачи (миграции пропускает)

Образы публикуются автоматически в GHCR через `.github/workflows/docker-publish.yml` при push в `main` и при тегах `v*`.

---

## 🌍 Интернационализация

Полная поддержка русского и английского языков. Все тексты проходят через `react-i18next` с ключами в `web/src/i18n/ru.ts` и `en.ts`.

---

## 📄 Лицензия

[MIT License](LICENSE) — свободное использование, модификация и распространение.

---

## 🤝 Contributing

1. Fork репозитория
2. Создайте ветку: `git checkout -b feature/your-feature`
3. Commit: `feat(scope): description`
4. Push и откройте Pull Request

Commit convention: `<type>(<scope>): <description>`
Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`, `ci`

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/dizzzable">dizzzable</a>
</p>
