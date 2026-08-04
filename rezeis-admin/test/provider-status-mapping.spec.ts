import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TransactionStatus } from '@prisma/client';

import {
  isAmountMismatchProviderStatus,
  isRefundProviderStatus,
  mapProviderStatusToTransactionStatus,
} from '../src/modules/payments/services/payment-reconciliation.service';

/**
 * One table decides what every gateway's webhook means, and its default is
 * `PENDING`. That default is why the gaps here were invisible: an unmapped
 * status did not fail loudly, it looked like "the buyer hasn't paid yet" until
 * the 30-minute sweep cancelled the row. Money in, nothing delivered, no alert.
 *
 * Statuses below are taken from each provider's own documentation. Every entry
 * that reads COMPLETED is a case where funds have actually arrived.
 */

const SUCCESS: readonly (readonly [string, string])[] = [
  ['YooKassa', 'succeeded'],
  ['Telegram Stars', 'successful_payment'],
  ['Platega', 'CONFIRMED'],
  ['Cryptomus / Heleket', 'paid'],
  // Regression: the buyer paid MORE than asked. The payment succeeded; this
  // used to fall through to PENDING and be cancelled by the sweep.
  ['Cryptomus / Heleket (переплата)', 'paid_over'],
  // Regression: Overpay spells success `successful`, not `success`.
  ['Overpay', 'successful'],
  ['RioPay / Valutix', 'COMPLETED'],
  ['SeverPay', 'success'],
  ['AuraPay', 'PAID'],
  ['Lava', 'completed'],
  ['RollyPay', 'paid'],
];

const TERMINAL_FAILURE: readonly (readonly [string, string])[] = [
  ['YooKassa', 'canceled'],
  ['Platega', 'CANCELED'],
  ['Cryptomus / Heleket', 'fail'],
  // Regressions: singular / provider-specific spellings that used to linger in
  // PENDING for half an hour instead of resolving at once.
  ['Cryptomus / Heleket (отменён)', 'cancel'],
  ['Cryptomus / Heleket (сбой)', 'system_fail'],
  ['SeverPay', 'decline'],
  ['RioPay / Valutix', 'BLOCKED'],
  ['RioPay / Valutix', 'EXPIRED'],
  ['AuraPay', 'EXPIRED'],
  ['Overpay', 'failed'],
];

/** Money clawed back after fulfilment — must reverse side-effects. */
const REFUNDS: readonly (readonly [string, string])[] = [
  ['YooKassa', 'refunded'],
  ['Telegram Stars', 'refunded_payment'],
  ['Cryptomus / Heleket', 'refund_paid'],
  ['общий', 'chargeback'],
  // Regression: Platega spells it with the -ED suffix, so the reversal branch
  // never ran and the subscription stayed granted on reclaimed money.
  ['Platega', 'CHARGEBACKED'],
];

/**
 * Money ARRIVED, but not the amount we invoiced — or it is frozen at the
 * provider. Cryptomus documents `wrong_amount` as FINAL: its resend-webhook
 * page lists it beside `paid` and `paid_over` among the finalized statuses, so
 * the invoice can never move on to `paid`. These rows are not "still waiting
 * for the buyer" — the crypto is on-chain and credited to us.
 */
const AMOUNT_MISMATCH: readonly (readonly [string, string])[] = [
  ['Cryptomus / Heleket', 'wrong_amount'],
  ['Cryptomus / Heleket (ждёт доплату)', 'wrong_amount_waiting'],
  ['Cryptomus / Heleket (AML-заморозка)', 'locked'],
  ['Pally', 'UNDERPAID'],
];

/** Genuinely still in flight — PENDING is the right answer here. */
const IN_FLIGHT: readonly (readonly [string, string])[] = [
  ['YooKassa', 'pending'],
  ['Cryptomus / Heleket', 'process'],
  ['Cryptomus / Heleket', 'check'],
  ['Cryptomus / Heleket', 'confirm_check'],
  ['RioPay / Valutix', 'PENDING'],
  ['SeverPay', 'new'],
  ['AuraPay', 'PENDING'],
  // An in-flight refund must NOT reverse anything yet.
  ['Cryptomus / Heleket', 'refund_process'],
];

describe('provider status mapping', () => {
  for (const [gateway, status] of SUCCESS) {
    it(`${gateway}: "${status}" завершает платёж`, () => {
      assert.equal(mapProviderStatusToTransactionStatus(status), TransactionStatus.COMPLETED);
    });
  }

  for (const [gateway, status] of TERMINAL_FAILURE) {
    it(`${gateway}: "${status}" отменяет платёж сразу`, () => {
      assert.equal(mapProviderStatusToTransactionStatus(status), TransactionStatus.CANCELED);
    });
  }

  for (const [gateway, status] of REFUNDS) {
    it(`${gateway}: "${status}" распознаётся как возврат`, () => {
      assert.equal(isRefundProviderStatus(status), true);
      assert.equal(mapProviderStatusToTransactionStatus(status), TransactionStatus.CANCELED);
    });
  }

  for (const [gateway, status] of IN_FLIGHT) {
    it(`${gateway}: "${status}" остаётся в ожидании`, () => {
      assert.equal(mapProviderStatusToTransactionStatus(status), TransactionStatus.PENDING);
      assert.equal(isRefundProviderStatus(status), false);
    });
  }

  for (const [gateway, status] of AMOUNT_MISMATCH) {
    it(`${gateway}: "${status}" — деньги пришли не в той сумме, нужен оператор`, () => {
      assert.equal(isAmountMismatchProviderStatus(status), true);
      // Never COMPLETED: a partial payment must not buy a full subscription.
      assert.equal(mapProviderStatusToTransactionStatus(status), TransactionStatus.PENDING);
      // Not a refund either — nothing has been given back.
      assert.equal(isRefundProviderStatus(status), false);
    });
  }

  it('переплата — это успех, а не рассинхрон суммы', () => {
    // `paid_over` / `OVERPAID` mean the buyer paid AT LEAST what was asked, so
    // they complete outright and must never be diverted into the operator
    // queue — the queue exists for money we cannot deliver against.
    for (const status of ['paid_over', 'OVERPAID']) {
      assert.equal(isAmountMismatchProviderStatus(status), false);
      assert.equal(mapProviderStatusToTransactionStatus(status), TransactionStatus.COMPLETED);
    }
  });

  it('обычные статусы не попадают в очередь ручного разбора', () => {
    // The flag this classifier drives exempts a row from the pending-expiry
    // sweep. Over-matching here would strand ordinary abandoned carts PENDING
    // forever with their trial reservations held.
    for (const status of ['paid', 'succeeded', 'canceled', 'expired', 'refund_paid', 'process', '']) {
      assert.equal(isAmountMismatchProviderStatus(status), false);
    }
    assert.equal(isAmountMismatchProviderStatus(null), false);
  });

  it('не путает незавершённый возврат с завершённым', () => {
    // `refund_process` reversing early would strip a subscription while the
    // refund could still fail.
    assert.equal(isRefundProviderStatus('refund_process'), false);
    assert.equal(isRefundProviderStatus('refund_fail'), false);
  });

  it('an unknown status stays PENDING rather than guessing', () => {
    // Deliberate: an unrecognised status must never be read as success. It
    // resolves via the sweep instead. The cost of that default is that gaps are
    // invisible — which is exactly what the table above exists to prevent.
    assert.equal(mapProviderStatusToTransactionStatus('some_new_status'), TransactionStatus.PENDING);
    assert.equal(mapProviderStatusToTransactionStatus(null), TransactionStatus.PENDING);
    assert.equal(mapProviderStatusToTransactionStatus(''), TransactionStatus.PENDING);
  });
});
