# Adversarial Critic Research

```yaml
created_at: 2026-07-11T20:18:53+03:00
workflow: requirements-first
status: complete
spec_version: 1
```

## Blockers found and disposition

| Risk | Severity | Required disposition |
|---|---|---|
| Baseline/effective conflation | blocker | separate term baseline, ledger, projection, observed upstream |
| Renewal/upgrade overwrite | blocker | atomic term transition and scheduled new-term entitlements |
| Upstream reverse write-back | blocker | observed state only; no commercial mutation |
| Stale absolute sync | blocker | monotonic desired revision + per-subscription serialization/coalescing |
| Captured payment without service | blocker | explicit paid/committed/pending/applied/remediation states and sweeper |
| Generic reset as expiry | blocker | local cycle epoch; scheduler authority; webhook only acceleration |
| Unlimited device arithmetic | blocker | canonical unlimited representation and backend fail-closed checks |
| Unsafe HWID automation | blocker | strict adapter, immutable plan, exact delete, read-back saga |

## Major scenarios included in requirements/design

- request/provider/webhook/fulfillment idempotency as four distinct layers;
- zero-price crash recovery;
- plan/status/unlimited changes between checkout and capture;
- early renewal scheduled activation;
- subscription deletion and upgrade races;
- catalog archive and immutable purchase snapshots;
- refund/chargeback operator remediation for v1;
- PII-safe HWID handling and RBAC/audit;
- gateway-specific price and lifetime review UI;
- accessibility, offline/error states and delayed activation status;
- migration dry-run, shadow projection, rollback and legacy grandfathering;
- contract, property, concurrency, destructive-failure and E2E tests.

## Rejected unsafe shortcuts

- Add `lifetime` to catalog and subtract value in cron.
- Infer expiry from `lastTrafficResetAt > activatedAt`.
- Recompute baseline by subtracting historical transaction values.
- Treat 2xx PATCH/delete as verified success.
- Reuse pending renewal drafts based only on amount/subscription IDs.
- Automatically revoke fulfilled value on refund without payment-state redesign.

## Open but bounded

Calendar parity is the only remaining external unknown. It does not block the architecture: the rollout gate remains closed per reset strategy until fixtures are verified.
