# Operator runbook — Subscription add-on entitlements (staged rollout & rollback)

This runbook covers enabling the durable add-on entitlement feature
(`subscription-add-on-entitlements`) in production. Every stage is guarded by a
**deployment-time environment flag** (not panel-editable). All flags default to
**OFF**, so the legacy one-time top-up path stays authoritative until an
operator opts a stage in. Enable **one stage at a time**, verify, then proceed.

> Golden rule: the legacy path must keep working at every stage. If any stage
> misbehaves, turn its flag OFF — the system falls back to the legacy path and
> the reconciler keeps fulfilling already-admitted paid lines.

## 0. Prerequisites (once, before any flag)

1. Deploy the code + apply migrations at deploy time:
   `npx prisma migrate deploy` (idempotent — a rerun reports
   "No pending migrations to apply").
2. Confirm the Prisma client is generated at build (`npx prisma generate`).
3. No flag is needed for the schema to exist; the tables sit dormant.

## 1. Cutover (grandfather existing subscriptions into terms) — SHADOW

Run the T-004 cutover to create an `ACTIVE` `SubscriptionTerm` + a `SHADOW`
`SubscriptionEffectiveProjection` for each live subscription. The projection is
computed to **equal the legacy limits** (canonical `null` = unlimited), so it is
purely observational at this point.

- Enable stage 1: `ADDON_ENTITLEMENT_SHADOW=true`.
- Verify (shadow report): for a representative finite / unlimited / legacy
  sample, `projection.desiredTrafficLimitBytes` / `desiredDeviceLimit` **equal**
  the subscription's legacy `trafficLimit`/`deviceLimit` (unlimited → `null`).
  Zero unexpected mismatches is the go/no-go.
- Idempotency: a second cutover for the same subscription is a no-op
  (`SKIPPED_EXISTING`), never a duplicate term/projection.
- Rollback: `ADDON_ENTITLEMENT_SHADOW=false`. Terms/projections remain but are
  ignored; legacy stays authoritative.

## 2. Direct add-on purchases commit the ledger

- Enable stage 2: `ADDON_ENTITLEMENT_DIRECT_PURCHASE=true` (assumes stage 1).
- Effect: a completed add-on top-up on a subscription **with an active term**
  records an immutable `AddOnEntitlement`, recomputes the effective projection,
  and **mirrors** it into the legacy limit columns so profile-sync keeps
  applying the ledger-backed limit. Unlimited baseline → recorded as a no-op
  (fixes the legacy `0 + N` device bug). No active term → falls back to the
  legacy increment.
- Verify: a paid add-on produces one `ACTIVE` entitlement; the mirrored
  `trafficLimit`/`deviceLimit` matches base + add-on; an idempotent re-apply
  (webhook replay) does **not** create a second entitlement or double the limit.
- Rollback: `ADDON_ENTITLEMENT_DIRECT_PURCHASE=false`. New purchases use the
  legacy increment again; already-recorded entitlements keep their mirrored
  limits and remain visible.

## 3. Versioned projection drives Remnawave

- Enable stage 3: `ADDON_PROJECTION_SYNC=true` (assumes stages 1–2).
- Effect: profile-sync performs a strict versioned desired-state write
  (PATCH + strict read-back) → `APPLIED`/`lastAppliedRevision` or `DRIFTED`.
  Supersession-by-revision + DELETE-priority + expired-lease recovery guarantee
  convergence.
- Verify: SLO/metrics (`EntitlementMetricsService`) show desired revisions
  converging to applied; no persistent `DRIFTED`.
- Rollback: `ADDON_PROJECTION_SYNC=false` → legacy limit-column sync only.

## 4. Commercial reset expiry (per strategy, AFTER parity)

Only after staging parity is verified against **both** supported Remnawave
versions (2.7.4 and 2.8.0) for the given strategy.

- Enable per strategy: `ADDON_RESET_EXPIRY_DAY` / `_WEEK` / `_MONTH` /
  `_MONTH_ROLLING`. A strategy is `ENABLED` only when its flag is on.
- Effect: `UNTIL_NEXT_RESET` add-ons are offered + bound to the term's reset
  epoch; the term's first `SubscriptionResetEpoch` is created on activation.
- Do **not** enable a strategy on partial evidence. Rollback: turn the strategy
  flag OFF — `UNTIL_NEXT_RESET` reverts to the legacy path; epochs are not
  deleted.

## 5. Renewal add-on composition

- Enable stage 5: `ADDON_RENEWAL_ADDONS=true` (assumes stages 1–2).
- Effect: renewal checkout accepts eligibility-gated add-on lines (priced in the
  gateway currency); fulfillment creates the SCHEDULED renewal term + its
  `PENDING` entitlements **atomically** (paid goods are never lost to a
  best-effort failure). The reiwa cabinet surfaces the add-on selection step
  (gated by the `renewalAddOns` capability in the platform-policy payload).
- Verify: a renewal with add-ons produces a gen-N+1 SCHEDULED term + one
  `PENDING` entitlement per line; flag OFF ⇒ selections are ignored (plan-only).
- Rollback: `ADDON_RENEWAL_ADDONS=false` → renewal ignores add-on selections;
  the cabinet hides the step (capability reads false).

## 6. Automatic device reduction (LAST)

- Enable stage 6: `ADDON_DEVICE_CLEANUP_AUTO=true`.
- Effect: the deterministic HWID reduction plan is executed automatically when a
  device add-on expires; until then execution stays operator/flag-gated.
- Rollback: `ADDON_DEVICE_CLEANUP_AUTO=false` → reduction plans are built but not
  auto-executed (operator-driven).

## Rollback drill (any stage)

1. Set the offending stage's flag(s) to `false` and redeploy the env.
2. The legacy path resumes immediately for **new** operations.
3. The webhook reconciler keeps fulfilling already-admitted paid lines
   (fulfillment is idempotent, stamped on `transaction.fulfilledAt` /
   per-item `appliedAt` / `(sourceTransactionId, sourceLineKey)`), so no paid
   customer is stranded.
4. No destructive down-migration is required — the schema is additive and
   dormant when flags are OFF.

## Verification commands (gates)

- Backend: `npm run prisma:generate`, `npm run typecheck`, `npm run lint`,
  `npm run build`, and `npm test` with `TEST_DATABASE_URL` set to an ephemeral
  Postgres 17 (real-DB specs: cutover shadow-equality, concurrency races,
  boundary/expiry, renewal producer, ledger fulfillment).
- Reiwa: `npm run check`, `npm test`, `npm run test:pbt`, `npm run build`.
- Reiwa web / admin web: `npm run typecheck` / `npm run build`.

## Flag reference (`src/modules/add-on-entitlements/add-on-rollout.config.ts`)

| Stage | Env flag | Enables |
|---|---|---|
| 1 | `ADDON_ENTITLEMENT_SHADOW` | shadow projection (legacy authoritative) |
| 2 | `ADDON_ENTITLEMENT_DIRECT_PURCHASE` | direct add-on ledger commit |
| 3 | `ADDON_PROJECTION_SYNC` | versioned desired-state Remnawave writes |
| 4 | `ADDON_RESET_EXPIRY_{DAY,WEEK,MONTH,MONTH_ROLLING}` | commercial reset expiry (per strategy, post-parity) |
| 5 | `ADDON_RENEWAL_ADDONS` | renewal add-on composition + cabinet step |
| 6 | `ADDON_DEVICE_CLEANUP_AUTO` | automatic HWID reduction |
