<p align="center">
  <img src="docs/logo.svg" width="80" alt="Rezeis Logo" />
</p>

<h1 align="center">Rezeis Admin Panel</h1>

<p align="center">
  <strong>Полнофункциональная админ-панель для управления VPN-сервисом на базе Remnawave</strong>
</p>

<p align="center">
  <a href="https://github.com/dizzzable/rezeis/releases/latest"><img src="https://img.shields.io/badge/version-0.7.3-blue" alt="Version" /></a>
  <a href="https://github.com/dizzzable/rezeis/pkgs/container/rezeis"><img src="https://img.shields.io/badge/ghcr.io-rezeis-2496ED?logo=docker&logoColor=white" alt="GHCR" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License" /></a>
  <a href="#"><img src="https://img.shields.io/badge/NestJS-11-red" alt="NestJS" /></a>
  <a href="#"><img src="https://img.shields.io/badge/React-19-61dafb" alt="React" /></a>
  <a href="#"><img src="https://img.shields.io/badge/TypeScript-5.9-3178c6" alt="TypeScript" /></a>
  <a href="#"><img src="https://img.shields.io/badge/Prisma-7-2d3748" alt="Prisma" /></a>
  <a href="#"><img src="https://img.shields.io/badge/PostgreSQL-17-336791" alt="PostgreSQL" /></a>
</p>

<p align="center">
  <a href="https://github.com/dizzzable/rezeis/releases/latest">Релизы</a> •
  <a href="RELEASE_NOTES.md">История изменений</a> •
  <a href="#-quick-start">Быстрый старт</a> •
  <a href="#-возможности">Возможности</a>
</p>

---

## 🎯 О проекте

Rezeis — продвинутая админ-панель для управления VPN-инфраструктурой на базе [Remnawave Panel](https://github.com/remnawave/panel). Один интерфейс закрывает все операционные задачи: пользователи, подписки, платежи, ноды, мониторинг, антифрод, реферальная и партнёрская программы.

**Что выделяет Rezeis:**

- 🏗 **Монорепо** — backend, worker, и SPA в одном проекте, единый Docker-образ
- 🔗 **Native Remnawave SDK** — глубокая интеграция через `@remnawave/backend-contract`
- 📊 **Real-time everything** — WebSocket-инвалидация кеша, live-метрики, optimistic UI
- 🛡 **Anti-Abuse** с 8 детекторами и lifecycle сигналов
- 💰 **15 платёжных шлюзов** с per-gateway аналитикой
- 🤝 **Партнёрская программа** с многоуровневыми комиссиями (L1/L2/L3) и cohort-аналитикой
- 🔐 **Passkey / WebAuthn** + 2FA TOTP + 6 OAuth-провайдеров
- 🤖 Telegram-бот интеграция через сервис Reiwa
- 🚀 Docker-образ с автомиграциями Prisma при старте

---

## 📦 Готовые Docker-образы

GitHub Container Registry публикует образ при каждом push'е в `main` и при создании тега.

```bash
# Stable latest (main branch)
docker pull ghcr.io/dizzzable/rezeis:latest

# Pin to a specific release
docker pull ghcr.io/dizzzable/rezeis:0.7.3

# Pin to a minor line (gets 0.7.x updates automatically)
docker pull ghcr.io/dizzzable/rezeis:0.7
```

Доступные теги: `latest`, `0.7.3`, `0.7`, `v0.7.3`, плюс `sha-<short>` для каждого коммита в `main`.

---

## 🚀 Quick Start

### Production через Docker Compose

```bash
git clone https://github.com/dizzzable/rezeis.git
cd rezeis/rezeis-admin
cp .env.example .env
# заполнить секреты и сгенерировать уникальные DATABASE_PASSWORD, REDIS_PASSWORD,
# JWT_SECRET, REZEIS_CRYPT_KEY перед запуском production compose
docker compose up -d
```

Production compose строит подключение к PostgreSQL и Redis из отдельных `DATABASE_*` и `REDIS_*` переменных. Не используйте старый примерный `DATABASE_URL` с фиксированным паролем для нового запуска; для уже существующей базы перенесите текущие DB/Redis passwords в `.env` перед `docker compose up -d`. Контейнер автоматически прогонит миграции через `docker-entrypoint.sh`. Панель будет доступна на порту 8000.

В documented split compose режиме API контейнер запускается с `RUID_PROCESS_ROLE=api`, а `rezeis-worker` с `RUID_PROCESS_ROLE=worker`, чтобы scheduled/worker side effects не выполнялись дважды.

Чтобы пропустить миграции (для восстановления из бэкапа):

```bash
RUID_SKIP_MIGRATIONS=true docker compose up -d
```

### Локальная разработка

```bash
# Backend
cd rezeis-admin
npm install
npx prisma generate
npx prisma migrate deploy
npm run start:dev

# Frontend (в отдельном терминале)
cd web
npm install
npm run dev
```

**Системные требования:** Node.js 22+, PostgreSQL 17, Redis/Valkey 8.

---

## ✨ Возможности

### 📊 Dashboard

- KPI-карточки с trend-индикаторами и анимированными счётчиками
- График онлайн-пользователей за 24ч (real-time)
- Donut chart распределения подписок
- Мониторинг VPS: CPU, RAM, Disk, Load Average, Network
- Мониторинг процесса: RSS, Heap, Event Loop Lag
- Activity Feed — лента событий от Remnawave
- Quick Actions — навигация в 1 клик
- Cmd+K глобальный поиск по всем сущностям

### 👥 Пользователи

- Полный CRUD с поиском, фильтрами, пагинацией
- Детальная карточка пользователя (подписки, платежи, устройства, рефералы, партнёрский статус)
- Массовые операции (блокировка, удаление, экспорт)
- HWID-устройства — просмотр и управление
- Audit log на каждое мутирующее действие

### 🤝 Партнёрская программа

Полноценная многоуровневая партнёрская программа с переключателем «обычный реферал ↔ партнёр» по флагу `isActive`.

**Лидерборд и таблица партнёров:**
- Поиск по имени / username / Telegram ID
- Сортировки: balance / earned / withdrawn / created / updated
- Бейджи Global / Individual в зависимости от настроек начислений
- Quick-action menu: открыть в Users, скопировать любой ID

**Детальный drawer с 6 табами:**
1. **Overview** — балансы, 7d/30d earnings, рефералы по уровням, источник настроек
2. **Earnings** — леджер `PartnerTransaction` с CSV-экспортом
3. **Referrals** — граф `PartnerReferral` (L1/L2/L3) с пагинацией
4. **Withdrawals** — заявки этого партнёра
5. **Settings** — корректировка баланса, индивидуальные ставки %, фиксированные суммы, accrual strategy, reward type
6. **Audit** — отфильтрованные строки админ-аудита по `partnerId`

**Аналитика партнёрки:**
- Воронка партнёров: новые → активные → с начислениями → с выплатами
- Time-series earnings/withdrawals/new partners (AreaChart)
- Распределение по уровням L1/L2/L3 (BarChart)
- Распределение по платёжным шлюзам (PieChart)
- Топ-10 партнёров за период
- Cohort retention heatmap (8 недель после регистрации)
- Withdrawal throughput с медианой и p95 времени принятия решения
- KPIs: AOV (средний платёж), EPAP (доход на партнёра), activation rate, repeat-purchase share

**Выплаты:**
- 4 stat-карточки (pending/completed/rejected/total paid)
- Поиск, фильтр по статусу, чекбоксы для bulk approve
- Reject с диалогом причины
- Optimistic UI — статус меняется мгновенно с rollback при ошибке

**CSV-экспорт** через streaming `StreamableFile`:
- Каталог партнёров
- Leaderboard (top partners за период)
- Withdrawals (с фильтром по периоду)
- Earnings конкретного партнёра

### 🔗 Реферальная программа

- Ребро `Referral` с уровнем и `inviteSource`
- Инвайты с TTL и слот-капасити (per-user override)
- Reward types: POINTS / EXTRA_DAYS
- Manual attach с replay исторических платежей
- Points exchange: дни подписки / подарок-промокод / скидка / трафик
- Полный таб «Аналитика»: funnel, timeseries, top referrers, reward distribution, source breakdown

### 💳 Платежи (15 шлюзов)

| Категория | Провайдеры |
|---|---|
| **Карты RU** | YooKassa, Antilopay, OverPay, Paypalych, RioPay, MulenPay, Platega |
| **Карты INT** | WATA, AuraPay, RollyPay, SeverPay, Lava.top |
| **Криптовалюты** | Cryptomus, Heleket |
| **Telegram** | Telegram Stars (XTR) |

Для каждого шлюза:
- Конфигурация через UI (Client ID/Secret, webhook secret, allowed emails и т.д.)
- Полная webhook-верификация (HMAC, RSA, IP allowlist по требованиям провайдера)
- Per-gateway аналитика: GMV, conversion, time-to-pay percentiles, top failures
- Reconciliation между transactions и webhook events

Дополнительно:
- Мультивалютность: USD, RUB, USDT, XTR, TON, BTC, ETH
- Промокоды с 6 типами наград
- Hooks на `transaction.completed` запускают partner accrual + referral qualification

### 🔐 Безопасность

- **Passkey / WebAuthn** через `@simplewebauthn/server` (биометрия + аппаратные ключи)
- **2FA TOTP** с recovery codes и зашифрованными секретами (AES-256-GCM)
- **6 OAuth-провайдеров**: GitHub, Yandex, Keycloak, PocketID, Telegram, Generic OAuth2 (с PKCE)
- JWT-авторизация с token versioning
- RBAC — гранулярные роли и права
- IP Allowlist / Blocklist
- Login Guard (brute-force protection с экспоненциальным backoff)
- Audit Log — полная история действий
- CSV exports защищены от Excel-formula injection

### 🛰 Remnawave интеграция

- Управление нодами: enable/disable/restart/reset traffic
- Управление хостами и конфиг-профилями
- Squads (internal/external)
- Гео-распределение пользователей по странам
- Метрики: онлайн-тренды, bandwidth, system stats
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
- Шаблонные плейсхолдеры (`{{name}}`, `{{plan}}`, ...)
- Статистика доставки и retry на ошибки

### 🔔 Уведомления

- Notification templates с per-event настройкой через UI
- Email-bridge: автоматическая отправка по `SystemEvent.type` (если шаблон активен)
- Telegram delivery через бот Reiwa
- 25+ предзаготовленных шаблонов: subscription expiry, partner accruals, withdrawal status, referral rewards и т.д.

### ⚙️ Дополнительно

- **Bot Flow Editor** — визуальный конструктор Telegram-бота на `@xyflow/react`
- **FAQ Manager** с медиа-файлами
- **Backup/Restore** базы данных
- **Config Portability** — экспорт/импорт настроек
- **Theme Studio** — Liquid Glass, custom CSS, тёмная/светлая темы, presets
- **WebSocket real-time** обновления (Socket.IO)
- **Swagger API** документация на `/api/docs`
- Полная **i18n** (ru/en) с lazy-loading feature-bundles

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
│   │       ├── partners/            # 3-level affiliate program + analytics
│   │       ├── referrals/           # Referral graph + qualification + rewards
│   │       ├── business-analytics/  # KPI / cohorts / LTV / top payers
│   │       ├── subscriptions/       # Lifecycle + auto-renew
│   │       ├── profile-sync/        # BullMQ → Remnawave provisioning
│   │       ├── broadcast/           # Mass messaging
│   │       ├── notifications/       # Templates + delivery bridges
│   │       ├── bot-flow/            # Visual bot editor
│   │       ├── rbac/                # Roles & permissions
│   │       └── ...                  # ещё 30+ модулей
│   ├── prisma/                      # Schema + migrations (PostgreSQL)
│   ├── web/                         # React SPA
│   │   └── src/
│   │       ├── features/            # Page-per-folder (lazy-loaded)
│   │       ├── components/          # Shared UI (shadcn/ui + reactbits)
│   │       ├── assets/payments/     # Brand SVG icons (15 providers)
│   │       ├── i18n/                # ru.ts + en.ts + lazy feature bundles
│   │       └── lib/                 # API client, realtime, utils, stores
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
| BullMQ | 5 | Job queues (profile sync, broadcast, email) |
| Passport + JWT | — | Authentication |
| `@simplewebauthn/server` | 13 | Passkey / WebAuthn |
| Swagger | 11 | API documentation |
| Socket.IO | 4 | Real-time WebSocket |
| Helmet | 8 | Security headers |
| `@remnawave/backend-contract` | 2.7.3 | Typed Remnawave SDK |
| fast-check | 3 | Property-based testing |

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

## 📋 Переменные окружения

| Переменная | Обязательная | Описание |
|-----------|:---:|-----------|
| `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD` | ✅ | PostgreSQL connection settings; production compose requires a generated `DATABASE_PASSWORD` |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_NAME`, `REDIS_PASSWORD` | ✅ | Redis connection settings; production compose requires a generated `REDIS_PASSWORD` |
| `JWT_SECRET` | ✅ | Secret для JWT токенов |
| `REZEIS_CRYPT_KEY` | ✅ | AES-256 ключ для шифрования TOTP / OAuth secrets |
| `REMNAWAVE_HOST` | — | Хост панели Remnawave |
| `REMNAWAVE_PORT` | — | Порт панели Remnawave |
| `REMNAWAVE_TOKEN` | — | API токен Remnawave |
| `REMNAWAVE_WEBHOOK_SECRET` | — | HMAC ключ для webhook |
| `RUID_PROCESS_ROLE` | — | `api` (default), `worker`, `all` |
| `RUID_SKIP_MIGRATIONS` | — | `true` чтобы пропустить `migrate deploy` при старте |

Полный список — в `rezeis-admin/.env.example`. `DATABASE_URL` и `REDIS_URL` остаются только для legacy/manual запусков, где конкретный компонент явно ожидает URL.

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
- `/api/admin/partners/*` — партнёрская программа + analytics + CSV exports
- `/api/admin/referrals/*` — реферальная программа + analytics
- `/api/admin/analytics/payments/*` — per-gateway аналитика
- `/api/admin/analytics/overview` — KPI / churn / cohorts
- `/api/admin/fraud/*` — anti-fraud signals
- `/api/webhook/remnawave` — webhook receiver
- `/api/payments/webhook/<GATEWAY_TYPE>` — payment webhook receivers

---

## 🧪 Quality Gates

```bash
# Backend
npx tsc --noEmit -p tsconfig.json    # TypeScript (0 errors policy)
npx eslint . --quiet                  # ESLint (0 warnings policy)
node --test test/**/*.spec.ts         # Unit tests + property-based

# Frontend
cd web
npm run build                         # tsc + vite build
npx eslint . --quiet                  # ESLint (0 warnings policy)
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

Полная поддержка русского и английского языков. Все тексты проходят через `react-i18next` с ключами в `web/src/i18n/ru.ts` и `en.ts`. Тяжёлые feature-bundles (Dashboard, Payments, Remnawave, ...) разделены по языку и грузятся лениво — только активная локаль попадает в браузер.

---

## 📜 История изменений

Полные release notes по всем версиям — в [`RELEASE_NOTES.md`](RELEASE_NOTES.md). Каждый релиз также продублирован на странице [GitHub Releases](https://github.com/dizzzable/rezeis/releases) с детальным changelog.

---

## 📄 Лицензия

[MIT License](LICENSE) — свободное использование, модификация и распространение.

---

## 🤝 Contributing

1. Fork репозитория
2. Создайте feature-ветку: `git checkout -b feature/your-feature`
3. Commit по [Conventional Commits](https://www.conventionalcommits.org/): `feat(scope): description`
4. Push и откройте Pull Request с описанием изменений

Перед PR: `tsc --noEmit`, `eslint . --quiet`, `npm test` и `npm run build` для frontend должны проходить без ошибок.
