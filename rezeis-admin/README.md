# rezeis-admin

Rezeis Admin — NestJS backend + React/Vite frontend for the admin panel.

- **Version:** `0.9.7.62`
- **Backend:** NestJS 12 · TypeScript 6 · Prisma 7 · PostgreSQL · Redis · BullMQ
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

`rezeis-admin` talks to Remnawave panels over plain HTTP, and the fleet it serves runs many panel versions at once. Two paths do the talking, and **neither executes a vendor schema at runtime** (13.09.2026 — this replaced a runtime dependency on `@remnawave/backend-contract@3.4.10`, described below because the reasons still matter):

- **`remnawave-api.service.ts`** reads answers with the tolerant local decoders in `panel-response-decoders.ts`.
- **`panel-infra.client.ts`, `panel-users.client.ts` and `panel-devices.client.ts`** go through `panel-command.executor.ts`, driven by the hand-owned command table in **`panel-commands.ts`**: the path, verb, description and request rules of the 21 commands production actually issues. Requests are validated before they are sent — bodies by the executor, path parameters and the two capped queries by the clients — with our own zod copy of the rules the vendor contract enforced for the inputs we send, and the executor sends the **parsed** body, so the vendor's defaults (`status: ACTIVE`, `trafficLimitStrategy: NO_RESET` on a create), key order and `expireAt` rendering still reach the wire. **Responses are not validated.** The clients hand back the panel's JSON behind their own envelope and array guards, which now run on every answer.

**Remnawave 2.x panels are refused.** Once the version probe (`GET /api/system/metadata`, sent over the bare transport) reports a major below 3, `LegacyPanelRefusal` in `panel-transport.ts` answers every command of those three clients with `REZEIS_PANEL_TOO_OLD` instead of sending it, so profile, device and subscription sync stop until the panel is upgraded to 3.x. A panel whose version cannot be read yet is not refused; it is treated as 3.x. What `remnawave-api.service.ts` sends over its own HTTP helpers is not behind the refusal.

Why the response parse went. The executor used to `safeParse` every answer with a pinned contract: parsed data on success, the raw body plus a "drift" warning on a mismatch. A contract describes ONE panel release, so a field a later release made required (`tags` on squads, from contract `3.4.11`) flagged every healthy 3.2/3.3 panel as drift, and the pin could never move past it. The parse did only two things to the answers rezeis reads — datetime strings became `Date`, undeclared keys were stripped — and an audit of every production reader found five that depended on either. Those five are now provided explicitly, per field (`panel-response-fields.ts`): `lastSeen` on both connection jobs and `requestAt` on the request log are decoded to `Date`, and the HWID stats `byPlatform` rows and the device inventory rows are projected to the declared keys; `test/panel-devices-client.spec.ts` and `test/panel-infra-client.spec.ts` hold each one to every era's own parse. The older lesson stands: the adapter once used `GetExternalSquadsCommand` from `@remnawave/backend-contract@2.7.3` as a hard gate, 3.x renamed `responseHeaders` to `responseHeadersAdd` + `responseHeadersRemove`, and every 3.x install with an external squad got `ServiceUnavailableException` from a healthy panel.

**No `@remnawave/*` package is in the runtime image.** The contracts are devDependency oracles, one per panel release family, named by the panel release and pinned exactly to the contract that release ships (table below). `Dockerfile` stage 1 runs `npm ci --omit=dev`, so none of them — and none of their AGPL-3.0-only licences — ships. That is enforced, not asserted: `test/panel-command-conformance.spec.ts` fails if any file under `src/` imports `@remnawave/*` (by value, by type, dynamically or by `require`), if `package.json` lists one outside `devDependencies`, if the lockfile marks one as a production package, or if this prints anything:

```bash
npm ls --omit=dev --all | grep @remnawave/   # nothing
npm ls --omit=dev zod                         # exactly one zod
```

### Contract versions follow panel releases, not the other way round

Remnawave publishes the pairing at <https://docs.rw/sdk/typescript-sdk/> ("Always pick and pin the correct version of the SDK to match the version of the Remnawave backend"). The rows that matter for this fleet, cross-checked against `libs/contract/package.json` at each backend tag, and the devDependency alias that holds each one. The `2.7` and `2.8` rows are test oracles only — for era decoding, the 2.x route shapes, the tag rule and the request log's `size` cap — and a panel on either is refused (see above):

| Live panel | Contract it ships | Test oracle |
|------------|-------------------|-------------|
| `2.7.3`–`2.7.4` | `2.7.2` | `@remnawave/contract-panel-2.7` |
| `2.8.0`–`2.8.1` | `2.8.35` | `@remnawave/contract-panel-2.8` |
| `3.2.0`–`3.2.1` | `3.2.0` | `@remnawave/contract-panel-3.2.1` |
| `3.2.3` | `3.2.3` | `@remnawave/contract-panel-3.2.3` |
| `3.3.0`–`3.3.2` | `3.4.2` | `@remnawave/contract-panel-3.3` |
| `3.4.0`–`3.4.3` | `3.4.13` | `@remnawave/contract-panel-3.4.3` |
| `3.4.4` | `3.4.15` | `@remnawave/contract-panel-3.4.4` |

Consequences, all measured:

- **The contract's number is not the panel's.** `3.4.2` is the contract of panel **3.3**. Contract releases are also published ahead of panel tags — `3.4.3` to `3.4.12` appeared before panel 3.4.0 existed — so a contract version can match no panel at all. The former runtime pin, `3.4.10`, was one of those, and so was the former `~2.7.3` oracle.
- **No single contract accepts every release's answers.** From `3.4.11` on, `tags` is required on six list rows (internal and external squads, config profiles, node plugins, subpage configs, templates), and panels 3.2 and 3.3 do not send it; the 2.x contracts refuse 3.x squad rows over `responseHeaders`. The matrices are pinned in `test/remnawave-squad-status-era-decode.spec.ts` and `test/remnawave-user-row-era-conformance.spec.ts`, each capture judged against the contract its own release ships.
- **The request side is identical across the whole 3.x fleet**, for the 21 commands rezeis issues, with two measured exceptions that do not reach the wire: `CreateUserCommand.vlessUuid` changed its guid pattern after contract `3.2.0` (rezeis never sends `vlessUuid`), and contracts from `3.4.12` run zod 4.5, which requires seconds in a datetime carrying `Z` or an offset (rezeis sends `toISOString()`; its own zod is 4.5.4).

### What the conformance test proves, and what it does not

`test/panel-command-conformance.spec.ts` compares every entry of `panel-commands.ts` with the 3.x oracles (`3.2.0`, `3.2.3`, `3.4.2`, `3.4.13`, `3.4.15`): the URL each builder produces for sample segments, the verb, which request schemas exist, the accept/refuse verdict on a corpus of accepted and refused inputs, and — for an accepted body — the parsed body, byte for byte, because that is what goes on the wire. A route, verb or rule that drifts in any era fails it; the one legitimate era disagreement (the zod 4.5 datetime tightening) is a named exception whose count is pinned. `test/panel-wire-bytes.spec.ts` separately pins the exact request bytes at every production call site, recorded from the build that still ran the vendor schema.

It does **not** validate responses (nothing does, by design), and it does not cover the two queries the clients have never validated (`GET /api/subscription-request-history/`, `POST /api/bandwidth-stats/nodes/users`); for those it checks that the values production sends are accepted by every era. The `uaRequestPageSize` tunable stops at 1000, the cap every contract puts on that request log's `size`; `test/subscription-ua-page-size-cap.spec.ts` holds it there. (Its ceiling used to be 2000, so a saved 1001–2000 was refused by the panel on every detector run.)

It compares verdicts and parsed bodies, never error wording, and that is deliberate: zod keeps its message locale on `globalThis.__zod_globalConfig`, shared by every copy in a process, and the last copy loaded wins. In any test process that loads an oracle bundling its own zod 4.4.3 (`contract-panel-3.2.1`, `-3.2.3`, `-3.3`), the messages of rezeis's zod 4.5.4 are written by 4.4.3's locale — `expected number, received number` where production says `received Infinity`. Production has one zod, so this affects tests only; do not assert zod's default wording in a file that loads those oracles.

Era detection keys on the MAJOR version only (`panel-version.util.ts`, and `PanelVersionGate` in `panel-clients.providers.ts` for the refusal), so every 3.4.x is handled the same way with no list to extend, and every 2.x panel is refused alike.

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

One unified image (API + worker + SPA) is published to GHCR by `.github/workflows/docker-publish.yml`. Its tags are channels:

- `ghcr.io/dizzzable/rezeis:latest` — the last release; it moves only when a `v*` tag is pushed
- `ghcr.io/dizzzable/rezeis:v0.9.7.62` — a specific release (the current one)
- `ghcr.io/dizzzable/rezeis:main` — the current `main` branch, not a release
- `ghcr.io/dizzzable/rezeis:sha-<short>` — every built commit

Release tags have four parts, which is not semver, so the workflow's `type=semver` lines publish no `major.minor.patch` or `major.minor` tags.

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
