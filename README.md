<p align="center">
  <img src="docs/logo.svg" width="80" alt="Rezeis Logo" />
</p>

<h1 align="center">Rezeis Admin Panel</h1>

<p align="center">
  <strong>Полнофункциональная админ-панель для управления VPN-сервисом на базе Remnawave</strong>
</p>

<p align="center">
  <a href="https://github.com/dizzzable/rezeis/releases/latest"><img src="https://img.shields.io/badge/version-0.2.7-blue" alt="Version" /></a>
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
docker pull ghcr.io/dizzzable/rezeis:0.2.7

# Pin to a minor line (gets 0.2.x updates automatically)
docker pull ghcr.io/dizzzable/rezeis:0.2
```

Доступные теги: `latest`, `0.2.7`, `0.2`, `v0.2.7`, плюс `sha-<short>` для каждого коммита в `main`.

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
