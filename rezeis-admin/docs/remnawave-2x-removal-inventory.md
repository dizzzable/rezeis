# Cutting Remnawave 2.x — done

> The inventory this file held (taken 20.09.2026 against v0.9.7.63) was worked
> through in the patch after 0.9.7.69. The owner's decision of 28.08.2026,
> restated 24.09.2026: **cut the 2.x branches and refuse such panels out loud;
> keep detection.** This note records what went and what deliberately stayed.

## The distinction the whole job turned on

Two different things wore the word «2.x» in this codebase, and only the first
was removed:

* **(A) Talking to a live 2.x panel** — addressing a profile by its UUID on the
  wire, the `/api/ip-control/*` endpoint family, the per-era request-body keys,
  the tolerant readers for 2.x response shapes. **Cut.**
* **(B) 2.x-era rows in OUR OWN database** — a `Subscription.remnawaveId` that
  holds a UUID because the profile was created on 2.x, on an install that has
  since upgraded to 3.x. Those rows do not go away with 2.x support, and the
  code that recognises them **stays**.

## What was cut

* **Every call to a 2.x panel is refused.** Once the version probe reports a
  major below 3, the three contract clients (through `LegacyPanelRefusal`) and
  `remnawave-api.service.ts` (through the same `PanelVersionGate`) answer
  `REZEIS_PANEL_TOO_OLD` instead of sending anything. Only the version reads go
  out: their answer is what identifies the panel. A version that cannot be read
  is never refused and never shapes a request — every request is built in the
  3.x shape.
* **The era on the request path**: uuid addressing, the `/api/ip-control/*`
  family and its route builders, the per-era body keys, and the era observation
  threaded through destructive paths. A stored link that is not a decimal id is
  refused on the destructive paths by one test, `!isNumericPanelIdentity(id)`,
  and the rows still holding one are counted.
* **The second-tier readers that accepted 2.x field names**, each replaced by a
  3.x-only read proven against the 3.3.2 / 3.4.3 OpenAPI shapes:
  * the webhook: the 2.7.4 expiry event names `user.expires_in_{72,48,24}_hours`
    (every warning is `user.expiration`; the old names are stored in the
    Activity Feed and forwarded nowhere), the `uuid` / `userUuid` user identity
    (an event names its profile by the numeric `id`), and `userUuid` in the
    payload allow-list;
  * `userUuid` / `uuid` on the HWID top-user, request-log and user-lookup rows
    (the fields the admin SPA reads keep their names; the request log's
    `userUuid` is always `null`);
  * the flat 2.7 billing-node row, the single 2.7 host `tag`, and the top-level
    2.7 `byApp` of the HWID stats.

  The node mapper was on the list for the nested `configProfile` read. It
  stays: every 3.x panel nests `activeConfigProfileUuid` too, and no spec puts it
  on the row, so the top-level read went instead.
* **The 2.x contract oracles** `@remnawave/contract-panel-2.7` and `-2.8`, and
  the fixture folders `test/fixtures/remnawave/2.7.4` and `2.8.0`. The specs that
  read them read the 3.x contracts and fixtures (`3.3.2`, and new `3.4.3` squad
  and status fixtures) instead.
* **The prose**: the README's refusal paragraph and contract table, the retired
  `docs/remnawave-redesign-plan.md`, and the `/api/ip-control/*` probes of
  `scripts/smoke-redesign-endpoints.sh`.

## What deliberately stays

* **Detection**: `getPanelShape`, `RemnawaveVersionService`, `PanelVersionGate`,
  and the probe's bypass of the refusal. `test/panel-infra-client.spec.ts` still
  reads a 2.7.4 metadata body, because recognising a 2.x panel is what the
  refusal stands on.
* **(B)**: the `'id'` fallback chain, `storedIdentityOf`, `panelIdentityLookup`,
  `panelIdentityWhere`, `isNumericPanelIdentity`, and both extra identity
  columns (`remnawavePanelId`, `remnawavePanelUsername`). An event about a
  profile created on 2.x is still matched: `panelIdentityWhere` looks its numeric
  id up in `remnawavePanelId` too.
* The three 409 codes and `STALE_PANEL_LINK`: wire and persisted values.
* The A025/A063 codes; the `lastSeenAt`/`updatedAt` and `isDeleted ?? true`
  tolerance.
* The drift reporter; `TESTED_VERSIONS`.
* The `uuid` key in the webhook payload allow-list: nodes, squads, providers,
  subpage configs and API tokens still carry one.
* The audit label `subscriptions_panel_link_reconciled`.
* History comments that do not claim anything about today's behaviour.

## Left for later

* `mapSubscriptionSettings` (`remnawave-extended-mappers.ts`) still reads the six
  top-level fields 2.x sent before the `customResponseHeaders` map every 3.x
  panel sends, only because `test/remnawave-api.service.spec.ts` feeds that
  shape. Move that case to the header map, then delete the six reads; the 3.x
  read is already pinned by `test/remnawave-extended-mappers.spec.ts`.
* The importers (`imports/**`): the "connected panel is keyed by uuid" verdict
  and the `keyKind` `'uuid'` are unreachable against a refused 2.x panel. A
  backup dump from a bot that ran on 2.x still writes donor uuids verbatim.
