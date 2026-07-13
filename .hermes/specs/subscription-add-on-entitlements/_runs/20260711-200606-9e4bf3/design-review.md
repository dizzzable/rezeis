# Design Review

```yaml
run_id: 20260711-200606-9e4bf3
status: passed
```

## Gate checks

- [x] Every must requirement has a feasible component/data/contract path.
- [x] Commercial truth, desired projection and observed upstream state have distinct owners.
- [x] Payment and entitlement state transitions/idempotency are explicit.
- [x] Remnawave 2.7.4/2.8.0 compatibility and strict failure outcomes are explicit.
- [x] External calls are outside DB transactions; durable work/recovery is specified.
- [x] Concurrency ordering, DELETE priority and stale-job behavior are specified.
- [x] Destructive HWID workflow has validation, persisted plan, exact delete and read-back.
- [x] Auth, RBAC, audit, PII redaction, rate limits and threat model are covered.
- [x] Rezeis↔Reiwa producer/consumer deployment compatibility is covered.
- [x] Migration, shadow equality, feature flags, rollback and paid-line recovery are covered.
- [x] Unit/integration/contract/concurrency/failure/E2E/accessibility verification is defined.

## Review findings resolved

1. **Calendar semantics:** not guessed; per-strategy capability remains disabled until parity fixtures pass.
2. **Legacy effects:** no historical subtraction; cutover baseline preserves current value.
3. **Partial device cleanup:** retries persisted targets and checks current overage before each delete.
4. **Rollback:** admission can stop, but workers for already-paid lines remain available.
5. **Old consumers:** compatibility effective columns and additive DTO rollout remain during migration.

## Result

- Unresolved blocker/major: none.
- Residual bounded assumption: staging parity of reset strategies.
- Next artifact allowed: `tasks.md`.
- Implementation approval: not granted.
