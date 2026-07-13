# Spec Run Manifest

- run_id: `20260711-200606-9e4bf3`
- feature_slug: `subscription-add-on-entitlements`
- workflow: `requirements-first`
- status: `implementation-in-progress-t003`
- language: `ru`
- started_at: `2026-07-11T20:06:06+03:00`
- selected repositories and revisions:
  - Rezeis — `V:/REZEIS_ADMIN_RUID_USER/rezeis`, branch `feature/subpage-config`, revision `1111258d3b83edcbe74a142f78ff20b3beace2fc`
  - Reiwa — `V:/REZEIS_ADMIN_RUID_USER/reiwa`, branch `main`, revision `721b8159eac2f9b2192c3bb4e464514d4ce41bf8`
- Phase-0 git-status baselines:
  - Rezeis: clean (`git status --short` returned no entries)
  - Reiwa: clean (`git status --short` returned no entries)
- write allowlist: `.hermes/specs/subscription-add-on-entitlements/**` in Rezeis only

## Feature statement

Спроектировать полноценные коммерческие Add-on entitlements для существующей подписки: одноразовые, стекуемые покупки дополнительного трафика или устройств с настраиваемым сроком `UNTIL_NEXT_RESET` либо `UNTIL_SUBSCRIPTION_END`, корректной активацией/истечением/renewal, идемпотентным fulfillment и синхронизацией с Remnawave 2.7.4/2.8.0 через Rezeis как source of truth и Reiwa как пользовательский edge/UI.

## Scope

### In scope

- каталог и admin-конфигурация Add-ons;
- lifetime policy per catalog option;
- immutable commercial snapshots and entitlement ledger;
- direct purchase and optional inclusion in renewal checkout;
- stackable traffic/device effects for a specific subscription;
- activation, scheduled activation, expiry, reconciliation and operator recovery;
- projection of effective limits to Remnawave;
- safe HWID reduction when a temporary device entitlement ends;
- Reiwa API/UI contracts and admin visibility;
- migrations/backfill, compatibility, observability, tests and rollout.

### Non-goals

- recurring/auto-recurring Add-on subscriptions;
- assigning an Add-on globally to all of a user's subscriptions;
- treating a manual/early Remnawave traffic reset as commercial-cycle completion;
- changing visible device names or adding user-facing device numbering;
- redesigning unrelated payment gateways, plan billing or `rezeis-subpage` unless research proves a required contract dependency;
- package/version bump, commit, tag, push, deploy or release.

## Constraints and accepted product decisions

- Rezeis is commercial/system source of truth; Reiwa is the user-facing edge/BFF.
- Remnawave compatibility must cover supplied 2.7.4 and 2.8.0 OpenAPI artifacts.
- Add-ons are one-time, stackable purchases bound to one subscription and never auto-recurring.
- Lifetime is configurable per catalog option: `UNTIL_NEXT_RESET` or `UNTIL_SUBSCRIPTION_END`; default is `UNTIL_NEXT_RESET`.
- Selected options may be offered again in renewal checkout.
- An early/manual traffic reset clears usage only and SHALL NOT expire `UNTIL_NEXT_RESET`; expiry uses the planned commercial cycle boundary.
- Device overage expiry removes the most recently registered HWIDs by validated `createdAt`, deterministic tie-breaker and exact `hwid`; UI order/name/last-seen are not selectors.
- If device timestamps are missing/invalid, automation must fail safe and require operator action rather than guess.
- `EXTRA_DEVICES` must not be offered where the effective/base plan device limit is unlimited.
- No product/release action without a later explicit implementation approval; no release unless operator says `выпускай` or `релизь`.

## Actors and integrations

- subscriber in Reiwa;
- administrator/operator in Rezeis Admin;
- Reiwa API/BFF and SPA;
- Rezeis NestJS API/worker/Prisma/PostgreSQL/queues;
- payment gateway and reconciliation worker;
- Remnawave 2.7.4/2.8.0 API and webhooks.

## Open questions to resolve from evidence or mark explicitly

1. Exact representation of base plan limits versus effective projected limits, and safe backfill for existing subscriptions.
2. Exact local commercial-cycle anchor required for each Remnawave reset strategy; undocumented vendor calendar semantics must not be guessed.
3. Renewal checkout activation boundary for options bought before the next term begins.
4. Operator-state model and retry policy for paid fulfillment, expiry projection and destructive HWID cleanup failures.
5. Whether `rezeis-subpage` consumes any affected contract (default assumption: no).
