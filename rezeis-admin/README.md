# rezeis-admin

Rezeis Admin — NestJS backend + React/Vite frontend for the admin panel.

- **Version:** `0.9.7.56`
- **Backend:** NestJS 11 · Prisma 7 · PostgreSQL · Redis · BullMQ
- **Frontend:** React 19 · Vite 8 · TanStack Query 5 · shadcn/ui · Tailwind 4

## Layout

```
.
├── src/                NestJS application + worker
├── prisma/             schema + migrations
├── web/                React/Vite admin SPA
└── docker-compose.yml  full local stack
```

## Remnawave compatibility

`rezeis-admin` talks to Remnawave panels over plain HTTP, and the fleet it serves runs many panel versions at once — 2.7 through 3.4. Two paths do the talking, and they treat vendor schemas differently. This section used to say that no vendor schema is ever applied to a live response. **That was wrong**, and it is corrected here (13.09.2026) rather than quietly rewritten:

- **`remnawave-api.service.ts`** reads answers with the tolerant local decoders in `panel-response-decoders.ts`. No vendor schema is involved.
- **`panel-infra.client.ts`, `panel-users.client.ts` and `panel-devices.client.ts`** go through `panel-command.executor.ts`, which DOES apply the pinned vendor contract to live traffic in both directions: an outgoing body is replaced by its parsed form, path and query parameters are validated so a malformed request is refused before it is sent, and **every response is `safeParse`d** — on success the caller receives the parsed data (undeclared keys stripped, date strings turned into `Date`), on a mismatch a drift warning is logged and the raw body is returned. It never throws on a mismatch, which is the lesson of a real outage: the adapter once used `GetExternalSquadsCommand` from `@remnawave/backend-contract@2.7.3` as a hard gate, 3.x renamed `responseHeaders` to `responseHeadersAdd` + `responseHeadersRemove`, and every 3.x install with an external squad got `ServiceUnavailableException` from a healthy panel.

So one vendor package is a runtime dependency: `@remnawave/contract-v34` sits in `dependencies`, ships inside the published image, and carries its AGPL-3.0-only licence. Whether that is acceptable is a licensing question for the owner and it is open. The check this section used to name could not fail, because it names a different package:

```bash
npm ls --omit=dev @remnawave/backend-contract   # (empty)
npm ls --omit=dev @remnawave/contract-v34       # present, and therefore in the image
```

### Contract versions follow panel releases, not the other way round

Remnawave publishes the pairing at <https://docs.rw/sdk/typescript-sdk/> ("Always pick and pin the correct version of the SDK to match the version of the Remnawave backend"). The rows that matter for this fleet, cross-checked against `libs/contract/package.json` at each backend tag:

| Live panel | Contract it ships |
|------------|-------------------|
| `2.7.3`–`2.7.4` | `2.7.2` |
| `2.8.0`–`2.8.1` | `2.8.35` |
| `3.2.0`–`3.2.1` | `3.2.0` |
| `3.2.3` | `3.2.3` |
| `3.3.0`–`3.3.2` | `3.4.2` |
| `3.4.0`–`3.4.3` | `3.4.13` |
| `3.4.4` | `3.4.15` |

Three consequences, all measured:

- **The contract's number is not the panel's.** `3.4.2` is the contract of panel **3.3**. Contract releases are also published ahead of panel tags — `3.4.3` to `3.4.12` appeared before panel 3.4.0 existed — so a contract version can match no panel at all. The current runtime pin, `3.4.10`, is one of those, and so is the `~2.7.3` oracle.
- **No single contract is quiet on every era.** From `3.4.11` on, `tags` is required on six list rows (internal and external squads, config profiles, node plugins, subpage configs, templates); panels 3.2 and 3.3 do not send it, so a 3.4.13+ runtime pin logs drift on every healthy 3.2/3.3 squad read — which is exactly what `test/panel-infra-client.spec.ts` caught when the pin was tried at 3.4.15. `3.4.10` already logs drift on 3.2 node rows. `3.4.12` and later also pin zod exactly at 4.5.x.
- **The request side is identical across the whole 3.x fleet.** Between contracts `3.2.2` and `3.4.15`, none of the 55 commands the three clients import changed its URL, verb, or request schema. Moving the pin from `3.4.2` to `3.4.10` in 0.9.7.55 therefore changed nothing that is sent.

Era detection keys on the MAJOR version only (`panel-version.util.ts`), so every 3.4.x is handled the same way with no list to extend.

**Panel 3.4.4 (12.09.2026) needs nothing here, and that is a checked statement rather than a hopeful one.** The whole `3.4.3...3.4.4` diff is 27 files; on the surface rezeis reads, every change is additive: a `POST /api/hosts/actions/clone` endpoint with its route and one new error code (`A258`), and three new subscription-template variables. No host, user, node or internal-squad response schema moved. Specifically checked because it would have mattered:

- `hosts.repository.ts` is in the diff, and it is the file `findActiveHostsByUserId` lives in — the query the host squad rule is derived from. The change is view-position bookkeeping for the new clone endpoint; the squad equality is untouched.
- `subscription-refill-date` now follows the user's real reset schedule instead of the next calendar boundary. rezeis never reads that header, and its own reset-cycle policy is its own (`modules/add-on-entitlements`), so nothing follows from it here.
- The default response rules changed one user-agent regex. rezeis only checks that `responseRules` is an object, and never reads the rules.
- The "subscription request payload" fix renames a field inside Remnawave's own Redis stream, which rezeis does not consume.

`mapHost` remains the authority for a host row: it reads both the pre-3.4 and the 3.4 squad shapes and is tested against the OpenAPI dumps.

## Quick start

```bash
# Backend
npm install
npx prisma generate
cp .env.example .env  # fill in values
npm run start:dev

# Frontend
cd web
npm install
cp .env.example .env
npm run dev
```

## Build

```bash
# Backend
npm run build           # → dist/main.js + dist/worker.js

# Frontend
cd web && npm run build # → dist/
```

## Docker

Both images are published to GHCR on every push to `main`:

- `ghcr.io/dizzzable/rezeis:v0.9.7.56`
- `ghcr.io/dizzzable/rezeis:0.9.7`
- `ghcr.io/dizzzable/rezeis:sha-<short>`

Local build:

```bash
cp .env.example .env
# Set generated DATABASE_PASSWORD and REDIS_PASSWORD before starting compose.
docker compose build
docker compose up
```

`docker-compose.yml` does not ship production DB/Redis passwords. It requires
`DATABASE_PASSWORD` and `REDIS_PASSWORD` from `.env` or the shell and builds the
runtime DB/Redis connection settings from the split `DATABASE_*` and `REDIS_*`
variables.

The compose stack runs the API container with `RUID_PROCESS_ROLE=api` and the
worker container with `RUID_PROCESS_ROLE=worker` so scheduled jobs and worker
side effects do not double-run in split mode.

## Product surfaces

The admin panel is more than a VPN subscription CRUD surface. Its major
operator-facing areas are:

- **Catalog and lifecycle:** plans, paid/free trials, multi-subscription
  lifecycle, auto-renewal, device and traffic limits, add-ons, and promocodes.
- **Revenue and growth:** 15 payment gateways, checkout/webhook/reconciliation
  operations, payment analytics, referrals, multi-level partners and
  withdrawals, quests, and advertising requests.
- **Support and communications:** broadcasts, event-driven notifications,
  FAQ with media, support tickets and document requests, AI-support controls,
  Bot Studio, custom emoji packs, and Web Landing/Subpage configuration.
- **Infrastructure and operations:** Remnawave provisioning and profile sync,
  dashboard/system health, realtime updates, system events/logs, anti-fraud,
  imports, backups/restores, and configuration portability.
- **Security and governance:** RBAC, admin accounts, API tokens, 2FA,
  passkeys, OAuth/external auth, IP allow/block lists, webhook controls, and
  audit logs.

## WEB Reiwa branding contract

`rezeis-admin` owns the user-facing branding configuration consumed by Reiwa.
The **WEB Reiwa** page persists resolved design tokens rather than requiring
the runtime to look up the admin preset catalog. That keeps the user cabinet
stable across an admin-panel outage or a catalog update.

- **Preset catalog:** eight legacy themes plus 104 conceptual presets. A
  conceptual preset includes palette, app background, surfaces, typography,
  corner radii, card gradient/pattern, and card-effect defaults.
- **Brightness policy:** operators select the concept and a default `light` or
  `dark` representation. `user-selectable` permits users to change only that
  representation; it never grants selection of a different operator theme.
- **Card precedence:** global card controls are the baseline. A positional
  slot inherits those controls by default; an explicit `override` is required
  to change an effect for that subscription position. A slot's static gradient
  remains an independent, deliberate choice. Up to 20 slots are accepted.
- **Contrast and glass:** text policy (`auto`, light, dark, custom) and the
  optional glass composition are independent from effect colours, so a
  contrast decision cannot silently rewrite an operator's gradient.
- **Safe preview/runtime:** the admin preview and Reiwa use matching guarded
  effect runtimes. If Canvas/WebGL is unavailable or fails at runtime, they
  retain the configured gradient and display a CSS fallback of the selected
  effect with the configured palette and opacity.

See the public-runtime details in the [Reiwa README](../../reiwa/README.md#-контракт-брендинга-web-reiwa).

## Quality gates

```bash
# Backend
npm run typecheck
npx eslint . --quiet

# Frontend
cd web
npx tsc -p tsconfig.app.json --noEmit
npx eslint . --quiet
npm run build
npm run doctor          # react-doctor scan
```

A `react-doctor` GitHub Action is configured to comment on every PR touching `web/`.
