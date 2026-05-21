# Referral exchange donor-parity plan

## Donor altshop semantics

`altshop` supports converting referral points into business value through `referral_exchange_execution.py`:

| Exchange type | Donor behavior | Side effects |
|---|---|---|
| `SUBSCRIPTION_DAYS` | Requires selected subscription. Calculates `days_to_add = effective_points / points_cost`. Extends from `max(subscription.expire_at, now)`. | Decrements user points; updates subscription expiration; syncs Remnawave user. |
| `GIFT_SUBSCRIPTION` | Requires configured/requested plan. Creates single-use promocode with subscription reward and plan snapshot. | Decrements user points; creates active one-time promocode. |
| `DISCOUNT` | Converts points into purchase discount percent, bounded by configured max. | Decrements user points; increases user purchase discount up to 100%. |
| `TRAFFIC` | Requires selected subscription. Converts points into extra traffic GB, bounded by configured max. | Decrements user points; updates subscription traffic limit; syncs Remnawave user. |

Global donor rules:
- exchange can be globally disabled;
- each exchange type can be disabled;
- min/max points and points-cost are configured per type;
- exchange mutates user points atomically with the reward side effect.

## Current Rezeis state

Rezeis Admin currently has:
- referral qualification after completed payment;
- referral rewards;
- automatic `POINTS` issue;
- manual non-POINTS issue;
- audit/UI visibility.

Missing donor parity:
- no referral points exchange catalog/policy;
- no points-to-days executor;
- no points-to-traffic executor;
- no points-to-discount executor;
- no points-to-gift-promocode executor.

## Implementation plan

### Phase 1 — read-only exchange policy/readiness
- Backend endpoint returns supported exchange types, mutation status, required controls, and what is implemented.
- Web referrals page shows policy to operators.
- No mutation.

### Phase 2 — `SUBSCRIPTION_DAYS` executor
- Requires userId, subscriptionId, requested points.
- Validates points balance and selected subscription.
- Calculates days from points-cost.
- Decrements user points and updates subscription expiration in one transaction.
- Syncs Remnawave `expireAt` before local commit when provider link exists.
- Writes audit.

### Phase 3 — `TRAFFIC` executor
- Requires selected subscription and requested points.
- Converts points to extra GB.
- Updates traffic limit and syncs Remnawave.
- Writes audit.

### Phase 4 — `DISCOUNT` executor
- Adds bounded purchase discount to user profile.
- Writes audit.

### Phase 5 — `GIFT_SUBSCRIPTION` executor
- Creates single-use subscription promocode with plan snapshot.
- Writes audit.

## Safety rules
- Never spend points unless reward side effect succeeds.
- Provider sync before local subscription update for subscription/traffic rewards.
- Bounded API responses; no raw provider payload.
- Every executor must have service tests and web smoke if exposed in UI.
