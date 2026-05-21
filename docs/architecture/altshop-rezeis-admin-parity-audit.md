# Altshop donor vs Rezeis Admin parity audit

This document is a live-code audit artifact. It compares donor `altshop-1.5.0` admin/business capabilities with the current `rezeis-admin` panel. Scope is the admin/control-plane side only; `ruid` is intentionally out of scope until the panel business logic is solid.

## Audit sources

### Donor altshop
- `src/bot/routers/dashboard/*`: admin bot dashboard modules for users, broadcast, backup, imports, promocodes, Remnawave, statistics, access.
- `src/services/*`: business services for purchases, subscriptions, Remnawave sync/events, payment gateways, promocodes, referrals, partners, backup/import/broadcast, notifications, market quotes, access policy.
- `src/tasks/*`: async payment/referral/profile workflows.
- `src/api/endpoints/*`: user portal, payments, Remnawave, analytics, Telegram/auth/account endpoints.

### Rezeis Admin
- Backend: `rezeis-admin/src/modules/*`.
- Web panel: `rezeis-admin/web/src/features/*`.
- Architecture/backlog docs in `rezeis/docs/architecture/*`.

## Parity matrix

| Business area | Altshop donor capability | Rezeis Admin current capability | Parity | Remaining gaps / next work |
|---|---|---|---:|---|
| Admin dashboard/statistics | Bot dashboard, statistics views, operations summaries | Web dashboard with user/payment/import/broadcast/finance timelines and filters | High | deeper analytics/segmentation can improve later |
| Users search/profile | Search user, profile, transactions, subscriptions, mutations | Rich users cockpit: search, multi-subscription workbench, risk markers, selected subscription actions | High | user lifecycle disable/delete policy if needed |
| Subscription execution | Create/update/delete Remnawave profile, renew, extend, upgrade, reset traffic, status changes, fallback current subscription | Remnawave create/update/delete/reset adapters; profile sync jobs; LIMIT_CHANGE/RENEW/EXTEND/TRAFFIC_RESET/PLAN_ASSIGNMENT/STATUS_TOGGLE; provider response fidelity; fallback visibility | High | broader rollback/compensation policy; default reset-traffic operator policy |
| Payment → subscription orchestration | Completed payment triggers subscription mutation, profile sync, referral side effects, notification | Payment reconciliation applies completed transaction, qualifies referrals, auto-enqueues profile sync jobs into BullMQ, processes bounded sync batch, sends notification | High | permanently failed sync compensation expansion |
| Profile sync compensation | Donor has operational Remnawave sync services/tasks | Rezeis has retry/backoff, problem jobs, reset retry, compensation notes, force provider link | High | force-link audit hardening/approval request if required |
| Payment gateways | Gateway catalog/runtime/webhooks; Platega recovery; multiple providers | Gateway ops, webhook inbox/reconciliation, YooKassa+Heleket refunds, Platega/MulenPay audit blocked pending exact contracts | Medium/High | Platega/MulenPay refund exact HTTP contract verification |
| Refunds/corrections/disputes | Payment lifecycle and recovery flows | Refund readiness/request/history/preflight/execution/history; correction notes/requests/ADJUST_AMOUNT; dispute/reconciliation records | High | MARK_COMPLETED correction executor remains intentionally blocked |
| Promocodes | Lifecycle, validation, rewards, portal | CRUD, validation, rewards, activation/usage, smoke/tests | High | advanced donor-specific promo analytics if needed |
| Referrals/rewards | Invite/referral qualification, rewards/exchange, partner/referral portal | Payment-triggered qualification, rewards, POINTS auto-issued, non-POINTS manual issue, audit/UI | Medium/High | referral exchange/cashout flows if donor semantics require them |
| Partners/withdrawals | Partner portal, earnings, withdrawals with balance reservation | Partner summary/earnings/withdrawals, donor-style reserve/refund/no double deduction, audit/UI | High | payout provider integration if needed |
| Broadcast/notifications | Broadcast campaigns, notification delivery/scheduling | Broadcast draft/audience/readiness/runs/send/delete/retry/cancel; notification toggles/templates/preview; BullMQ notification queue; manual single/batch bot delivery; problem event re-enqueue | High | scheduled/background broadcast worker and rich media/buttons |
| Importer | Import staging, commit, rollback | Import dry-run/staging/commit/rollback and UI | High | broader import formats if donor has extra |
| Backup/restore | Backup creation/delivery/registry/restore/panel recovery | Backup manifest/export/download/audit, restore policy/dry-run/history/readiness/gate | Medium | restore commit and broader restore domains |
| Remnawave ops/events | Client health/raw, node/events/device, profile lifecycle | Remnawave health/config, subscription profile sync, device actions, provider adapters | Medium/High | Remnawave node/event analytics if donor dashboard depends on it |
| Settings/access/RBAC | Access policy, web cabinet admin, auth/recovery | Settings, API tokens, governance/RBAC, role/active-state/token revoke lifecycle | High | fine-grained permission storage/executor if needed |
| Notifications/email/Telegram | Notification entrypoints/scheduling/translation/email sender | Notification module, payment notifications, broadcast; Telegram user side deferred | Medium | user-facing ruid/bot notification integration later |
| Market/pricing/quotes | Market quote sources/values/conversions | Subscription quote page and plan/product catalog | Medium | market quote donor parity if multi-currency/source logic is required |

## Highest-impact remaining business blocks

1. **Referral exchange / cash-out donor parity** — donor has explicit referral exchange services; Rezeis currently covers qualification/rewards/manual issue, but exchange semantics need deeper audit.
2. **Remnawave node/event analytics** — donor has Remnawave event/device/node services; Rezeis has lifecycle operations but may lack operational analytics.
3. **Backup restore commit** — Rezeis has strong restore dry-run gates but no commit executor.
4. **Broadcast scheduled/background worker** — manual lifecycle shipped; scheduling worker/rich content pending.
5. **Platega/MulenPay refunds** — blocked until exact provider contracts are proven.

## Rule for next implementation blocks

Every next block must follow this sequence:
1. donor live-code audit for the exact capability;
2. current Rezeis live-code audit;
3. external provider/docs/OpenAPI audit when applicable;
4. detailed plan and safety boundaries;
5. implementation;
6. targeted backend tests + web smoke/build when UI changes.
