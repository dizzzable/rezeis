import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  CHECKOUT_LIFETIME_MINUTES,
  CHECKOUT_LIFETIME_MS,
  CHECKOUT_LIFETIME_SECONDS,
  checkoutExpiresAt,
} from '../src/modules/payments/constants/checkout-lifetime.constant';

/**
 * The invariant: a provider-side invoice must never outlive our own pending
 * draft.
 *
 * When it does, we hold a row we treat as dead while the buyer still holds a
 * payable link. That is what made releasing a paid-trial reservation on cancel
 * unsafe — no gateway here offers an API to kill an invoice, so a buyer could
 * stack several live links and settle them all.
 *
 * The gap was real and large: Wata defaulted to three days, Overpay to a day,
 * and most gateways were asked for no expiry at all.
 */

const EXECUTION_SERVICE = readFileSync(
  join(__dirname, '..', 'src', 'modules', 'payments', 'services', 'payment-provider-execution.service.ts'),
  'utf8',
);

const EXPIRY_SERVICE = readFileSync(
  join(__dirname, '..', 'src', 'modules', 'payments', 'services', 'payment-pending-expiry.service.ts'),
  'utf8',
);

/**
 * Gateways whose API accepts an invoice lifetime, and the field each one wants.
 * Verified against the providers' own documentation; see
 * PROJECT_STUDY/GATEWAY_CAPABILITIES.md for the per-gateway ranges.
 *
 * Gateways absent from this list genuinely offer no such parameter (Antilopay,
 * Platega, RioPay, Valutix, RollyPay, MulenPay) or fix it themselves (Lava:
 * 15 minutes for USD/EUR, 24 hours for RUB).
 */
const LIFETIME_CAPABLE = [
  { gateway: 'Cryptomus', field: 'lifetime' },
  { gateway: 'Heleket', field: 'lifetime' },
  { gateway: 'Aurapay', field: 'lifetime' },
  { gateway: 'Severpay', field: 'lifetime' },
  { gateway: 'Cryptopay', field: 'expires_in' },
  { gateway: 'Paypalych', field: 'ttl' },
  { gateway: 'Wata', field: 'expirationDateTime' },
  { gateway: 'Overpay', field: 'expired_at' },
] as const;

/** Body of `createXxxCheckout`, up to the next method declaration. */
function checkoutMethod(gateway: string): string {
  const start = EXECUTION_SERVICE.indexOf(`private async create${gateway}Checkout`);
  assert.notEqual(start, -1, `no create${gateway}Checkout in the execution service`);
  const next = EXECUTION_SERVICE.indexOf('\n  private async ', start + 1);
  return EXECUTION_SERVICE.slice(start, next === -1 ? undefined : next);
}

describe('checkout lifetime', () => {
  it('never lets a provider invoice outlive the pending sweep', () => {
    // The sweep matches `createdAt < now - PENDING_TTL_MS`, so it fires strictly
    // after this has elapsed — equal values are safe, longer ones are not.
    assert.ok(
      EXPIRY_SERVICE.includes('const PENDING_TTL_MS = CHECKOUT_LIFETIME_MS'),
      'the sweep window must derive from the shared constant, not restate it',
    );
    assert.equal(CHECKOUT_LIFETIME_MS, CHECKOUT_LIFETIME_SECONDS * 1000);
    assert.equal(CHECKOUT_LIFETIME_SECONDS, CHECKOUT_LIFETIME_MINUTES * 60);
  });

  it('stays inside the narrowest range any supported gateway accepts', () => {
    // SeverPay's floor is 30 minutes and Cryptomus/Heleket cap at 12 hours;
    // a value outside that band would be rejected by one of them at runtime.
    assert.ok(CHECKOUT_LIFETIME_MINUTES >= 30, 'below SeverPay’s minimum of 30 minutes');
    assert.ok(CHECKOUT_LIFETIME_SECONDS <= 43_200, 'above Cryptomus/Heleket’s 12-hour ceiling');
  });

  for (const { gateway, field } of LIFETIME_CAPABLE) {
    it(`asks ${gateway} for an explicit lifetime`, () => {
      // Not just "the field is present" — it must come from the shared
      // constant. A hardcoded number here is how the three gateways that
      // already set one ended up pinned to the provider's own default,
      // silently choosing nothing.
      const body = checkoutMethod(gateway);
      assert.ok(body.includes(`${field}:`), `${gateway} sends no ${field}`);
      assert.match(
        body,
        new RegExp(`${field}:\\s*(CHECKOUT_LIFETIME_\\w+|checkoutExpiresAt\\()`),
        `${gateway}.${field} must derive from the shared constant`,
      );
    });
  }

  it('renders an absolute expiry as ISO-8601 UTC for the timestamp gateways', () => {
    const now = new Date('2026-08-04T12:00:00.000Z');
    assert.equal(checkoutExpiresAt(now), '2026-08-04T12:30:00.000Z');
  });
});
