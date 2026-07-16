# Аудит: продление подписки до webhook SUCCESS

**Дата:** 2026-07-17  
**Область:** `payments-renewal-checkout` · `payment-reconciliation` · `auto-renew` · `payment-subscription-mutation` · `payment-provider-execution`  
**Требование:** подписка не должна продлеваться/выдаваться до успешного payment callback (webhook SUCCESS).  
**Живое подтверждение:** payment `cmrnn4cv7006801jgqlwrzgr1` — fulfill только после webhook.

## Вердикт

| | |
|---|---|
| **Gap (paid path → extend до webhook)?** | **НЕТ** |
| Production-hardening (guards)? | Не требуется |
| Изменения | Только clarifying-комментарии |

---

## Инвариант

Единственное место, которое пишет `subscription.expiresAt` для `RENEW`:

- `PaymentSubscriptionMutationService.applyCompletedTransaction`
  - combined renewal → `applyCombinedRenewal` → `expiresAt: calculateExpiry(...)`
  - single RENEW → `renewSubscriptionFromPayment` → то же

Вызов `applyCompletedTransaction` на **платном** renewal-пути допускается **только** после того, как reconciler перевёл статус в `COMPLETED` по SUCCESS webhook (claim `fulfilledAt`).

---

## Call sites `applyCompletedTransaction` (production)

| # | Файл | Условие входа | Paid money без webhook? | Продлевает RENEW? |
|---|------|---------------|-------------------------|-------------------|
| 1 | `payment-reconciliation.service.ts` | `nextStatus === COMPLETED` после map SUCCESS webhook + atomic claim `fulfilledAt: null → now` | **Нет** — это и есть webhook SUCCESS path | Да (после SUCCESS) |
| 2 | `payments-renewal-checkout.service.ts` | `Number(transaction.amount) <= 0` | **Нет** — money path (amount > 0) не заходит | Да, но **zero-total only** (нет реального платежа) |
| 3 | `payments-checkout.service.ts` | `Number(transaction.amount) <= 0` | **Нет** — zero-total NEW/ADDITIONAL/UPGRADE | Да для plan-типов, zero-total only |
| 4 | `addon-purchase.service.ts` | `Number(snapshot.price) <= 0` | **Нет** — free add-on | Нет (add-on limits, не RENEW expiresAt) |
| 5 | `partner-balance-payment.service.ts` | После atomic debit partner balance | **Нет webhook** — но оплата = debit баланса партнёра (не provider money) | Да (RENEW/NEW/…), осознанный non-webhook settlement |
| 6 | `add-on-fulfillment-recovery.service.ts` | Cron: уже `status === COMPLETED` + `fulfilledAt === null` | **Нет** — recovery после capture; COMPLETED уже выставлен webhook/zero/partner path | Только re-apply add-on; не создаёт COMPLETED |

Тесты (`test/**`) вызывают mutation напрямую — вне production path.

---

## Поток: paid renewal checkout

```
renewalCheckout(amount > 0)
  → create/reuse PENDING draft
  → claim gatewayId = __RENEWAL_PROVIDER_CREATE__:{paymentId}
  → paymentProviderExecutionService.createCheckout(...)
       • REDIRECT: checkoutUrl set, status stays PENDING
       • IMMEDIATE (off-session, checkoutUrl null): gatewayId + gatewayData only;
         providerStatus may be "succeeded" в gatewayData — status остаётся PENDING
  → return mapCheckoutResponse (PENDING)
  → ❌ applyCompletedTransaction НЕ вызывается

webhook SUCCESS
  → PaymentReconciliationService.reconcileWebhookEvent
  → status = COMPLETED
  → claim fulfilledAt
  → applyCompletedTransaction → expiresAt extended
```

### `failClaimedProviderCreation`

При ошибке createCheckout: `PENDING + claim` → `FAILED`, `gatewayId = null`.  
Fulfillment не запускается. Autopay может ретраить / expire.

### Zero-total

`amount <= 0`: нет provider charge; COMPLETED + fulfill сразу — **осознанное** исключение (нет money to capture).

---

## `payment-provider-execution` (IMMEDIATE)

YooKassa off-session (`payment_method_id`):

- `providerMode = checkoutUrl !== null ? 'REDIRECT' : 'IMMEDIATE'`
- Возвращает `gatewayId`, `providerStatus`, **не** меняет `Transaction.status`
- **Не** вызывает mutation / fulfill

Checkout-сервисы пишут только `gatewayId` / `gatewayData` / `checkoutUrl`, оставляя `PENDING`.

---

## `auto-renew.service`

| Действие | Пишет `expiresAt`? | Fulfill? |
|----------|--------------------|----------|
| `processAutopayCharges` → `renewalCheckout` | Нет | Нет (делегирует checkout) |
| Считает `COMPLETED` как success | Нет | Нет — только счётчик/лог |
| `markExpiredSubscriptions` | Нет (`status → EXPIRED` only) | Нет |
| `readAttemptState` | Нет | COMPLETED = skip expire; PENDING+null checkoutUrl = wait settle |

Единственная subscription write: `status: EXPIRED` (updateMany).  
Продление paid autopay = webhook → reconciler → mutation (как у manual renew).

---

## `payment-reconciliation` — SUCCESS → apply

1. Map provider status → `COMPLETED` только для SUCCESS-подобных (`SUCCEEDED`, `SUCCESS`, `PAID`, …).
2. Update transaction status.
3. Atomic claim: `updateMany where fulfilledAt: null`.
4. Только winner (`count === 1`) → `applyCompletedTransaction`.
5. Provision failure → release claim (`fulfilledAt → null`) для retry.
6. Late SUCCESS на CANCELED/FAILED → revive + fulfill (money not lost).

Нет ветки: «provider create status alone → COMPLETED».

---

## Риски, проверенные и отвергнутые

| Гипотеза | Результат |
|----------|-----------|
| IMMEDIATE + providerStatus=succeeded → fulfill в create path | **Нет** — status PENDING, mutation не вызывается |
| Autopay `succeeded++` при COMPLETED zero-total / replay | Счётчик only; extend только если mutation уже отработала (zero) или webhook |
| Concurrent claim на provider create → double fulfill | Claim на create; fail → FAILED; fulfill только reconciler claim |
| Partner balance / zero-total «обходят» webhook | Да, by design; не paid-provider path |

---

## Изменения по итогам аудита

**Gap: no** — production guards не добавлялись.

Clarifying comments only:

1. `payments-renewal-checkout.service.ts` — zero-total: paid money never fulfills here.  
2. `payments-renewal-checkout.service.ts` — post-createCheckout: persist ids only; IMMEDIATE still waits webhook.  
3. `auto-renew.service.ts` — header: never writes `expiresAt`; COMPLETED = accounting only.

---

## Рекомендации (не сделано — out of scope)

- Опционально: assertion в mutation «refuse if status !== COMPLETED» — defensive, не закрывает реальный gap (callers уже COMPLETED / zero-path).
- Partner-balance: отдельный audit, если нужен единый «settlement authority» policy.
