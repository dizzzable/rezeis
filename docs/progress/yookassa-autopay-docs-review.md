# Документальное ревью YooKassa autopay — PR #33

> **Статус (обновлено 2026-07-21):** код **выпущен** в rezeis **v0.9.6.57** (+ follow-up: lease-fenced claim, per-request `savePaymentMethod` + consent UI в кабинете). Staging matrix у провайдера — ops checklist. Dual path: live money = `PaymentProviderExecutionService`; `YookassaAdapter` помечен legacy.

Проверены commit `4c9e939` (PR #33; merge `c85e4a5`) и последующие harden на main.

## A. Факты из документации

- Автоплатёж требует согласия пользователя на привязку; магазин обязан определить условия, периодичность/сумму и отключение. Для боевого магазина нужна предварительная настройка YooKassa через менеджера. Источник: [Основы автоплатежей](https://yookassa.ru/developers/payment-acceptance/scenario-extensions/recurring-payments/basics).
- Для безусловного сохранения при первичном платеже нужен `save_payment_method: true`; до него магазин информирует пользователя и получает согласие. Источник: [Привязка во время платежа](https://yookassa.ru/developers/payment-acceptance/scenario-extensions/recurring-payments/save-payment-method/save-during-payment).
- После успешной привязки следует сохранять `payment_method.id` вместе с пользователем; пригоден метод с `payment_method.saved: true`. Источник: [Привязка во время платежа](https://yookassa.ru/developers/payment-acceptance/scenario-extensions/recurring-payments/save-payment-method/save-during-payment).
- Автоплатёж создаётся с `amount`, `description`, `capture: true`, `payment_method_id`; по инструкции не требует дополнительного подтверждения. Источник: [Проведение автоплатежа](https://yookassa.ru/developers/payment-acceptance/scenario-extensions/recurring-payments/pay-with-saved).
- Off-session payment может вернуться `pending`; итог надо получить webhook либо периодическим запросом Payment. Источник: [Проведение автоплатежа](https://yookassa.ru/developers/payment-acceptance/scenario-extensions/recurring-payments/pay-with-saved).
- `canceled` окончателен. `permission_revoked` означает отзыв разрешения на автоплатежи; следующая оплата требует нового платежа и подтверждения пользователя. Источник: [Неуспешные платежи](https://yookassa.ru/developers/payment-acceptance/after-the-payment/declined-payments).
- Webhook нужно подтверждать и проверять по актуальному статусу объекта либо IP; официальный список IP совпадает с CIDR normalizer. События включают `payment.succeeded`, `payment.canceled`, `payment.waiting_for_capture`; Basic Auth webhook URL настраивается в ЛК и требует HTTPS:443/8443, TLS >= 1.2. Источник: [Входящие уведомления](https://yookassa.ru/developers/using-api/webhooks).
- API: `https://api.yookassa.ru/v3/`, Basic Auth `shopId:secretKey`. `Idempotence-Key` нужен для POST/DELETE, max 64; повтор с теми же key+данными возвращает первый результат 24 часа. После HTTP 500 надо сначала узнать результат операции. Источник: [Формат взаимодействия](https://yookassa.ru/developers/using-api/interaction-format), [справочник API](https://yookassa.ru/developers/api).
- [Главная документации](https://yookassa.ru/developers) подтверждает API-приём платежей; [английский recurring URL](https://yookassa.ru/en/developers/payments/recurring-payments) при проверке редиректил на официальную русскую страницу.

## B. Что PR #33 реализует корректно

- [`payment-provider-execution.service.ts:127`](../../rezeis-admin/src/modules/payments/services/payment-provider-execution.service.ts:127), [`:145`](../../rezeis-admin/src/modules/payments/services/payment-provider-execution.service.ts:145), [`:159`](../../rezeis-admin/src/modules/payments/services/payment-provider-execution.service.ts:159): отправляются `payment_method_id`, `capture: true`, описание, сумма и стабильный `Idempotence-Key` — это документированный request shape автоплатежа.
- [`payment-provider-execution.service.ts:120`](../../rezeis-admin/src/modules/payments/services/payment-provider-execution.service.ts:120): интерактивная оплата запрашивает `save_payment_method`, а off-session charge не запрашивает повторное сохранение.
- [`payment-provider-execution.helpers.ts:62`](../../rezeis-admin/src/modules/payments/services/payment-provider-execution.helpers.ts:62), [`payment-gateway-settings.util.ts:261`](../../rezeis-admin/src/modules/payments/utils/payment-gateway-settings.util.ts:261): принимаются panel alias `apiKey` и документированное `secretKey`.
- [`saved-payment-method.service.ts:337`](../../rezeis-admin/src/modules/payments/services/saved-payment-method.service.ts:337), [`:382`](../../rezeis-admin/src/modules/payments/services/saved-payment-method.service.ts:382): сохраняются только `saved=true` методы, с user binding; запрещён cross-user rebind.
- [`payment-webhook-normalizer.service.ts:19`](../../rezeis-admin/src/modules/payments/services/payment-webhook-normalizer.service.ts:19), [`:96`](../../rezeis-admin/src/modules/payments/services/payment-webhook-normalizer.service.ts:96): официальный YooKassa IP allowlist реализован точно.
- [`auto-renew.service.ts:133`](../../rezeis-admin/src/modules/auto-renew/auto-renew.service.ts:133): PR перестал сжигать PENDING redirect/3DS попытку до возможного позднего success webhook.

## C. Пробелы, ошибки и незавершённое

### P0

1. [`payments-checkout.service.ts:202`](../../rezeis-admin/src/modules/payments/services/payments-checkout.service.ts:202), [`payments-renewal-checkout.service.ts:395`](../../rezeis-admin/src/modules/payments/services/payments-renewal-checkout.service.ts:395) — race create-response `succeeded` против `payment.succeeded` webhook.

   - Требование: YooKassa шлёт `payment.succeeded`, а off-session create может вернуть `succeeded`. Источники: [webhooks](https://yookassa.ru/developers/using-api/webhooks), [pay-with-saved](https://yookassa.ru/developers/payment-acceptance/scenario-extensions/recurring-payments/pay-with-saved).
   - Риск: checkout «claim» меняет только `status` и оставляет `fulfilledAt=null`. Reconciler для `COMPLETED + fulfilledAt=null` ставит `fulfilledAt` и параллельно вызывает provision ([`payment-reconciliation.service.ts:54`](../../rezeis-admin/src/modules/payments/services/payment-reconciliation.service.ts:54), [`:104`](../../rezeis-admin/src/modules/payments/services/payment-reconciliation.service.ts:104)). Checkout также вызывает mutation без владения `fulfilledAt`; NEW сначала создаёт subscription, stamp делает позднее ([`payment-subscription-mutation.service.ts:669`](../../rezeis-admin/src/modules/payments/services/payment-subscription-mutation.service.ts:669), [`:711`](../../rezeis-admin/src/modules/payments/services/payment-subscription-mutation.service.ts:711)). Возможны двойные подписка/продление, entitlement и sync-job.
   - Рекомендация: один атомарный fulfilment claim/release на `fulfilledAt`, общий для webhook и обеих immediate веток; детерминированные interleaving tests create-response ↔ webhook.

2. [`payment-provider-execution.service.ts:189`](../../rezeis-admin/src/modules/payments/services/payment-provider-execution.service.ts:189), [`payments-renewal-checkout.service.ts:372`](../../rezeis-admin/src/modules/payments/services/payments-renewal-checkout.service.ts:372), [`auto-renew.service.ts:450`](../../rezeis-admin/src/modules/auto-renew/auto-renew.service.ts:450) — 2xx `canceled` после provider submission остаётся вечным local `PENDING` claim.

   - Требование: `canceled` final; `permission_revoked` требует нового user-confirmed платежа. Источник: [Неуспешные платежи](https://yookassa.ru/developers/payment-acceptance/after-the-payment/declined-payments).
   - Риск: response содержит provider id и `canceled`, но execution бросает exception до structured result. Renewal считает отправку неоднозначной и не снимает claim; любая PENDING строка блокирует expiry epoch. provider id/reason не сохранены, polling невозможен.
   - Рекомендация: обработать документированный 2xx canceled как terminal result: сохранить id/status/`cancellation_details`, перевести local transaction в CANCELED; для `permission_revoked` выключить saved method и начать отдельный user-confirmed flow. Тесты: canceled, permission_revoked, cron retry, отсутствие hanging claim.

### P1

1. [`auto-renew.service.ts:133`](../../rezeis-admin/src/modules/auto-renew/auto-renew.service.ts:133), [`:268`](../../rezeis-admin/src/modules/auto-renew/auto-renew.service.ts:268), [`payment-pending-expiry.service.ts:16`](../../rezeis-admin/src/modules/payments/services/payment-pending-expiry.service.ts:16) — жизненный цикл pending/redirect/3DS не завершён.

   - Требование: saved-method charge не должен требовать user confirmation; при pending итог получают webhook либо GET. Источник: [Проведение автоплатежа](https://yookassa.ru/developers/payment-acceptance/scenario-extensions/recurring-payments/pay-with-saved).
   - Риск: URL только логируется, пользователю не доставляется; pending блокирует retry, затем 30-минутный sweep отменяет локально без сверки provider status.
   - Рекомендация: зафиксировать policy: не создавать redirect для ordinary off-session; если confirmation URL всё же есть — безопасно доставлять пользователю и отслеживать completion. Перед local expiry делать GET Payment.

2. [`yookassa.adapter.ts:150`](../../rezeis-admin/src/modules/payments/gateways/adapters/yookassa.adapter.ts:150), [`payment-provider-execution.service.ts:104`](../../rezeis-admin/src/modules/payments/services/payment-provider-execution.service.ts:104) — нет polling в фактическом execution path.

   - Требование: pending можно завершать polling; после HTTP 500 сначала узнать result. Источники: [pay-with-saved](https://yookassa.ru/developers/payment-acceptance/scenario-extensions/recurring-payments/pay-with-saved), [interaction-format](https://yookassa.ru/developers/using-api/interaction-format).
   - Риск: `checkPaymentStatus()` adapter не имеет caller; missed webhook/500/pending переходят в local cancellation.
   - Рекомендация: canonical client с GET `/payments/{id}`, bounded backoff для PENDING/ambiguous create; сверять id, amount, currency, terminal status.

3. [`payment-reconciliation.service.ts:231`](../../rezeis-admin/src/modules/payments/services/payment-reconciliation.service.ts:231), [`saved-payment-method.service.ts:321`](../../rezeis-admin/src/modules/payments/services/saved-payment-method.service.ts:321) — `permission_revoked` не выключает method.

   - Требование: пользователь отозвал permission, следующий платёж требует confirmation. Источник: [Неуспешные платежи](https://yookassa.ru/developers/payment-acceptance/after-the-payment/declined-payments).
   - Риск: normalizer/reconciler не читают `cancellation_details.reason`; revoked id остаётся preferred и повторно выбирается.
   - Рекомендация: обработать reason из trusted payment object, `autopayEnabled=false`/deactivate, audit event, новый явный checkout; webhook canceled test.

4. [`payment-provider-execution.service.ts:154`](../../rezeis-admin/src/modules/payments/services/payment-provider-execution.service.ts:154), [`saved-payment-method.service.ts:337`](../../rezeis-admin/src/modules/payments/services/saved-payment-method.service.ts:337) — в scope нет durable consent evidence.

   - Требование: информирование, согласие, условия и отключение до `save_payment_method`. Источники: [Основы](https://yookassa.ru/developers/payment-acceptance/scenario-extensions/recurring-payments/basics), [Привязка](https://yookassa.ru/developers/payment-acceptance/scenario-extensions/recurring-payments/save-payment-method/save-during-payment).
   - Риск: default включён, но в reviewed scope нет consent/version/timestamp/offer correlation.
   - Рекомендация: подтвердить UI/offer flow до production и сохранять consent audit; не включать autopay legacy methods без policy.

### P2

1. [`yookassa.adapter.ts:32`](../../rezeis-admin/src/modules/payments/gateways/adapters/yookassa.adapter.ts:32), [`payment-provider-execution.service.ts:104`](../../rezeis-admin/src/modules/payments/services/payment-provider-execution.service.ts:104) — два расходящихся пути YooKassa.

   - Риск: adapter не вызывается checkout-path; он RUB-only, с receipt/customerEmail, иными metadata/secret preference и неиспользуемым GET status. Execution service отличается по contract. Тест execution не доказывает adapter и наоборот.
   - Рекомендация: удалить adapter после runtime подтверждения либо сделать canonical client с contract tests.

2. [`payments-checkout.service.ts:199`](../../rezeis-admin/src/modules/payments/services/payments-checkout.service.ts:199), [`payments-renewal-checkout.service.ts:383`](../../rezeis-admin/src/modules/payments/services/payments-renewal-checkout.service.ts:383) — immediate success не сохраняет reusable method без webhook.

   - Риск: `payment_method.saved=true` присутствует в create response, но `upsertFromYookassaPayment()` вызывается только reconciler webhook ([`payment-reconciliation.service.ts:96`](../../rezeis-admin/src/modules/payments/services/payment-reconciliation.service.ts:96)). Потерянный webhook лишит магазин local binding.
   - Рекомендация: общий idempotent post-success workflow после trusted response; test immediate success без webhook.

## D. Риск двух путей: `YookassaAdapter` vs `PaymentProviderExecutionService`

Фактический checkout использует `PaymentProviderExecutionService`; production caller `YookassaAdapter` не найден. Adapter и execution service отличаются request/response contract. Это не redundancy, а неиспользуемая альтернативная реализация, создающая ложное покрытие. Нужен один canonical client.

## E. Гонка immediate-fulfill vs webhook / `fulfilledAt`

`fulfilledAt` задуман как single ownership marker, но immediate ветки используют его только в WHERE и не записывают. Между `status=COMPLETED` и внутренним mutation stamp webhook получает законный claim. Оба пути then provision по stale Transaction. Это P0 и требует общего claim/release протокола, а не двух похожих фрагментов.

## F. Autopay: 3DS/pending / `permission_revoked` / polling

- 3DS/redirect: pending сохраняется, но нет delivery URL/confirmation path; через 30 минут local sweep отменяет строку.
- `permission_revoked`: current code переводит payment в canceled, но не читает reason и не отключает saved method.
- Polling: официальный GET fallback не реализован; неиспользуемый adapter method проблему не решает.

## G. Вердикт

**NEEDS_FIX_BEFORE_PROD.** PR корректно улучшает request shape, idempotency, IP verification и saved-method ownership, но два P0 допускают double fulfillment и permanently blocked canceled autopay.

## H. Приоритетный checklist

- [ ] **P0:** Общий atomic `fulfilledAt` claim для webhook и immediate checkout; race tests.
- [ ] **P0:** Обрабатывать 2xx `canceled` как terminal result, сохранять id/reason, не оставлять renewal claim PENDING.
- [ ] **P1:** При `permission_revoked` отключать method и запускать user-confirmed flow.
- [ ] **P1:** Bounded GET polling PENDING/ambiguous create; сверка перед local TTL.
- [ ] **P1:** 3DS/redirect notification/manual policy; не считать log delivery.
- [ ] **P1:** Подтвердить YooKassa production enablement и durable consent/offer audit.
- [ ] **P2:** Оставить один YooKassa client с contract tests.
- [ ] **P2:** Сохранять method после trusted immediate success без webhook.
- [ ] **P2:** Тесты canceled, permission_revoked, poll success/canceled, lost webhook, 3DS policy, immediate-without-webhook, idempotence retry.

VERDICT: NEEDS_FIX_BEFORE_PROD

---

## Follow-up status (local, not released) — 2026-07-21

### P0 (done)
1. **`payment-fulfillment-claim.util.ts`** — atomic claim `PENDING + fulfilledAt null → COMPLETED + fulfilledAt`; release on provision failure.
2. **checkout + renewal** use the claim for zero-total and immediate `succeeded`.
3. **YooKassa `canceled`/`cancelled`** structured terminal result → local `CANCELED`.

### P1 (done)
1. **`permission_revoked`** → `disableAutopayForProviderMethod` (checkout cancel path + webhook cancel; keeps card listed).
2. **Pending expiry GET poll** for real YooKassa ids: keep open on pending/waiting_for_capture; mark COMPLETED (unfulfilled) on succeeded; skip cancel on network error; cancel on provider canceled.
3. **3DS visibility** — persist `checkoutUrl`; `notifyAutopayConfirmationRequired` system event for saved-method redirects.
4. **Crash recovery** — reconciler: COMPLETED+fulfilledAt+NEW+subscriptionId null → release claim and re-fulfill.
5. **Immediate success** → best-effort `upsertFromYookassaPayment` from create response payload.

### Tests (local)
- 33 pass: checkout, execution, rebind, permission-revoked, pending-expiry
- `npm run typecheck` pass

### Residual (P2 / ops)
- Poll `succeeded` marks COMPLETED but does not auto-provision until webhook/manual reconcile (safe; no double-charge).
- RENEW crash recovery (fulfilled but renew not applied) still hard to detect vs NEW.
- Consent/offer audit still product-side.
- Dual `YookassaAdapter` vs execution service cleanup still open.

**Not released** — waiting for explicit user go-ahead.
