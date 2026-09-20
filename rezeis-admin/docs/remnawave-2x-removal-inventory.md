# Cutting Remnawave 2.x — the full inventory

> Taken 20.09.2026 against `main` at v0.9.7.63. Owner's decision of 28.08.2026,
> restated 20.09.2026: **cut the 2.x branches and refuse such panels out loud.**
> Detection stays. This file is the checklist that work runs from; it exists so
> the cut is one pass over a known surface rather than a search.

## The one distinction the whole job turns on

Two different things wear the word «2.x» in this codebase, and only the first
is being removed:

* **(A) Talking to a live 2.x panel** — addressing a profile by its UUID on the
  wire, the `/api/ip-control/*` endpoint family, the per-era request-body keys,
  the tolerant readers for 2.x response shapes. **This is what gets cut.**
* **(B) 2.x-era rows in OUR OWN database** — a `Subscription.remnawaveId` that
  holds a UUID because the profile was created on 2.x, on an install that has
  since upgraded to 3.x. Those rows do not go away when 2.x support does, and
  the code that recognises and repairs them **must stay**.

Conflating them is not a style mistake, it costs a live profile: a stored UUID
assessed against an `'unknown'` era (proceed — the address builder emits the
stored string, the panel answers 400) and then addressed against `'id'` (fall
back through `panelId` / short uuid / username) resolves to a **different,
live** profile and deletes it. That is why `PanelEraObservation` is threaded by
value through the destructive paths, and it stays threaded: `'unknown'` does
not disappear with 2.x, only `'uuid'` does.

## Order of operations

1. **Refuse first.** `LegacyPanelRefusal` (`panel-transport.ts`) already turns
   away every request from the three contract-driven clients once the version
   probe reports a major below 3 — `status: 0` (no request was made), code
   `REZEIS_PANEL_TOO_OLD`, a Russian message telling the operator to upgrade.
   The old adapter, `remnawave-api.service.ts`, sends over its own HTTP helpers
   and goes around it. Put its calls behind the same refusal.
2. **Then delete**, because every 2.x branch is now provably unreachable rather
   than assumed to be.
3. **Then the oracles and the docs**, which are inert and can go last.

## Step 1 — the refusal (small, self-contained, releasable on its own)

| Where | What |
| --- | --- |
| `remnawave/services/remnawave-api.service.ts` | 62 public methods over its own HTTP helpers, 34 consumers across `src/`. The helpers need the same major-below-3 check `LegacyPanelRefusal` performs. The version probe itself must stay exempt — its answer is what identifies the panel. |
| `remnawave/services/remnawave-version.service.ts` | `TESTED_VERSIONS = {'3.2','3.3','3.4'}` and `supported` already say 2.x is untested; nothing to cut, but this is where an explicit "refused" state belongs if the SPA is to name it. |

## Step 2 — the 2.x branches, file by file

### Version → shape derivation

| File | Symbol | Verdict |
| --- | --- | --- |
| `remnawave/services/panel-version.util.ts` | `userAddressingFor(2) → 'uuid'` | **cut** — the arm, and `'uuid'` leaves `RemnawaveUserAddressing`. |
| `remnawave/services/panel-version.util.ts` | `connectionsApiFor(2) → 'ip-control'` | **cut** — the arm, and `'ip-control'` leaves `RemnawaveConnectionsApi`. |
| `remnawave/services/panel-version.util.ts` | `parseSemver`, `PanelEraObservation`, the two cache TTLs | **keep** — detection, and the unknown-era guard. |
| `remnawave/services/remnawave-version.service.ts` | 6 uses of the derivations | **keep**, narrowed to the surviving arms. |
| `update-checker/services/update-checker.service.ts` | its own private `parseSemver` | **untouched** — rezeis's own releases, nothing to do with the panel. |

### Addressing

| File | What | Verdict |
| --- | --- | --- |
| `remnawave/services/panel-user-address.ts` (506 lines) | `case 'uuid'` in `panelUserAddress` | **cut** — the live-2.x arm only. |
| same | `case 'id'`, `storedIdentityOf`, `panelIdentityLookup`, the `needsResolve` / `impossible` results, the short-uuid recovery | **keep** — this is (B): it is what reads a stored 2.x UUID correctly *against a 3.x panel*. |
| same | `panelDeviceOwnerKey` | **keep, simplify** — it already picks the body key by the FORM of the segment, not by the era. |
| `remnawave/services/remnawave-api.service.ts` | 42 era/addressing references, 3 `panelDeviceOwnerKey` call sites | **narrow** to the 3.x arm. |
| `remnawave/services/panel-users.client.ts`, `panel-devices.client.ts` | 1 era reference each | **narrow**; these are already behind the refusal. |

### Live connections

| File | What | Verdict |
| --- | --- | --- |
| `remnawave/services/panel-routes.ts` | `ipControlUserStart`, `ipControlUserResult`, `ipControlNodeStart`, `ipControlNodeResult`, `ipControlDrop` | **cut** — no consumer outside the adapter. |
| `remnawave/services/remnawave-api.service.ts` | 5 call sites, all shaped `is3x ? connections… : ipControl…` (lines ~2574–2638 at v0.9.7.63) | **cut the else arm.** Mechanical. |

### Tolerant readers for 2.x response shapes (second tier — dead, not dangerous)

| File | What |
| --- | --- |
| `remnawave/services/remnawave-extended-mappers.ts` | `userUuid` beside a numeric `id`, the flat 2.7.x device row, `nodeUuid` on 2.7 node rows, and the absence-vs-emptiness rule that tells a 3.x row from a damaged 2.x one. |
| `remnawave/services/remnawave-host-mapper.ts`, `remnawave-squad-mappers.ts`, `remnawave-webhook.service.ts`, `remnawave-metrics-collector.service.ts` | Same class: readers that accept either era's field names. |

These become unreachable the moment step 1 lands. Removing them is real
simplification, but it is also the only part of the job that can *narrow* what
a 3.x panel is allowed to answer — several of these readers are deliberately
more tolerant than the published contract, and that tolerance is what keeps
cosmetic panel drift from becoming an outage. Cut them last, one at a time,
each with its contract oracle in front of you.

### Callers that hold an era but are NOT about 2.x

All **keep** — they thread `PanelEraObservation` so that one reading of the era
is carried by value through a destructive path. `'unknown'` outlives 2.x, so
the threading outlives it too; only the `'uuid'` case disappears.

`connect-signal/services/connect-signal-probe.service.ts` ·
`profile-sync/panel-link-reconciliation.service.ts` ·
`profile-sync/duplicate-subscription-merge.service.ts` ·
`profile-sync/profile-sync.processor.ts` ·
`internal-user/controllers/internal-user-devices.controller.ts` ·
`add-on-entitlements/services/device-reduction-plan.service.ts` ·
`add-on-entitlements/services/device-reduction-execution.service.ts` ·
`users/services/user-deletion.service.ts` ·
`users/services/bulk-user-operations.service.ts` ·
`users/controllers/admin-user-subscriptions.controller.ts` ·
`subscriptions/services/subscription-deletion.service.ts`

**`remnawave/services/stale-panel-link.ts` (416 lines) — keep in full.** It is
(B) end to end: a stored link that no longer names anything on a 3.x panel. It
has nothing to do with whether a 2.x panel is supported.

## Step 3 — tests

29 spec files mention an era. Three groups:

* **Rewrite to the surviving arm** (the 2.x case becomes the refusal case):
  `remnawave-panel-addressing.spec.ts` (23 refs), `remnawave-version.service.spec.ts`,
  `remnawave-strict-adapter.spec.ts`, `remnawave-user-row-era-conformance.spec.ts`,
  `remnawave-panel-user-write-decode.spec.ts`, `remnawave-user-absence-codes.spec.ts`,
  `connect-signal-probe.spec.ts`, `bulk-user-panel-actions.spec.ts`,
  `admin-user-subscriptions.controller.spec.ts`, `subscription-panel-action-audit.spec.ts`,
  `subscription-request-history.spec.ts`, `internal-user.service.spec.ts`,
  `expired-profile-cleanup.service.spec.ts`, `web-auth-reset.spec.ts`,
  `system-events-card-language.spec.ts`, `subscriber-notification-prefs.spec.ts`,
  `connect-help-postgres.spec.ts`, `connect-signal-postgres.spec.ts`.
* **Keep as they are — they are about (B), not about 2.x support:**
  `subscription-delete-stale-panel-link.spec.ts` (34 refs),
  `subscription-regenerate-stale-panel-link.spec.ts`, `device-reduction-stale-panel-link.spec.ts`,
  `device-reduction-plan-stale-panel-link.spec.ts`, `device-reduction-blocked-reason-visibility.spec.ts`,
  `device-reduction-execution.service.spec.ts`, `user-deletion.service.spec.ts`,
  `subscription-deletion.service.spec.ts`, `panel-link-reconciliation.service.spec.ts`,
  `duplicate-subscription-merge.service.spec.ts`,
  `add-on-entitlement-postgres-concurrency.spec.ts`.
* **Add one:** a spec that pins the refusal for the old adapter, the way the
  contract clients are pinned today. Without it nothing stops a later change
  from routing around the refusal again — which is exactly how the adapter came
  to be the half that was missed.

Note the four Postgres-backed specs above (`*-postgres*`, `add-on-entitlement-postgres-concurrency`):
they run only in the fourth CI job and are silently skipped locally without a
live database. Run them deliberately.

## Step 4 — vendor oracles and prose

* `package.json` devDependencies: `@remnawave/contract-panel-2.7` (→ `backend-contract@2.7.2`)
  and `@remnawave/contract-panel-2.8` (→ `2.8.35`). They are **build-time oracles
  only** — `test/panel-command-conformance.spec.ts` fails if anything under
  `src/` imports `@remnawave/*`, and stage 1 of the `Dockerfile` runs
  `npm ci --omit=dev`, so no AGPL-3.0-only code reaches the image. Dropping the
  two 2.x pins means the conformance specs that iterate «every contract the
  fleet ships» iterate five instead of seven; check each before deleting:
  `remnawave-3x-contract-guard.spec.ts`, `remnawave-squad-status-era-decode.spec.ts`,
  `remnawave-user-row-era-conformance.spec.ts`, `panel-infra-client.spec.ts`,
  `remnawave-panel-user-write-decode.spec.ts`, `subscription-ua-page-size-cap.spec.ts`,
  `test/helpers/remnawave-tag-contract.ts`.
  Keeping them costs nothing at runtime; they are only worth removing once no
  test reads them.
* `docs/remnawave-redesign-plan.md` is written against 2.7.4 as the live panel
  and contradicts this decision from its first paragraph. Rewrite or retire it.
* `README.md` and `docs/operator-add-on-entitlements-rollout.md` name 2.x —
  a prose pass, last.

## Done when

* A panel reporting a major below 3 gets `REZEIS_PANEL_TOO_OLD` from **every**
  path, not just the three contract clients, and a spec says so.
* `grep -rn "ip-control" src/` is empty.
* `RemnawaveUserAddressing` has two members, and `'uuid'` is not one of them.
* `stale-panel-link.ts` and the eleven era-threading callers above are byte-for-byte
  unchanged in behaviour — their specs pass untouched.
* Full local run of all four CI jobs, the Postgres one included.
