import {
  PaymentGatewayType,
  PaymentWebhookLifecycleStatus,
  Prisma,
} from '@prisma/client';

/**
 * A money field lifted out of a provider notification, carried together with
 * whether that provider's signature actually binds it.
 *
 * The two travel as ONE value rather than as two sibling fields on the envelope
 * because the trust question is the easy one to forget. `if (envelope.notifiedAmount)`
 * reads identically for a Cryptomus amount the merchant key signs and a Platega
 * amount protected by nothing but a static header — and the second one will
 * eventually be treated as the first. Wrapping forces every reader through
 * `.value`, which puts `.signatureCovered` in front of them at that exact
 * moment. Two optional booleans alongside two optional values would carry the
 * same information and be silently skippable, which is the whole failure mode.
 *
 * `signatureCovered: false` deliberately collapses three different reasons into
 * one answer, because the trust decision they lead to is identical: the field is
 * not bound to any merchant secret. Those reasons are a static-header-only
 * gateway (Platega, MulenPay, lava.top, Telegram Stars), a source-IP-only
 * gateway (YooKassa), and a signature that covers some fields but not this one
 * (Pally's currency). See `SIGNED_AMOUNT_GATEWAYS` in
 * `payment-webhook-normalizer.service.ts` for the per-gateway classification.
 */
export interface PaymentWebhookNotifiedValueInterface<TValue> {
  readonly value: TValue;
  readonly signatureCovered: boolean;
}

export interface PaymentWebhookEnvelopeInterface {
  readonly gatewayType: PaymentGatewayType;
  readonly paymentId: string;
  readonly providerEventId: string;
  readonly eventStatus: string | null;
  readonly receivedAt: string;
  readonly payloadHash: string;
  readonly rawPayload: Record<string, unknown>;
  /**
   * What the provider says was paid, when the notification says at all.
   *
   * BE CLEAR-EYED ABOUT WHAT COMPARING THIS IS WORTH. It is defence-in-depth,
   * NOT an anti-forgery control, and must never be described as one. The sum we
   * charge is server-derived from a plan quote and entitlement comes from
   * `planSnapshot`, so a forger controls every field in the body and would
   * simply echo the correct amount back — the check costs them nothing. What it
   * does catch is an AUTHENTIC notification whose amount disagrees with our
   * record: a provider-side pricing or currency bug, a partial capture, a
   * misconfigured merchant account. That is genuinely worth catching, and it is
   * all this catches. Antilopay's documentation (p.54) makes checking the
   * notified sum a merchant obligation, which is why it exists at all.
   *
   * `undefined` means the notification did not report a sum — never zero. A
   * fabricated zero would read as "the buyer paid nothing" and turn a silent
   * gap into a false alarm on every payment through that gateway.
   *
   * Already descaled where the provider reports minor units (Overpay), so this
   * is directly comparable to `Transaction.amount` without further arithmetic.
   */
  readonly notifiedAmount?: PaymentWebhookNotifiedValueInterface<Prisma.Decimal>;
  /**
   * The currency `notifiedAmount` is denominated in, upper-cased to match our
   * `Currency` enum.
   *
   * Read the pair together or not at all: an amount without its currency is not
   * comparable to a booked sum, because several gateways here can settle in a
   * coin other than the one invoiced. `signatureCovered` is tracked separately
   * from the amount's for a concrete reason — Pally signs `OutSum` but not
   * `CurrencyIn`, so its amount is trustworthy while its currency is not.
   */
  readonly notifiedCurrency?: PaymentWebhookNotifiedValueInterface<string>;
}

export interface PaymentWebhookIngressResultInterface {
  readonly accepted: true;
  readonly duplicate: boolean;
  readonly lifecycleStatus: PaymentWebhookLifecycleStatus;
}
