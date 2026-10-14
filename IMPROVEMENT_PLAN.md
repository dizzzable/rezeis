# План улучшения Rezeis до 5 звёзд

## Текущая оценка проекта

| Категория | Оценка | Комментарий |
|-----------|--------|-------------|
| Назначение | Админ-панель VPN | Пользователи, подписки, платежи (15 шлюзов), антифрод, реферальная система, Telegram-бот |
| Версия | 0.7.3 | Активная разработка, 34 миграции БД |
| Архитектура | ⭐⭐⭐⭐ | Монорепо, NestJS + React SPA, 40+ feature-модулей |
| Backend | NestJS 11 / Node 26 | Prisma 7, PostgreSQL, BullMQ, Socket.IO, JWT + WebAuthn |
| Frontend | React 19 / Vite 8 | TanStack Query 5, Zustand 5, shadcn/ui, Tailwind 4 |
| Масштаб | Крупный | 597 backend-файлов, 472 frontend-файлов, 60 моделей Prisma |
| Тесты backend | ⭐⭐⭐⭐⭐ | 145 spec-файлов, property-based тесты (fast-check) |
| Тесты frontend | ⭐⭐ | Всего 9 тест-файлов |
| TypeScript | ⭐⭐⭐ | Frontend strict, backend — relaxed (strictNullChecks: false) |
| Безопасность | ⭐⭐⭐⭐ | JWT + 2FA + Passkey + RBAC, но CORS/CSP с проблемами |
| CI/CD | ⭐⭐⭐ | Docker build + push, но тесты не запускаются |
| DevOps | ⭐⭐⭐⭐ | Docker multi-stage, healthchecks, backup system |

**Общая оценка: 4 из 5 звёзд**

---

## Фаза 1 — Безопасность (~2-3ч)

| # | Задача | Файл | Риск |
|---|--------|------|------|
| 1.1 | CORS — заблокировать `origin: true` → конкретный домен | `src/main.ts` | Низкий |
| 1.2 | Dockerfile — добавить non-root user | `Dockerfile` | Низкий |
| 1.3 | Создать `.dockerignore` | `.dockerignore` | Нулевой |
| 1.4 | `REZEIS_CRYPT_KEY` — валидация min 32 символа | `env.schema.ts` | Низкий |
| 1.5 | CSP — включить базовую политику вместо полного отключения | `src/main.ts` | Средний |

---

## Фаза 2 — Надёжность CI/CD (~2-3ч)

| # | Задача | Файл | Риск |
|---|--------|------|------|
| 2.1 | Запуск тестов в CI (143 файла есть, но не запускаются!) | `ci.yml` | Нулевой |
| 2.2 | Сканирование Docker-образа на CVE (Trivy) | `docker-publish.yml` | Нулевой |
| 2.3 | Docker log rotation на всех сервисах | `docker-compose.yml` | Нулевой |
| 2.4 | Worker healthcheck — реальная проверка вместо `process.exit(0)` | `docker-compose.yml` | Низкий |
| 2.5 | Убрать Remnawave из primary health endpoint | `health.controller.ts` | Низкий |

---

## Фаза 3 — TypeScript Strict (~4-8ч, самая трудоёмкая)

| # | Задача | Файл | Риск |
|---|--------|------|------|
| 3.1 | Backend: `noImplicitAny: true` + фиксы | `tsconfig.json` | ВЫСОКИЙ |
| 3.2 | Backend: `strictNullChecks: true` + фиксы | `tsconfig.json` | ВЫСОКИЙ |
| 3.3 | Frontend: `noUnusedLocals/Params: true` | `tsconfig.app.json` | Средний |
| 3.4 | ESLint: `no-explicit-any` → error, добавить `no-floating-promises` | `eslint.config.mjs` | Средний |
| 3.5 | Frontend: добавить `eslint-plugin-jsx-a11y` | `web/eslint.config.mjs` | Низкий |

---

## Фаза 4 — Качество кода (~3-4ч)

| # | Задача | Файл | Риск |
|---|--------|------|------|
| 4.1 | RbacGuard → глобальный APP_GUARD + `@SkipRbac()` | `src/modules/rbac/` | Средний |
| 4.2 | `@ApiProperty()` на все DTO (Swagger fix) | Все DTO | Низкий |
| 4.3 | Pre-commit hooks (husky + lint-staged) | `package.json` | Нулевой |
| 4.4 | Структурированное JSON-логирование (nest-winston) | `src/main.ts` | Низкий |
| 4.5 | Request correlation ID middleware | Новый middleware | Низкий |

---

## Фаза 5 — Frontend Quality (~3-4ч)

| # | Задача | Файл | Риск |
|---|--------|------|------|
| 5.1 | Перевести "Verifying session…" через i18n | `protected-route.tsx` | Нулевой |
| 5.2 | ErrorBoundary reset при смене роута | `error-boundary.tsx` | Низкий |
| 5.3 | RBAC route guards (проверка permissions) | `protected-route.tsx` | Средний |
| 5.4 | `<main>` landmark + skip-to-content | Layout component | Нулевой |
| 5.5 | Coverage config с порогами (60%) | `vite.config.ts` | Нулевой |
| 5.6 | Source maps `'hidden'` для prod | `vite.config.ts` | Нулевой |

---

## Фаза 6 — Документация и polish (~1-2ч)

| # | Задача | Файл | Риск |
|---|--------|------|------|
| 6.1 | Создать `CONTRIBUTING.md` + `SECURITY.md` | — | Нулевой |
| 6.2 | README версия 0.1.0 → 0.7.3 | `README.md` | Нулевой |
| 6.3 | Удалить `docs/documentation/nestjs-official/` (bloat) | — | Нулевой |
| 6.4 | `.gitignore` — добавить `vitest-results.json` | `.gitignore` | Нулевой |
| 6.5 | `fast-check` в explicit devDependencies | `package.json` | Нулевой |
| 6.6 | Исправить port conflict в demo compose | `docker-compose.demo.yml` | Нулевой |
| 6.7 | docker-compose: credentials через `${VAR}` вместо hardcode | `docker-compose.yml` | Нулевой |

---

## Сводка по усилиям

| Фаза | Усилие | Импакт на качество |
|-------|--------|-------------------|
| 1. Безопасность | 2-3ч | ⭐⭐⭐⭐⭐ |
| 2. CI/CD | 2-3ч | ⭐⭐⭐⭐ |
| 3. TypeScript strict | 4-8ч | ⭐⭐⭐⭐⭐ |
| 4. Качество кода | 3-4ч | ⭐⭐⭐⭐ |
| 5. Frontend | 3-4ч | ⭐⭐⭐ |
| 6. Документация | 1-2ч | ⭐⭐ |

**Общий объём: ~16-24 часа работы → проект на 5 звёзд**

---

## Что НЕ входит в план (out of scope)

- Полное покрытие frontend тестами (отдельный спринт)
- Prometheus/metrics endpoint (отдельная фича)
- E2E тесты в CI (требует Linux runner + DB)
- S3 backup storage (инфраструктурное решение)
- Миграция на monorepo tooling (nx/turborepo)
