# Rezeis Admin v0.2.14

## Major release — referrals overhaul: analytics tab, audit-trail, bulk operations, contract sync

После v0.2.13 страница рефералов всё ещё была наполовину рабочей: половина фронтовых эндпоинтов не имела пары на бэке (KPI пустые, табы Награды и часть Приглашений сыпались), CSP блокировал vendored chunks, и почти не было средств для аналитики реферальной программы. Этот релиз закрывает разом несколько направлений.

### Новый таб «Аналитика»

Полноценная dashboard-страница с переключателем 7d/30d/90d:

1. **Воронка конверсии** — invites_created → consumed → qualified → rewards_issued, с процентом конверсии на каждом шаге.
2. **Динамика по дням** — AreaChart с 4 рядами (приглашения / рефералы / квалификации / награды). Гранулярность автоматически day или week.
3. **Топ-10 рефереров** — лидерборд за период, с conversion rate и заработанными points.
4. **Распределение наград** — Pie chart по типу × issued/pending/revoked.
5. **Источники приглашений** — bar chart по `inviteSource`.

Backend: 5 новых эндпоинтов под `/admin/referrals/analytics/*`, time-series через `date_trunc` + `generate_series` на стороне Postgres (без подгрузки сырых строк).

### Audit-trail для наград

Миграция `20260524201400_referral_rewards_audit`:

```sql
ALTER TABLE referral_rewards
  ADD COLUMN issued_by TEXT,        -- кто выдал
  ADD COLUMN granted_by TEXT,       -- кто создал вручную
  ADD COLUMN revoked_at TIMESTAMPTZ(3),
  ADD COLUMN revoke_reason TEXT;
```

Все новые операторские действия записывают актора. Легаси-строки получают `null`. Два индекса (`issued_by`, `granted_by`) для отчётов.

### Bulk operations

В табе «Награды» — чекбоксы и кнопка «Выдать (N)». `POST /admin/referrals/rewards/bulk-issue` обрабатывает до 500 ID, возвращает `{issued, skipped, failed, errors}`.

### Иконки и UX

- `Crown`/`Star` для уровней L1/L2/L3 (gold/silver/bronze).
- `MessageCircle`/`Globe`/`UserPlus`/`Link` для источников.
- `Coins`/`CalendarPlus` для типов наград.
- Поиск + фильтры по каждой таблице (level, status, type, дата).
- Copy-to-clipboard на токенах invite.
- KPI-карточки получили иконки в углу.

### Контракт синхронизирован

Эндпоинты, которых раньше не было, теперь есть. Frontend работает целиком:

- `GET /admin/referrals/stats` — отдаёт SPA-shape `{invites, referrals, qualifiedReferrals, rewards, issuedRewards}` (плюс старые поля).
- `GET /admin/referrals/rewards` — список с фильтрами (`type`, `issued`, `userId`, `referralId`, `limit`, `offset`).
- `POST /admin/referrals/rewards` — manual grant.
- `POST /admin/referrals/rewards/:id/issue` — apply effect (POINTS → User.points, EXTRA_DAYS → продлить подписку).
- `POST /admin/referrals/rewards/bulk-issue` — пакетный issue.
- `POST /admin/referrals/rewards/:id/revoke` — отзыв pending.
- `POST /admin/referrals/attach` — telegram-id-friendly (резолв → cuid).
- `POST /admin/referrals/invites/:id/revoke` — alias к `DELETE`.
- `GET/PATCH /admin/settings/referral` — settings формы (раньше PATCH 404'ил).

### CSP fix

`helmet()` без параметров блокировал `unsafe-eval` и спамил console сообщением `Content Security Policy of your site blocks the use of 'eval'`. Эту блокировку триггерили vendored chunks (`@tanstack/react-query`, `zod`). Снято: CSP отключён, остальные защиты helmet (HSTS, X-Frame-Options, X-Content-Type-Options) сохранены.

### Real-time

`useRealtimeUpdates` уже маппит `referral.qualified` и `referral.reward_issued` на `['admin', 'referrals']`. Все queries на странице используют этот префикс — обновления приходят без явной подписки.

### Tests

- 9/9 frontend test files passed (55 tests).
- Backend tsc + eslint — 0 errors / 0 warnings.

### Migrating from 0.2.13

Без breaking changes для пользователей. Бэкенд применит миграцию `20260524201400_referral_rewards_audit` на старте (4 nullable колонки + 3 индекса, безопасно).

```bash
docker compose pull && docker compose up -d
```

---

# Rezeis Admin v0.2.13

## Hotfix release — backend endpoint gaps (referrals 500 + subscriptions 404)

После v0.2.12 React #301 ушёл и в console остались видны секундарные network errors. Этот релиз закрывает три:

- `GET /api/admin/referrals` 500 → корректно отдаёт список
- `GET /api/admin/subscriptions?limit=50` 404 → новый list-endpoint
- `GET /api/admin/subscriptions/stats` 404 → новый stats-endpoint

### Что чинили

#### 1. Referrals 500 — Prisma select несуществующего поля

`ReferralsService.listReferrals` бросал:

```
PrismaClientValidationError:
  Unknown field `login` for select statement on model `User`.
  Available options: ... username, name, telegramId ...
```

В `REFERRAL_USER_SUMMARY_SELECT` стояло `login: true`, но у модели `User` в Prisma-схеме нет поля `login` — есть `username`. Откуда взялось `login` — историческое наследие от ранних итераций admin web-account. Поле заменено на `username`, интерфейс `ReferralUserSummaryInterface` синхронизирован, маппер пробрасывает реальное значение вместо `null`.

#### 2 + 3. Subscriptions endpoint gaps

`AdminSubscriptionsController` обслуживал только `POST /action-policy` и `POST /quote` — read-эндпоинтов для админ-страницы подписок не было вообще. Frontend (`subscriptions-page.tsx`) ожидал:

```
GET /admin/subscriptions?limit=50&status=ACTIVE&isTrial=true
  → { items: SubscriptionRow[], total: number }
GET /admin/subscriptions/stats
  → { total, byStatus, trialCount, expiringIn7d }
```

Добавлен новый сервис `AdminSubscriptionsListService` (отделён от `SubscriptionQuoteService`, чтобы read-операции не цепляли тяжёлый граф зависимостей quote-сервиса). Контроллер расширен двумя GET-методами.

Фильтры:
- `status` — enum `SubscriptionStatus`
- `isTrial` — boolean string
- `limit` 1..500, `offset` 0..100k

Stats:
- `total` — всего подписок
- `byStatus` — `groupBy` по статусам, словарь string→count
- `trialCount` — `isTrial: true`
- `expiringIn7d` — ACTIVE-подписки с `expiresAt` в окне next 7 days
- `generatedAt` — ISO-time снимка

Один `Promise.all` для всех четырёх запросов.

Список отдаёт `expireAt` и `expiresAt` одновременно — frontend в SPA пока ждёт `expireAt`, остальное код-base может пользоваться канонически верным `expiresAt`.

### Tests

- `test/admin-subscriptions.controller.spec.ts` — обновлён под новый конструктор и новые routes (`GET /`, `GET /stats`).
- `test/referrals.controllers.spec.ts` — переписан полностью. Тест ссылался на удалённые ранее методы (`getSummary`, `listRewards`, `qualifyReferral`, `exchangeGiftPromocode`) — это был pre-existing breakage до 0.2.13. Новый spec соответствует реальным контроллерам.

### Verification

- `npx tsc --noEmit` (backend) — clean
- `npx tsc --noEmit` (frontend) — clean
- `npx eslint . --quiet` (оба) — 0 errors / 0 warnings
- Targeted suites `admin-subscriptions.controller.spec.ts` + `referrals.controllers.spec.ts` — 5/5 passed
- Suite целиком — pre-existing breakage в web-auth и worker-module spec'ах (не моя зона), от моих правок baseline не вырос.

### Файлы

- `rezeis-admin/src/modules/referrals/services/referrals.service.ts` — `login` → `username`.
- `rezeis-admin/src/modules/referrals/interfaces/referral.interface.ts` — поле интерфейса синхронизировано.
- `rezeis-admin/src/modules/subscriptions/controllers/admin-subscriptions.controller.ts` — `GET /` и `GET /stats`.
- `rezeis-admin/src/modules/subscriptions/services/admin-subscriptions-list.service.ts` — новый сервис.
- `rezeis-admin/src/modules/subscriptions/dto/list-subscriptions-query.dto.ts` — DTO для query.
- `rezeis-admin/src/modules/subscriptions/interfaces/admin-subscriptions-list.interface.ts` — interface'ы для list/stats.
- `rezeis-admin/src/modules/subscriptions/subscriptions.module.ts` — регистрация `AdminSubscriptionsListService`.
- `rezeis-admin/Dockerfile` — `ARG APP_VERSION=0.2.13`.
- `rezeis-admin/test/admin-subscriptions.controller.spec.ts` — расширен.
- `rezeis-admin/test/referrals.controllers.spec.ts` — переписан под актуальное API.

### Migrating from 0.2.12

Без breaking changes. Стандартный pull-up:

```bash
docker compose pull && docker compose up -d
```

---

# Rezeis Admin v0.2.12

## Hotfix release — QuickSearchOverlay infinite render-loop (root cause of React #301)

Хирургический фикс корневой причины `Minified React error #301` на всех страницах админки. Все предыдущие хотфиксы 0.2.9–0.2.11 устраняли реальные, но побочные проблемы (healthcheck, throttle, cache, ws path) — настоящий виновник был в одном глобальном компоненте.

### Симптомы

При заходе на любую страницу под `demoadmin` или другим аккаунтом:

```
Error: Minified React error #301; visit https://react.dev/errors/301 for the full message
or use the non-minified dev environment for full errors and additional helpful warnings.
[ErrorBoundary] Caught error: ...
```

Sourcemap указывал на `app/providers.tsx:22` — это `<ErrorBoundary>`, ловящий ошибку из дочернего поддерева. Дочерним было одно: `<QuickSearchOverlay>`, отрендеренный глобально в `<AdminShell>`. Стек сопровождался шумом от Recharts (`width(-1) and height(-1) of chart should be greater than 0`), 404/500 от data-эндпоинтов — это уже последствия порушенного дерева, а не причина.

### Корневая причина

В `quick-search-overlay.tsx` стоял такой паттерн:

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

`{ data: results = [] }` — destructure-default. На каждом рендере, пока `useQuery` возвращает `undefined` (overlay закрыт, `enabled: query.length >= 2` ещё `false`, или query in-flight), JS создаёт **новый** `[]` literal. У этого нового массива другая ссылка, поэтому `results !== prevResults` всегда `true` → `setPrevResults` + `setSelectedIndex` в render-фазе → React планирует ре-рендер → создаётся новый `[]` → identity check снова `true` → бесконечный цикл.

React 18 ловит это после ~25 итераций, кидает Error #301 и сваливает его в ближайший `<ErrorBoundary>`. Поскольку `<QuickSearchOverlay>` живёт в `<AdminShell>`, ошибка ловится на каждом маршруте админки.

### Фикс

Стабилизирован identity «пустого» массива:

```ts
// Module-level constant — идентичность стабильна между рендерами.
const EMPTY_RESULTS: SearchResult[] = [];

export function QuickSearchOverlay({ open, onClose }: Props) {
  const { data, isFetching } = useQuery({ ... });
  const results: SearchResult[] = data ?? EMPTY_RESULTS;
  // ...
}
```

Теперь `results` ссылается либо на массив из cache TanStack Query (стабильный пока ключ не сменился), либо на shared `EMPTY_RESULTS`. Identity check `results !== prevResults` теперь срабатывает только при реальной смене данных.

Это рекомендованный React паттерн ["Adjusting some state when a prop changes"](https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes): сравниваемое значение должно иметь стабильную идентичность, иначе условие в render-фазе крутится бесконечно.

### Файлы

- `rezeis-admin/web/src/components/quick-search/quick-search-overlay.tsx` — `EMPTY_RESULTS` константа модуля + изменённый destructure.
- `rezeis-admin/Dockerfile` — `ARG APP_VERSION=0.2.12`.

### Migrating from 0.2.11

Без breaking changes. Стандартный pull-up:

```bash
docker compose pull && docker compose up -d
```

`Cache-Control` headers, добавленные в v0.2.11, гарантируют, что пользователи получат свежий `index.html` и новый bundle при следующем визите — hard reload не нужен.

---

# Rezeis Admin v0.2.11

## Hotfix release — stale browser cache root-cause + WebSocket path

Поверх v0.2.10 — хирургический фикс реальной причины React Error #301 у пользователей и побочный фикс WS handshake.

### Что исправлено

#### 1. Cache-Control headers для статики

`@nestjs/serve-static` не выставлял Cache-Control headers по умолчанию. Браузер кешировал `index.html` часами и при заходе после релиза получал старый shell, который ссылался на старые asset-хеши. Часть assets отдавала 404, React пытался re-render с broken state → infinite loop → React Error #301.

Теперь:
- `index.html` (и любой `*.html`): `no-cache, no-store, must-revalidate` — браузер всегда тянет свежий shell с новыми asset-хешами
- `/assets/*.{js,css,...}`: `public, max-age=31536000, immutable` — Vite hash'ит имена файлов, потому assets можно кешировать на год

Это стандартный pattern для Vite/Rolldown сборок: hashed assets навечно, shell без кеша. Рекомендован [Vite docs](https://vite.dev/guide/static-deploy) и [react.dev](https://react.dev/learn/render-and-commit).

#### 2. WebSocket path: `/api/socket.io`

Frontend всегда подключался к `ws://host/api/socket.io/...`, но `@WebSocketGateway({ namespace: '/realtime' })` в backend не указывал кастомный `path`. Socket.IO по умолчанию слушает `/socket.io/...`, и `setGlobalPrefix('api')` к WebSocket не применяется (это HTTP-only setting).

В результате `realtime` namespace был доступен только на `/socket.io/realtime`, а frontend стучался в `/api/socket.io/realtime` → handshake failure → WebSocket connection error в console каждые 1-15 секунд (reconnection storm).

Path align'ен в gateway-декораторе:
```ts
@WebSocketGateway({
  namespace: '/realtime',
  path: '/api/socket.io', // ← было дефолтное /socket.io
  cors: { origin: true, credentials: true },
})
```

### Файлы

- `rezeis-admin/src/app.module.ts` — `serveStaticOptions.setHeaders` callback с правильными Cache-Control
- `rezeis-admin/src/modules/realtime/realtime.gateway.ts` — `path: '/api/socket.io'` в декораторе

### Migrating from 0.2.10

Без breaking changes. Стандартный `docker compose pull && docker compose up -d`. После деплоя пользователи получат свежий index.html при следующем визите (без необходимости hard reload).

---

# Rezeis Admin v0.2.10

## Hotfix release — throttle limit and ErrorBoundary contract

Маленький релиз поверх 0.2.9 — фикс rate-limit'а на polled-эндпоинтах админки + правильный schema для backend error-reporting.

### Что исправлено

#### 1. Throttler default limit 60 → 600 req/min

Старый лимит был слишком жёсткий для админ-SPA, которая опрашивает несколько endpoint'ов одновременно:

| endpoint | интервал | req/min |
|---|---|---|
| `/admin/dashboard/system-health` | 10 s | 6 |
| `/admin/dashboard/summary` | 30 s | 2 |
| `/admin/remnawave/online-trend` | 60 s | 1 |
| `/admin/remnawave/activity-feed` | 30 s | 2 |
| `/admin/system-logs` | 2 s | 30 |
| `/admin/support-tickets/:id` | 5 s | 12 |
| `/admin/webhooks/deliveries` | 10 s | 6 |
| `/admin/broadcast` | 10 s | 6 |

Только дашборд + system-logs за минуту — 41 запрос. Если оператор открывает несколько окон или быстро переключается между разделами — упирался в 60 req/min, ловил 429 Too Many Requests, рендерил backend-error в UI, что провоцировало бесконечные циклы повторных запросов и React Error #381.

Все админ-endpoint'ы за `AdminJwtAuthGuard` — abuse vector это login, и для него уже есть `strict` throttle 5/min.

#### 2. `@SkipThrottle()` на read-only метрики

- `/admin/dashboard/*` — summary и system-health (read-only метрики).
- `/admin/client-errors` — отчёты ErrorBoundary должны проходить даже когда API под нагрузкой; throttling crash-репортов только усиливает crash loops.

#### 3. ClientErrorReportDto — `react.errorBoundary` source

`ErrorBoundary` посылает крашрепорты с `source: 'react.errorBoundary'` и `componentStack` полем (добавлено в [v0.2.8](https://github.com/dizzzable/rezeis/releases/tag/v0.2.8)). Backend DTO разрешал только `'window.error' | 'unhandledrejection'` и не имел `componentStack` — каждый репорт отвергался с 400 Bad Request, крашрепорты терялись.

DTO исправлен:
```ts
@IsIn(['window.error', 'unhandledrejection', 'react.errorBoundary'])
source!: 'window.error' | 'unhandledrejection' | 'react.errorBoundary';

@IsOptional() @IsString() @MaxLength(8_000)
componentStack?: string;
```

#### 4. Vite chunk size warning

`chunkSizeWarningLimit` повышен с 800 → 1100 kB. `vendor-three.js` (999 kB) грузится только когда оператор включает 3D-фон в `Appearance`, потому warning был информационным шумом.

### Файлы

- `rezeis-admin/src/common/throttle/throttle.module.ts` — лимит 60 → 600
- `rezeis-admin/src/modules/dashboard/controllers/admin-dashboard.controller.ts` — `@SkipThrottle()` на класс
- `rezeis-admin/src/modules/client-errors/client-errors.controller.ts` — добавлен `react.errorBoundary` + `componentStack`, `@SkipThrottle()` на класс
- `rezeis-admin/web/vite.config.ts` — `chunkSizeWarningLimit: 1100`
- `rezeis-admin/Dockerfile` — `ARG APP_VERSION=0.2.10`

### Migrating from 0.2.9

Без breaking changes. Стандартный `docker compose pull && docker compose up -d` достаточен.

---

# Rezeis Admin v0.2.9

## Hotfix release

Маленький релиз поверх 0.2.8 — два фикса в Docker-стеке для корректной работы healthcheck и точной версии в `/api/health`.

### Фиксы

- **`docker-compose.yml` healthcheck**: `wget -qO- http://localhost:8000/api/health` → `wget -qO- http://127.0.0.1:8000/api/health`. На Alpine-based образе `localhost` не всегда резолвится — Nest слушает `0.0.0.0`, а wget не мог подключиться по hostname. Контейнер показывался `unhealthy` несмотря на работающий API. Теперь healthcheck проходит, Docker Desktop / docker ps корректно показывают `healthy`.
- **Версия в `/api/health` endpoint**: образ теперь устанавливает `npm_package_version` через Dockerfile `ARG APP_VERSION` + `ENV`. До этого `/api/health` всегда возвращал хардкод `0.1.3` (npm runtime отсутствует в production-образе, потому `process.env.npm_package_version` был undefined). Теперь endpoint возвращает реальную версию релиза.

### Файлы

- `rezeis-admin/Dockerfile` — добавлен `ARG APP_VERSION=0.2.9` + `ENV npm_package_version=${APP_VERSION}`
- `rezeis-admin/docker-compose.yml` — `localhost` → `127.0.0.1` в healthcheck
- `rezeis-admin/src/modules/health/health.service.ts` — fallback `'0.1.3'` → `'unknown'`

### Migrating from 0.2.8

Без breaking changes. Стандартный `docker compose pull && docker compose up -d` достаточен. Никаких миграций.

---

# Rezeis Admin v0.2.8

## Performance pass — first-paint stripped to the bone

Этот релиз — глубокая ревизия фронтенда: 80 файлов, +3 606 / −13 646 строк, **net −10 040 LOC**. Никаких нарушений UX, никаких regressions — только меньше байт, чище код, выше типобезопасность.

---

## 🚀 Performance — i18n & lazy loading

### i18n splitting (D2)

Локализация админки была монолитом — 284 kB ru.ts + 179 kB en.ts грузились на первый paint, даже если оператор шёл прямо на dashboard. Теперь:

- **Core i18n уменьшено на 66%**:
  - `ru.js`: 284 kB → **96 kB** (−188 kB сырого, −46 kB gzipped)
  - `en.js`: 179 kB → **60 kB** (−119 kB сырого, −34 kB gzipped)
- **12 lazy feature-bundles** для тяжёлых страниц:
  - `appearance` (appearancePage, glassSettings, effectsSettings)
  - `userDetail` (panel + page)
  - `platformSettings` (settings, accessModePage)
  - `dashboard`, `notifications`, `payments`, `remnawave`, `twoFactor`
  - `imports`, `analytics`, `broadcast`, `automations`
- **Per-language split** — каждый feature-bundle отдельный chunk на каждый язык; только активная локаль доходит до браузера.
- **`withFeatureBundle()` helper** оборачивает `lazy()` так, чтобы i18n чанк фичи резолвился параллельно с её page-чанком — нет flicker на первый рендер.
- **Language switch автоматически re-hydrate** все ранее загруженные feature-бандлы.

**Удалено 12 dead namespaces (~80 kB raw)**: `users` (66.8 kB), `paymentTransactionsPage` (38.6 kB), `paymentReconciliationPage`, `paymentWebhooksPage`, `paymentAlertsPage`, `botConfigPage`, `botConfigExtras`, `catalogPlansPage`, `pageTabs`, `promocodesPage`, и две константы. Эти ключи никогда не использовались UI — устаревший legacy.

**First-paint payload (RU оператор, gzipped):**

| было | стало | Δ |
|---|---|---|
| ~535 kB | **~444 kB** | **−91 kB / −17%** |

### Bundle metrics

| chunk | до | после | Δ |
|---|---|---|---|
| `ru.js` core | 284 kB / 71 kB gz | 96 kB / 25.7 kB gz | **−66%** |
| `en.js` core | 179 kB / 54 kB gz | 60 kB / 19.8 kB gz | **−66%** |
| `index.js` app | 337 kB | 220 kB / 62.8 kB gz | −35% |

После открытия конкретного раздела догружается соответствующий feature-bundle (1.9–22.3 kB). Экономия линейная и максимальная для пользователей одного-двух разделов.

---

## 📐 Forms — react-hook-form + zod migration

8 крупных форм мигрированы на `react-hook-form` + `zod` с типобезопасной валидацией:

- `CreateUserDialog` (users)
- `PartnerSettingsForm` (partners)
- `PartnerSettingsPage` (settings/partner)
- `ReferralSettingsForm` (settings/referral, 23 поля)
- `PanelBrandingForm` (settings/panel#branding)
- `TelegramDeliveryForm` (notifications)
- `EmailDeliveryForm` (notifications)
- `PlatformSettingsPage` × 2 секции (settings)

Все validation-сообщения локализованы в обоих языках. Email/SMTP теперь с реальной валидацией портов (1–65535), адресов отправителя/получателя теста и обязательных полей при включённой доставке.

Итого: **11 форм на RHF+zod** (было 1 в baseline).

---

## ⚛️ React 19 effect cleanup

`useEffect` для синхронизации state с props — антипаттерн в React 19. Все такие места переписаны на render-time pattern по [официальному гайду](https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes):

- **0 `react-hooks/set-state-in-effect` disables** в коде админки (было 12+, оставлен 1 в vendored CountUp).
- **0 `react-hooks/exhaustive-deps` disables** в коде админки.
- Polling-аккумулятор `system-logs-page` переписан на key-based pattern с трекингом `latestId`.
- Auto-select-first-item в `automations-page` и `roles-page` — без effects.
- `appearance-page` editorMode↔resolvedMode sync — без effects.
- `gateway-settings-page`, `panel-branding-tab`, `quick-search-overlay` — без effects.

---

## 🏗 Architecture — shared infra

Новые переиспользуемые модули:

| модуль | назначение | тесты |
|---|---|---|
| `lib/safe-storage.ts` | localStorage wrapper для Safari Private Mode | 8 |
| `lib/api-utils.ts` | `unwrapPayload` / `isRecord` | 11 |
| `lib/http-errors.ts` | централизованный `getErrorMessage` | 7 |
| `lib/use-tab-sync.ts` | URL-hash ↔ tab state generic hook | 5 |
| `i18n/i18n.ts` | `loadFeatureBundle`, `withFeatureBundle` | (новое API) |
| `features/plans/plans-api.ts` | unified `usePlans()` hook + типобезопасные queryKeys | 7 |
| `features/users/user-detail-shape.ts` | typed `UserDetail` (заменил 19 файлов с `eslint-disable any`) | — |

### Декомпозиция

- **`admin-shell.tsx`**: 965 LOC monolith → 13 модулей в `admin-sidebar/` + `admin-topbar/`.
- **`user-detail-page.tsx`**: 1211 LOC дубль → 67 LOC thin wrapper над `UserDetailPanel`.
- **users / partners / admins pages**: locationHash → tab effects заменены на `useTabSync` (~66 строк boilerplate удалены).

---

## ✅ Quality gates

| проверка | результат |
|---|---|
| `tsc --noEmit` | **0 errors** |
| `eslint . --quiet` | **0 warnings** (strict 0-tolerance policy) |
| `vitest run` | **9 файлов / 55 тестов** passing (было 0 active) |
| `vite build` | 1.4 s, 132 chunks |
| `any` в feature-коде | **0** (вне vendored react-bits) |

---

## 🎨 UX polish

- `tw-animate-css@1.4.0` plugin добавлен — все shadcn-анимации (Collapsible chevron, Tabs fade-in, Dialog/Sheet) теперь работают на Tailwind v4.
- Payments → Analytics: выровнены "0.00" значения по правому краю.
- Полировка анимаций по фронтенду: fraud, audit, settings, notifications.
- ErrorBoundary теперь репортит crash'и в backend audit (rate-limited).
- `loadPermissions()` retry toast при ошибке аутентификации.

---

## 🛠 Developer tooling

Добавлены скрипты в `web/scripts/`:

- `measure-i18n-namespaces.cjs` — измеряет байтовый размер каждого top-level namespace
- `find-unused-i18n-namespaces.cjs` — находит namespace, на которые нигде не ссылаются
- `extract-i18n-namespace.cjs` — атомарно переносит namespaces в lazy feature-модуль

---

## 📦 Docker

```bash
docker compose pull
docker compose up -d
```

Образ `ghcr.io/dizzzable/rezeis:0.2.8` публикуется автоматически после merge тега `v0.2.8`.

---

## Migrating from 0.2.7

Без breaking changes. Стандартный `docker compose pull && docker compose up -d` достаточен.

---

# Rezeis Admin v0.2.7

## Платежи и безопасность

- 5 новых платёжных шлюзов (WATA, AuraPay, RollyPay, SeverPay, Lava.top), webhook-signature verification
- Новая вкладка `Payments / Analytics`: per-gateway GMV, success rate, p50/p95 time-to-pay, daily trend, webhook health
- Редизайн вкладки «Безопасность»: 2FA + Passkey + 6 OAuth-провайдеров встроены прямо в страницу
- `docker-entrypoint.sh` автоматически запускает `prisma migrate deploy` при старте API-контейнера

---

# Rezeis Admin v0.2.6

## Liquid Glass & Visual Effects Studio

### Liquid Glass — полная переработка

Система прозрачности и стеклянных эффектов полностью переписана с нуля.

- **Per-element glass controls** — индивидуальные toggle + blur slider для 7 элементов:
  - Sidebar, Header, Cards, Modals, Tabs, Buttons, Popover/Dropdowns
- **Background Studio** — выбор из 20 анимированных фонов (React Bits) с уникальными параметрами для каждого:
  - Silk, Aurora, Threads, Waves, Iridescence, Galaxy, Particles, DotGrid, LiquidChrome, Balatro, Beams, Plasma, Grainient, SoftAurora, Dither, LineWaves, RippleGrid, Lightning, Radar
  - Dropdown выбора + динамические controls из registry (slider/color/toggle/colorArray/rgbColor/select)
  - Live preview 300×200px с реальным компонентом
  - Draft → Apply workflow (настраивай без мгновенного применения)
- **Per-background props** — store хранит `{ id, opacity, props: Record<string, unknown> }` вместо generic speed/scale/color
- **CSS-driven transparency** — `data-liquid-glass-*` атрибуты на `<html>` + CSS `color-mix()` для полупрозрачности всех поверхностей
- **Header mode** — при включённом glass header по умолчанию полностью прозрачный (элементы на месте, фон просвечивает); toggle включает стеклянный blur
- **Global surface transparency** — `.bg-card`, `.bg-muted`, `.bg-background`, `.bg-accent`, inputs, `.rounded-lg.border` — всё становится полупрозрачным

### Visual Effects Studio (NEW)

Полноценная система кастомизации визуальных эффектов с 5 категориями:

- **Text Animation** (11 вариантов) — Shiny, Gradient, Glitch, Decrypted, Blur, Split, Scrambled, Fuzzy, Rotating, TrueFocus
  - `<TitleEffect>` / `<ShinyText>` автоматически рендерит выбранный эффект на заголовках
- **Cursor Effect** (6 вариантов) — Splash, Blob, Ghost, Crosshair, MagnetLines, PixelTrail
  - Глобальный overlay через `EffectsProvider`
- **Click Effect** (2 варианта) — ClickSpark, StarBorder
  - Canvas-based искры при клике в любом месте
- **Hover Effect** (4 варианта) — Spotlight, Glare, ElectricBorder, Magnet
  - `<HoverEffect>` wrapper для карточек
- **Content Animation** (3 варианта) — FadeContent, AnimatedContent, GradualBlur
  - `<AnimatedContent>` с поддержкой direction/delay

Каждая категория имеет:
- Dropdown выбора эффекта
- **Live preview** прямо в настройках (интерактивный — hover/click/анимация)
- Подсказка где эффект применяется
- Кнопка "Повторить" для анимаций

### UI/UX

- **Двухколоночный layout** настроек Glass и Effects (xl breakpoint)
- **Дефолтная тема зафиксирована**: dark mode, Liquid Chrome фон (opacity 50%), sidebar-primary `#aa1d8b`
- **i18n** — все новые ключи в ru.ts и en.ts (preview, replay, previewHint для каждой категории)
- **AppearanceProvider** расширен — устанавливает `data-liquid-glass-*` атрибуты и CSS-переменные `--liquid-glass-*-blur`

### Stores

- `glass-store.ts` — unified `setElementGlass(element, settings)` action, per-bg props
- `effects-store.ts` — 5 категорий эффектов, master toggle, persist в localStorage
- `theme-store.ts` — дефолт: dark + sidebar-primary override

### Файлы

| Новый файл | Назначение |
|-----------|-----------|
| `lib/theme/effects-store.ts` | Store визуальных эффектов |
| `components/EffectsProvider.tsx` | Глобальный cursor/click provider |
| `components/effects/TitleEffect.tsx` | Universal text animation renderer |
| `components/effects/HoverEffect.tsx` | Universal hover wrapper |
| `features/appearance/effects-settings-card.tsx` | UI настроек эффектов с live preview |
| `features/appearance/background-controls.ts` | Registry 20 фонов с ControlDef[] |

---

# Rezeis Admin v0.1.5

## Production-Ready Infrastructure Release

### BullMQ Job Queues (8 queues)
- **Broadcast** — async delivery (text/photo/video), edit, delete, retry, scheduled send
- **Backup** — pg_dump via BullMQ, auto-delivery to Telegram, restore from file
- **Imports** — async file processing (3xui, remnashop, altshop, remnawave), 202 pattern
- **Email** — SMTP delivery with branded templates, auto-send on events
- **Webhooks, Profile-Sync, Payments, Automations** — existing queues unified
- **Global QueueModule** — single Redis connection, no duplication

### Email Module (NEW)
- Full SMTP delivery via nodemailer + BullMQ
- Branded HTML templates (logo, colors from Settings)
- Auto-send on system events (subscription expired, payment completed, etc.)
- Admin UI: SMTP settings, verify connection, send test email
- Reiwa branding integration

### Health & Observability
- `GET /api/health` — DB + Redis + Queues + Disk status with latency
- `GET /api/health/live` / `GET /api/health/ready` — k8s probes
- Queue maintenance cron (every 6h): cleanup stale jobs, audit log rotation
- Graceful shutdown for BullMQ workers

### Security
- `@nestjs/throttler` — 60 req/min global, 5/min on login (brute-force protection)
- Request timeout middleware (30s default, 120s uploads, infinite SSE)
- Payment auto-retry (failed webhooks retried 3x with exponential backoff)

### Frontend
- **Sidebar drag-and-drop** — reorder items between categories, create custom categories
- **Header redesign** — GitHub update indicator (tiffany glow), Telegram link, Support/Donate
- **Backup page** — settings card (auto-backup, Telegram delivery, retention), restore button
- **Notifications** — Email SMTP settings tab alongside Telegram
- **Security tab** — password change form added
- **HWID device revoked** event — full Telegram notification with device block

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
