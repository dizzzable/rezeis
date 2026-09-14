import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Currency, PaymentGatewayType, PurchaseChannel, PurchaseType } from '@prisma/client';

import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { PaymentSubscriptionMutationService } from '../src/modules/payments/services/payment-subscription-mutation.service';

/**
 * One payment, one `payment.completed`
 * ════════════════════════════════════
 * A customer blocked between creating an invoice and paying it still gets the
 * subscription recorded (with the VPN profile disabled), and the operator has
 * to hear about it — refunding is their decision.
 *
 * That warning used to be emitted IN ADDITION to the ordinary completion, so a
 * single payment raised `payment.completed` twice: two «Платёж получен» cards,
 * two runs of every automation rule and outbound webhook bound to the type,
 * and with a receipt template active two receipt emails to the customer. The
 * warning is now the completion itself.
 *
 * Driven through the public `applyCompletedTransaction`; only the subscription
 * write is stubbed, because what is under test is what gets announced once it
 * has happened, not how the row is built (`payment-new-trial-snapshot.spec.ts`
 * and friends own that).
 */

interface Emitted {
  readonly severity: 'INFO' | 'WARNING' | 'ERROR';
  readonly type: string;
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

async function completePurchase(options: { readonly blocked: boolean }): Promise<Emitted[]> {
  const emitted: Emitted[] = [];
  const record =
    (severity: Emitted['severity']) =>
    (type: string, _category: string, message: string, metadata: Record<string, unknown>) => {
      emitted.push({ severity, type, message, metadata });
    };
  const events = { info: record('INFO'), warn: record('WARNING'), error: record('ERROR') };

  const prisma = {
    transactionItem: { findMany: async () => [] },
    plan: {
      findUnique: async () => ({
        id: 'plan-1',
        name: 'Premium',
        type: 'BOTH',
        trafficLimit: 100,
        deviceLimit: 3,
      }),
    },
    user: {
      // Asked twice: once for the block flag, once by the discount settlement
      // for `purchaseDiscount`. One answer serves both.
      findUnique: async () => ({ isBlocked: options.blocked, purchaseDiscount: 0 }),
    },
    userPendingDiscount: { findMany: async () => [] },
  };

  const service = new PaymentSubscriptionMutationService(
    prisma as never,
    events as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  (
    service as unknown as {
      createSubscriptionFromPayment: () => Promise<unknown>;
    }
  ).createSubscriptionFromPayment = async () => ({
    subscription: { id: 'sub-1', remnawaveId: 'rw-1' },
    syncJob: { id: 'job-1' },
  });

  await service.applyCompletedTransaction({
    id: 'tx-1',
    userId: 'user-1',
    paymentId: 'pay-1',
    purchaseType: PurchaseType.NEW,
    amount: { toString: () => '499' },
    currency: Currency.RUB,
    gatewayType: PaymentGatewayType.YOOKASSA,
    channel: PurchaseChannel.WEB,
    planSnapshot: { id: 'plan-1', selectedDurationDays: 30 },
  } as never);

  return emitted.filter((event) => event.type === EVENT_TYPES.PAYMENT_COMPLETED);
}

describe('the completion announced for a paid purchase', () => {
  it('is a single WARNING, carrying the purchase and the note, when the customer is blocked', async () => {
    const completions = await completePurchase({ blocked: true });

    assert.equal(
      completions.length,
      1,
      `one payment must raise one payment.completed; got ${completions.length}: ` +
        JSON.stringify(completions.map((event) => `${event.severity}: ${event.message}`)),
    );
    const [completion] = completions;
    assert.equal(completion.severity, 'WARNING');
    // Operator-facing, so in the operator's language: the message is what the
    // event feed shows and the note is what the card prints («📝 Заметка»).
    assert.equal(completion.message, 'Платёж получен от заблокированного пользователя');
    assert.equal(
      completion.metadata['note'],
      'Счёт создан до блокировки, а оплачен после неё. Подписка записана, VPN-профиль отключён. ' +
        'Решите, нужен ли возврат средств.',
    );
    for (const text of [completion.message, String(completion.metadata['note'])]) {
      // Four letters, so «VPN» — the operator's own word for it — is allowed.
      assert.doesNotMatch(text, /[A-Za-z]{4,}/, `English left in operator text: ${text}`);
    }
    // Everything the ordinary completion carries, so no subscriber of the type
    // loses a field by the payer having been blocked.
    assert.equal(completion.metadata['planName'], 'Premium');
    assert.equal(completion.metadata['subscriptionId'], 'sub-1');
    assert.equal(completion.metadata['purchaseType'], PurchaseType.NEW);
    assert.equal(completion.metadata['amount'], '499');
  });

  it('is a single INFO without the note for a customer in good standing', async () => {
    // The control: the ordinary path must neither disappear nor pick up the
    // warning's note.
    const completions = await completePurchase({ blocked: false });

    assert.equal(completions.length, 1);
    assert.equal(completions[0].severity, 'INFO');
    assert.equal(completions[0].metadata['note'], undefined);
    assert.equal(completions[0].metadata['subscriptionId'], 'sub-1');
  });
});
