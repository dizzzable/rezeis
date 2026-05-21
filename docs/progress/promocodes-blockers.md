# Promocodes Remaining Blockers

Updated on 2026-04-20 from current repository state.

## Purpose

This file exists to make the remaining promo-related blockers explicit inside the
repository, independent of any external orchestration state.

## Blocker 1 — Remaining Referral Exchange Gaps After `G1` First Slice

### Status

Partially resolved.

### Why

The first user-facing gift-promocode exchange slice and first operator referral
page now exist, but the referral vertical is not yet feature-complete:

- no referral history page in `ruid/web`
- no invite revoke UX in `ruid/web`
- no broader non-gift exchange types exposed yet (subscription days / discounts / traffic)
- no dedicated referral history UX yet in either admin or user web

### Consequence

Gift-promocode exchange is now available as a first practical slice, but the
overall referral program cannot be claimed fully shipped until the surrounding
history / operator / broader exchange surfaces exist.

### See also

- `docs/architecture/referral-bounded-context-minimum.md`
- `docs/architecture/referral-bounded-context-first-slice.md`
- `docs/architecture/service-boundaries.md`

## Blocker 2 — Promo In Quote / Payment Path (`G2`)

### Status

Blocked by product decision.

### Why

The shipped promo flow is intentionally separate from the quote/payment flow.
Merging promo input into quote/payment would change user and business behavior and
must therefore be an explicit business decision, not an inferred engineering step.

### See also

- `docs/architecture/altshop-business-logic-transfer.md`
- `docs/progress/decision-log.md`

## Blocker 3 — Plan Checkbox Drift

### Status

External bookkeeping mismatch.

### Why

The repository work materially exceeds the visible `.sisyphus/plans/*.md`
checkboxes in this session, but those files were treated as read-only / sacred
during execution.

### Consequence

Repo state and checkbox state may disagree even though implementation and tests are
green.

### See also

- `docs/progress/promocodes-status.md`
