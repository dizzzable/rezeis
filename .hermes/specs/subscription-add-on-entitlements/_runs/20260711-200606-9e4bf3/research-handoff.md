# Research Handoff

```yaml
run_id: 20260711-200606-9e4bf3
feature_slug: subscription-add-on-entitlements
status: passed
```

## Verified findings

- **CODE-001 — No lifecycle ledger.** Current Add-on fulfillment increments `Subscription.trafficLimit` or `deviceLimit` directly and stamps the source transaction; no entitlement state, activation or expiry exists. Evidence: `rezeis-admin/src/modules/payments/services/payment-subscription-mutation.service.ts:237-307`, `rezeis-admin/prisma/schema.prisma:1158-1227`.
- **CODE-002 — Baseline/effective conflation.** Renewal, upgrade and admin assignment overwrite the same limit columns that Add-ons increment. Evidence: mutation service lines `155-188`, `420-493`; admin assignment controller; bulk assignment service.
- **CODE-003 — Paid-but-undelivered recovery gap.** A transaction can become `COMPLETED` before fulfillment/provisioning succeeds, while reconciliation returns early for already-completed transactions. Zero-price Add-ons have no provider webhook recovery. Evidence: `payment-reconciliation.service.ts:46-119`; `addon-purchase.service.ts:210-241`.
- **CODE-004 — Checkout idempotency is incomplete.** Add-on checkout creates a new transaction per request and lacks a canonical request/provider key. Evidence: `addon-purchase.service.ts:178-259`.
- **CODE-005 — Unlimited-device sibling bug.** Local unlimited devices use a negative sentinel and map to upstream zero; checkout does not select/check device limit, fulfillment increments the sentinel, and Reiwa hides only unlimited traffic options. Evidence: `addon-purchase.service.ts:120-160`; mutation service `267-283`; profile sync `329-343`; `reiwa/web/src/features/addons/addons-page.tsx:157-180`.
- **CODE-006 — Sync is not convergent for every paid update.** Jobs use absolute PATCH values without per-subscription desired revision; failed UPDATE jobs are not automatically recovered like CREATE. Evidence: profile-sync queue service and processor.
- **CODE-007 — Upstream write-back threatens source-of-truth.** Remnawave webhook paths can copy effective limits into local subscription fields; this cannot remain baseline authority after entitlements exist. Evidence: `remnawave-webhook.service.ts:262-279`.
- **CONTRACT-001 — Stable Remnawave operations.** 2.7.4 and 2.8.0 both support `GET /api/users/{uuid}`, `PATCH /api/users`, `GET /api/hwid/devices/{userUuid}`, exact `POST /api/hwid/devices/delete`, and `{response: ...}` envelopes. Evidence: supplied OpenAPI files under `rezeis/icon/`.
- **CONTRACT-002 — HWID row drift.** 2.7.4 exposes `userUuid`; 2.8.0 exposes numeric `userId` plus `requestIp`; stable cleanup fields are `hwid`, `createdAt`, `updatedAt`. Evidence: supplied OpenAPI schemas.
- **CONTRACT-003 — No future reset boundary.** Both versions expose `lastTrafficResetAt` and reset strategies but no `nextTrafficResetAt` or complete calendar formula. Generic `user.traffic_reset` exists in both. Evidence: supplied OpenAPI files and ad-hoc extractor verification.
- **CONTRACT-004 — Current reads are unsafe for deletion.** Device/user helpers collapse upstream failures into empty/null values. Evidence: `remnawave-api.service.ts:343-358,512-566`.
- **CONTRACT-005 — Reiwa contract is incomplete.** Catalog/checkout types have no lifetime, term, entitlement state or projection status; catalog outage is masked as empty list. Evidence: `reiwa/src/infrastructure/admin-client/namespaces/add-ons.ts`; `src/api/routes/content.ts`; SPA content client.
- **MIG-001 — Historical lifetime cannot be inferred.** Old snapshots omit lifetime/expiry and live limits can include promos/referrals/admin changes. Historical paid effects cannot be safely subtracted. Evidence: transaction snapshots, rewards services, schema.
- **OPS-001 — Refund clawback is not a small extension.** Completed payments are terminal to current reconciliation; post-completion refund/chargeback does not automatically revoke provisioned value. Evidence: reconciliation service and gateway normalizers.
- **SCOPE-001 — `rezeis-subpage` is not implicated.** No relevant catalog, checkout, limit, HWID or expiry consumer was found; it remains out of scope unless user-facing subscription-page metadata is separately requested.

## Inferred target constraints

- **INF-001:** Rezeis must own four separate layers: commercial term baseline, immutable entitlement ledger, versioned desired projection, observed upstream state.
- **INF-002:** A local planned reset epoch/boundary is mandatory; early/manual resets never close it.
- **INF-003:** Early renewal Add-ons remain scheduled until the next term starts.
- **INF-004:** Device reduction requires an immutable, deterministic exact-HWID removal plan and strict read-back saga.
- **INF-005:** Historical effective limits become grandfathered baseline at cutover; lifecycle applies only to post-cutover purchases.

## Product decisions applied

1. Catalog options have lifetime `UNTIL_NEXT_RESET` or `UNTIL_SUBSCRIPTION_END`; default is `UNTIL_NEXT_RESET`.
2. Purchases are one-time, stackable, bound to one subscription, never auto-recurring.
3. Renewal may offer Add-ons again only by explicit selection.
4. Early/manual traffic reset clears usage only and does not expire entitlement.
5. Both lifetime policies are term-scoped: no one-time Add-on survives into an unselected subsequent service term.
6. First release does not auto-clawback fulfilled Add-ons on post-completion refund/chargeback; it creates operator remediation/audit state.

## Resolved conflicts

- **Legacy backfill:** rejected subtract-and-rebuild; grandfather current local limits as cutover baseline.
- **Reset source:** rejected generic webhook as authority; local scheduler owns the boundary, webhook accelerates reconcile only.
- **Unlimited arithmetic:** canonical domain helpers must normalize sentinels before any addition.
- **HWID ordering:** use validated `createdAt DESC`, then canonical `hwid DESC`; never UI order, name, last seen or IP.
- **Catalog delete:** referenced options must be archived/deactivated, not physically removed.

## Remaining bounded unknowns

- Exact Remnawave calendar parity for `DAY/WEEK/MONTH/MONTH_ROLLING` is undocumented. Design must use explicit local UTC cycle-policy fixtures and keep each strategy fail-closed until parity is verified in staging; `NO_RESET + UNTIL_NEXT_RESET` is ineligible.
- Production data distribution is not inspected. Migration requires dry-run counts and no upstream writes during backfill.

## Coverage limits

No real payment provider, production database, Remnawave panel or webhook endpoint was mutated. Full repository suites were not run by the parent. One child ran five focused existing Rezeis test files: 36 passed, 0 failed; this verifies current baseline paths, not the future feature.

## Source reports

- Lane 1: `subagent-summary-0-20260711_201853_211900.txt`
- Lane 2: `subagent-summary-1-20260711_201853_212903.txt`
- Lane 3: `subagent-summary-2-20260711_201853_212903.txt`
- Parent evidence: `parent-findings.md`, `openapi-274.txt`, `openapi-280.txt`
