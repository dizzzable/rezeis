import {
  createHash,
  createHmac,
  createPublicKey,
  createVerify,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import { BlockList, isIP } from 'node:net';

import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PaymentGatewayType, Prisma } from '@prisma/client';

import {
  PaymentWebhookEnvelopeInterface,
  PaymentWebhookNotifiedValueInterface,
} from '../interfaces/payment-webhook-envelope.interface';
import { readGatewaySettings } from '../utils/payment-gateway-settings.util';

interface NormalizeWebhookInput {
  readonly gatewayType: PaymentGatewayType;
  readonly rawBody: Buffer;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly clientIp: string | null;
  readonly gatewaySettings: unknown;
  readonly verifySignature: boolean;
}

/**
 * Where a gateway keeps the sum it is reporting, before any typing or trust is
 * applied. Kept as the provider's own string so the Decimal parse happens once,
 * in one place, and a malformed value fails there instead of becoming a NaN
 * three services downstream.
 */
interface NotifiedMoneySourceInterface {
  readonly amount: string | null;
  readonly currency: string | null;
  /**
   * Decimal places the provider's integer amount is scaled by. Only Overpay
   * needs it (kopecks); everyone else reports major units.
   */
  readonly minorUnitScale?: number;
}

/**
 * The money half of the envelope on its own. Exported alongside
 * {@link resolveNotifiedMoney} so a caller working from a persisted webhook row
 * — which has no envelope — can name what it gets back.
 */
export interface NotifiedMoneyInterface {
  readonly notifiedAmount?: PaymentWebhookNotifiedValueInterface<Prisma.Decimal>;
  readonly notifiedCurrency?: PaymentWebhookNotifiedValueInterface<string>;
}

/**
 * Gateways whose signature actually binds the AMOUNT in the notification body.
 *
 * This set is the whole reason the envelope reports coverage rather than just
 * a number: outside it, the sum is worth exactly as much as the rest of an
 * unauthenticated body. The three classes, and why each lands where it does:
 *
 *  - IN — the signature is computed over the raw body or over a digest of the
 *    whole document, so every field including the amount is bound. That is
 *    every entry below except Pally, whose md5 names `OutSum` explicitly.
 *  - OUT, static-header auth only — PLATEGA (`X-MerchantId` + `X-Secret`),
 *    MULENPAY (`X-Api-Key`), LAVA (`X-Api-Key`), TELEGRAM_STARS
 *    (`X-Telegram-Bot-Api-Secret-Token`). The header proves the sender knows a
 *    secret; nothing ties it to the payload, so any field can be rewritten in
 *    flight without invalidating anything.
 *  - OUT, no signature at all — YOOKASSA, authenticated by source IP only.
 *
 * Do not add a gateway here without its check appearing in `verifySignature`
 * above and covering the amount. A wrong entry here is worse than no entry:
 * it launders an unauthenticated number into a trusted one.
 */
const SIGNED_AMOUNT_GATEWAYS: ReadonlySet<PaymentGatewayType> = new Set([
  PaymentGatewayType.HELEKET,
  PaymentGatewayType.CRYPTOMUS,
  PaymentGatewayType.RIOPAY,
  PaymentGatewayType.VALUTIX,
  PaymentGatewayType.ANTILOPAY,
  PaymentGatewayType.OVERPAY,
  PaymentGatewayType.WATA,
  PaymentGatewayType.AURAPAY,
  PaymentGatewayType.ROLLYPAY,
  PaymentGatewayType.SEVERPAY,
  PaymentGatewayType.CRYPTOPAY,
  PaymentGatewayType.PAYPALYCH,
]);

/**
 * Derived from the amount set by subtracting the single gateway where the two
 * differ, so the asymmetry is one visible line that cannot drift out of sync.
 *
 * Pally is that gateway. Its signature is
 * `md5(OutSum + ":" + InvId + ":" + apiToken)` — it names two fields and binds
 * only those. `CurrencyIn` travels in the same form body completely
 * unauthenticated, so a Pally notification can carry a correctly-signed sum
 * beside a currency anyone could have rewritten. Flattening that into one
 * per-envelope boolean would lose it: the amount would drag the currency up to
 * "trusted", and a 100.00 that is genuinely signed as RUB could then be read
 * as 100.00 USD.
 *
 * Everyone else in `SIGNED_AMOUNT_GATEWAYS` signs the whole document, so
 * currency is covered wherever amount is.
 */
const SIGNED_CURRENCY_GATEWAYS: ReadonlySet<PaymentGatewayType> = new Set(
  [...SIGNED_AMOUNT_GATEWAYS].filter(
    (gatewayType) => gatewayType !== PaymentGatewayType.PAYPALYCH,
  ),
);

const YOOKASSA_TRUSTED_NETWORKS: readonly string[] = [
  '185.71.76.0/27',
  '185.71.77.0/27',
  '77.75.153.0/25',
  '77.75.156.11/32',
  '77.75.156.35/32',
  '77.75.154.128/25',
  '2a02:5180::/32',
] as const;

const yookassaTrustedBlockList = createTrustedBlockList(YOOKASSA_TRUSTED_NETWORKS);

/**
 * lava.top's single published notification address.
 *
 * Source pinning earns its keep for exactly one gateway here, and this is it:
 * lava.top's webhook carries no payload signature at all — only a static
 * `X-Api-Key` — so nothing in the body is bound to the merchant. One stable
 * address plus an explicit "whitelist it" in the docs makes the source the only
 * additional evidence available.
 *
 * Deliberately NOT extended to the other gateways, and that asymmetry is the
 * point rather than an omission: SeverPay, AuraPay and RollyPay already sign
 * the body *including the amount*, so an address adds nothing they lack.
 * SeverPay's published addresses are cloud IPs that renumber, and its list
 * includes IPv6 — precisely the shape that an allowlist bug silently drops (see
 * `isTrustedSourceIp`). AuraPay, RollyPay and Platega publish no addresses at
 * all. Do not "complete the pattern".
 */
const LAVA_DEFAULT_NOTIFICATION_NETWORKS: readonly string[] = ['158.160.60.174'] as const;

/**
 * Comma-separated addresses or CIDRs. Overriding matters because the address is
 * lava.top's to change: a renumbering must be a config edit, not an outage. It
 * also covers a deployment where a proxy sits outside Express' trust-proxy
 * boundary and the peer we observe is the proxy, not lava.top.
 */
export const LAVA_TRUSTED_NETWORKS_ENV = 'LAVA_WEBHOOK_ALLOWED_IPS';

const lavaTrustedBlockList = createTrustedBlockList(
  resolveLavaTrustedNetworks(process.env[LAVA_TRUSTED_NETWORKS_ENV]),
);

@Injectable()
export class PaymentWebhookNormalizerService {
  public verifyWebhookSignature(input: Omit<NormalizeWebhookInput, 'verifySignature'>): void {
    const rawPayload = parseWebhookPayload(input.rawBody, input.gatewayType);
    this.verifySignature({
      gatewayType: input.gatewayType,
      rawBody: input.rawBody,
      rawPayload,
      headers: input.headers,
      gatewaySettings: readGatewaySettings(input.gatewaySettings as never),
      clientIp: input.clientIp,
    });
  }

  public normalizeWebhook(input: NormalizeWebhookInput): PaymentWebhookEnvelopeInterface {
    const rawPayload = parseWebhookPayload(input.rawBody, input.gatewayType);
    const gatewaySettings = readGatewaySettings(input.gatewaySettings as never);
    if (input.verifySignature) {
      this.verifySignature({
        gatewayType: input.gatewayType,
        rawBody: input.rawBody,
        rawPayload,
        headers: input.headers,
        gatewaySettings,
        clientIp: input.clientIp,
      });
    }

    const paymentId = this.resolvePaymentId({
      gatewayType: input.gatewayType,
      rawPayload,
    });
    const providerEventId =
      this.resolveProviderEventId({
        gatewayType: input.gatewayType,
        rawPayload,
      }) ?? paymentId;
    const eventStatus = this.resolveEventStatus({
      gatewayType: input.gatewayType,
      rawPayload,
    });
    // After `resolvePaymentId`, never before: the Telegram branch reuses
    // `resolveTelegramPaymentPayload`, which throws when the update carries no
    // payment at all. Resolving the id first means that rejection keeps its
    // existing error rather than surfacing from the money extraction.
    const notifiedMoney = resolveNotifiedMoney(input.gatewayType, rawPayload);

    return {
      gatewayType: input.gatewayType,
      paymentId,
      providerEventId,
      eventStatus,
      receivedAt: new Date().toISOString(),
      payloadHash: createHash('sha256').update(input.rawBody).digest('hex'),
      rawPayload,
      ...notifiedMoney,
    };
  }

  private verifySignature(input: {
    readonly gatewayType: PaymentGatewayType;
    readonly rawBody: Buffer;
    readonly rawPayload: Record<string, unknown>;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly gatewaySettings: Record<string, unknown>;
    readonly clientIp: string | null;
  }): void {
    switch (input.gatewayType) {
      case PaymentGatewayType.TELEGRAM_STARS:
        verifyTelegramStarsSignature(input.headers, input.gatewaySettings);
        return;
      case PaymentGatewayType.YOOKASSA:
        verifyYookassaSourceIp(input.clientIp);
        return;
      case PaymentGatewayType.HELEKET:
        verifyHeleketSignature(input.rawPayload, input.headers, input.gatewaySettings);
        return;
      case PaymentGatewayType.PLATEGA:
        verifyPlategaHeaders(input.headers, input.gatewaySettings);
        return;
      case PaymentGatewayType.MULENPAY:
        verifyMulenPayHeaders(input.headers, input.gatewaySettings);
        return;
      case PaymentGatewayType.CRYPTOMUS:
        verifyCryptomusFamilySignature(input.rawPayload, input.headers, input.gatewaySettings);
        return;
      case PaymentGatewayType.RIOPAY:
        verifyRiopaySignature(input.rawBody, input.headers, input.gatewaySettings);
        return;
      case PaymentGatewayType.ANTILOPAY:
        verifyAntilopaySignature(input.rawBody, input.headers, input.gatewaySettings);
        return;
      case PaymentGatewayType.OVERPAY:
        verifyOverpaySignature(input.rawBody, input.headers, input.gatewaySettings);
        return;
      case PaymentGatewayType.PAYPALYCH:
        verifyPaypalychSignature(input.rawPayload, input.gatewaySettings);
        return;
      case PaymentGatewayType.VALUTIX:
        verifyValutixSignature(input.rawBody, input.headers, input.gatewaySettings);
        return;
      case PaymentGatewayType.WATA:
        verifyWataSignature(input.rawBody, input.headers, input.gatewaySettings);
        return;
      case PaymentGatewayType.AURAPAY:
        verifyAurapaySignature(input.rawPayload, input.headers, input.gatewaySettings);
        return;
      case PaymentGatewayType.ROLLYPAY:
        verifyRollypaySignature(input.rawBody, input.headers, input.gatewaySettings);
        return;
      case PaymentGatewayType.SEVERPAY:
        verifySeverpaySignature(input.rawPayload, input.gatewaySettings);
        return;
      case PaymentGatewayType.LAVA:
        // Both checks, never one instead of the other: the API key proves the
        // sender knows a secret, the source pin proves it is lava.top. Neither
        // is bound to the payload, so dropping either halves what little
        // authentication this gateway offers.
        verifyLavaApiKey(input.headers, input.gatewaySettings);
        verifyLavaSourceIp(input.clientIp);
        return;
      case PaymentGatewayType.CRYPTOPAY:
        verifyCryptopaySignature(input.rawBody, input.headers, input.gatewaySettings);
        return;
      default:
        throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_UNSUPPORTED');
    }
  }

  private resolvePaymentId(input: {
    readonly gatewayType: PaymentGatewayType;
    readonly rawPayload: Record<string, unknown>;
  }): string {
    switch (input.gatewayType) {
      case PaymentGatewayType.TELEGRAM_STARS:
        return readRequiredString(
          resolveTelegramPaymentPayload(input.rawPayload),
          ['invoice_payload', 'payload'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.YOOKASSA: {
        const yookassaObject = readNestedObject(input.rawPayload, 'object');
        // Refund notification (`event: refund.succeeded`): `object` is a Refund,
        // which carries `payment_id` (the original YooKassa payment id) but has
        // no `metadata.paymentId`. Resolve to that gateway id — the reconciler's
        // `findTransactionForEvent` falls back to a `gatewayId` lookup, so the
        // original transaction is found and its side-effects get reversed.
        if (isYookassaRefundEvent(input.rawPayload)) {
          return readRequiredString(
            yookassaObject,
            ['payment_id', 'paymentId'],
            'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
          );
        }
        return readRequiredString(
          readNestedObject(yookassaObject, 'metadata'),
          // Primary path writes `paymentId`; adapter/legacy payloads used `payment_id`.
          ['paymentId', 'payment_id'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      }
      case PaymentGatewayType.HELEKET:
        return readRequiredString(
          input.rawPayload,
          ['order_id', 'orderId', 'payload'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.PLATEGA:
        return readRequiredString(
          input.rawPayload,
          ['payload', 'paymentId', 'localPaymentId', 'id'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.MULENPAY:
        return readRequiredString(
          input.rawPayload,
          ['orderId', 'order_id', 'uuid', 'payment_uuid', 'id'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.CRYPTOMUS:
        return readRequiredString(
          input.rawPayload,
          ['order_id', 'orderId'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.RIOPAY:
      case PaymentGatewayType.VALUTIX:
        return readRequiredString(
          input.rawPayload,
          ['externalId', 'id'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.WATA:
        return readRequiredString(
          input.rawPayload,
          ['orderId', 'order_id'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.AURAPAY:
        return readRequiredString(
          input.rawPayload,
          ['order_id', 'orderId'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.ROLLYPAY:
        return readRequiredString(
          input.rawPayload,
          ['order_id', 'payment_id'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.SEVERPAY: {
        // SeverPay wraps the event payload in `data: {...}`
        const dataObject = readNestedObject(input.rawPayload, 'data');
        return readRequiredString(
          dataObject,
          ['order_id', 'orderId', 'uid'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      }
      case PaymentGatewayType.LAVA:
        return readRequiredString(
          input.rawPayload,
          ['contractId', 'parentContractId'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.CRYPTOPAY:
        // CryptoPay webhook wraps the Invoice in `payload`; our internal id is
        // the invoice's own `payload` field (set to `paymentId` at checkout).
        return readRequiredString(
          readNestedObject(input.rawPayload, 'payload'),
          ['payload'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.ANTILOPAY:
        // `order_id` is the merchant-side id we sent at checkout; `payment_id`
        // is Antilopay's own. Signature verification for this gateway was
        // implemented but this resolver was not, so every verified webhook died
        // one step later with PAYMENT_WEBHOOK_PAYMENT_ID_MISSING.
        return readRequiredString(
          input.rawPayload,
          ['order_id', 'payment_id'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.PAYPALYCH:
        // Form field, capitalised: `InvId` is the `order_id` we sent.
        return readRequiredString(
          input.rawPayload,
          ['InvId', 'order_id'],
          'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
        );
      case PaymentGatewayType.OVERPAY: {
        // Two shapes: card notifications nest under `transaction`, while the
        // checkout-token notification (including the expiry one) is flat with
        // the id under `order`. Try both, then the root.
        const overpayTransaction = readNestedObject(input.rawPayload, 'transaction');
        const overpayOrder = readNestedObject(input.rawPayload, 'order');
        return (
          readOptionalString(overpayTransaction, ['tracking_id']) ??
          readOptionalString(overpayOrder, ['tracking_id']) ??
          readRequiredString(
            input.rawPayload,
            ['tracking_id'],
            'PAYMENT_WEBHOOK_PAYMENT_ID_MISSING',
          )
        );
      }
      default:
        throw new BadRequestException('PAYMENT_WEBHOOK_PAYMENT_ID_MISSING');
    }
  }

  private resolveProviderEventId(input: {
    readonly gatewayType: PaymentGatewayType;
    readonly rawPayload: Record<string, unknown>;
  }): string | null {
    switch (input.gatewayType) {
      case PaymentGatewayType.TELEGRAM_STARS:
        return readOptionalString(input.rawPayload, ['update_id', 'providerEventId', 'eventId']);
      case PaymentGatewayType.YOOKASSA:
        return (
          readOptionalString(input.rawPayload, ['event_id', 'eventId']) ??
          readOptionalString(readNestedObject(input.rawPayload, 'object'), ['id'])
        );
      case PaymentGatewayType.HELEKET:
        return readOptionalString(input.rawPayload, ['id', 'uuid', 'payment_id', 'paymentId']);
      case PaymentGatewayType.PLATEGA:
        return readOptionalString(input.rawPayload, ['id', 'transactionId']);
      case PaymentGatewayType.MULENPAY:
        return readOptionalString(input.rawPayload, ['eventId', 'providerEventId']);
      case PaymentGatewayType.CRYPTOMUS:
        return readOptionalString(input.rawPayload, ['uuid', 'invoice_uuid', 'payment_uuid']);
      case PaymentGatewayType.RIOPAY:
      case PaymentGatewayType.VALUTIX:
        return readOptionalString(input.rawPayload, ['id']);
      case PaymentGatewayType.WATA:
        return readOptionalString(input.rawPayload, ['id', 'paymentId']);
      case PaymentGatewayType.AURAPAY:
        return readOptionalString(input.rawPayload, ['id']);
      case PaymentGatewayType.ROLLYPAY:
        return readOptionalString(input.rawPayload, ['payment_id']);
      case PaymentGatewayType.SEVERPAY:
        return readOptionalString(readNestedObject(input.rawPayload, 'data'), ['id', 'uid']);
      case PaymentGatewayType.LAVA:
        return readOptionalString(input.rawPayload, ['contractId']);
      case PaymentGatewayType.CRYPTOPAY:
        // Key on the invoice, NOT `update_id`: the docs call that one a
        // "Non-unique update ID" and it is always present, so two different
        // invoices could collide onto a single dedup row. The inbox then saw a
        // changed payload hash, overwrote that row in place and re-pointed the
        // already-queued job at the other invoice — the first invoice's `paid`
        // event was destroyed before it was ever applied, leaving a paid
        // transaction to be swept to CANCELED. Per-invoice keying matches
        // HELEKET/CRYPTOMUS, where the hash comparison still refreshes and
        // re-enqueues on a genuine `active → paid` transition.
        return readOptionalString(readNestedObject(input.rawPayload, 'payload'), ['invoice_id']);
      default:
        return null;
    }
  }

  private resolveEventStatus(input: {
    readonly gatewayType: PaymentGatewayType;
    readonly rawPayload: Record<string, unknown>;
  }): string | null {
    switch (input.gatewayType) {
      case PaymentGatewayType.TELEGRAM_STARS:
        return resolveTelegramPaymentStatus(input.rawPayload);
      case PaymentGatewayType.YOOKASSA:
        // A successful refund maps to our canonical REFUNDED status. The refund
        // object's own `status` is `succeeded`, which would otherwise be read as
        // a COMPLETED payment and silently skip the refund reversal.
        if (isYookassaRefundEvent(input.rawPayload)) {
          return 'REFUNDED';
        }
        return readOptionalString(readNestedObject(input.rawPayload, 'object'), ['status']);
      case PaymentGatewayType.HELEKET:
        return readOptionalString(input.rawPayload, ['status', 'payment_status']);
      case PaymentGatewayType.PLATEGA:
        return readOptionalString(input.rawPayload, ['status']);
      case PaymentGatewayType.MULENPAY:
        return readOptionalString(input.rawPayload, ['payment_status', 'status']);
      case PaymentGatewayType.CRYPTOMUS:
        return readOptionalString(input.rawPayload, ['status', 'payment_status']);
      case PaymentGatewayType.RIOPAY:
      case PaymentGatewayType.VALUTIX:
        return readOptionalString(input.rawPayload, ['status']);
      case PaymentGatewayType.WATA: {
        // Wata reports a completed REFUND with the same `transactionStatus:
        // "Paid"` as a completed payment — the two are told apart only by
        // `kind`. Ignoring it meant a refund was reconciled as a successful
        // sale: access granted on money that had just been returned.
        const wataStatus = readOptionalString(input.rawPayload, ['status', 'transactionStatus']);
        const wataKind = readOptionalString(input.rawPayload, ['kind']);
        if (wataKind?.toUpperCase() === 'REFUND' && wataStatus?.toUpperCase() === 'PAID') {
          return 'REFUNDED';
        }
        return wataStatus;
      }
      case PaymentGatewayType.AURAPAY:
        return readOptionalString(input.rawPayload, ['status']);
      case PaymentGatewayType.ROLLYPAY:
        // `status` FIRST. The body carries both, and `event_type` is always
        // present — so reading it first meant the `??` never reached `status`
        // and every event arrived as `payment.paid`, which matches nothing in
        // the status map. A successful payment then sat in PENDING until the
        // sweep cancelled it: money taken, nothing delivered.
        return (
          readOptionalString(input.rawPayload, ['status']) ??
          readOptionalString(input.rawPayload, ['event_type'])
        );
      case PaymentGatewayType.SEVERPAY:
        return readOptionalString(readNestedObject(input.rawPayload, 'data'), ['status']);
      case PaymentGatewayType.LAVA:
        // `status` FIRST, same reason as RollyPay: `eventType` is always set
        // (`payment.success`), so the fallback never fired and no payment ever
        // completed. The fallback still matters — a `subscription.cancelled`
        // body carries no `status` at all, only `cancelledAt`/`willExpireAt`.
        return (
          readOptionalString(input.rawPayload, ['status']) ??
          readOptionalString(input.rawPayload, ['eventType'])
        );
      case PaymentGatewayType.CRYPTOPAY:
        // Invoice `status` is `paid` | `active` | `expired`; `paid` normalizes
        // to a COMPLETED transaction, the rest stay PENDING/CANCELED.
        return readOptionalString(readNestedObject(input.rawPayload, 'payload'), ['status']);
      case PaymentGatewayType.ANTILOPAY:
        // The payment callback carries only SUCCESS or FAIL.
        return readOptionalString(input.rawPayload, ['status']);
      case PaymentGatewayType.PAYPALYCH:
        // `SUCCESS | UNDERPAID | OVERPAID | FAIL`. The two middle ones mean the
        // buyer DID pay, just not the exact amount — they must not be read as
        // an abandoned cart.
        return readOptionalString(input.rawPayload, ['Status', 'status']);
      case PaymentGatewayType.OVERPAY:
        // Card notifications nest under `transaction`; the checkout-token one
        // is flat. Expiry arrives as `status: "error"` with `expired: true`
        // rather than a dedicated status, so it maps through the failure path.
        return (
          readOptionalString(readNestedObject(input.rawPayload, 'transaction'), ['status']) ??
          readOptionalString(input.rawPayload, ['status'])
        );
      default:
        return null;
    }
  }
}

/**
 * The money extraction as a pure function of `(gatewayType, rawPayload)`, for a
 * consumer that never sees the envelope.
 *
 * `PaymentReconciliationService` is that consumer. It works from the persisted
 * `PaymentWebhookEvent` row, which stores `rawPayload` and `gatewayType` and no
 * notified sum; a column for one would be a second copy of a value already
 * derivable from the payload, free to disagree with it after a replay or a
 * backfill, and it would leave every row written before the migration blank.
 *
 * `normalizeWebhook` calls THIS function rather than the two halves directly,
 * which is the whole reason it exists. A per-gateway container walk and a
 * coverage classification resolved once at ingress and again in the reconciler
 * would eventually resolve differently, and the disagreement would surface as
 * an amount alert on a payment that is perfectly fine.
 */
export function resolveNotifiedMoney(
  gatewayType: PaymentGatewayType,
  rawPayload: Record<string, unknown>,
): NotifiedMoneyInterface {
  return buildNotifiedMoney(gatewayType, resolveNotifiedMoneySource({ gatewayType, rawPayload }));
}

/**
 * Locates the sum and currency each gateway reports. Mirrors the containers
 * `resolvePaymentId` and `resolveEventStatus` already walk for that gateway —
 * SeverPay's `data`, CryptoPay's `payload`, Overpay's `transaction`/`order`,
 * Telegram's `successful_payment` — because those wrappers are the part that
 * has actually bitten us, and duplicating the traversal here would let the
 * two drift.
 *
 * Amount and currency are always read from the SAME container. Several of
 * these providers can settle in a coin other than the one invoiced and report
 * both pairs side by side; picking the sum from one pair and the ticker from
 * the other yields a value that looks comparable and is not.
 *
 * A gateway that reports nothing returns nulls and ends up with both envelope
 * fields `undefined` — never a zero standing in for "did not say".
 */
function resolveNotifiedMoneySource(input: {
  readonly gatewayType: PaymentGatewayType;
  readonly rawPayload: Record<string, unknown>;
}): NotifiedMoneySourceInterface {
  switch (input.gatewayType) {
    case PaymentGatewayType.TELEGRAM_STARS: {
      // Bot API `SuccessfulPayment`/`RefundedPayment`: `total_amount` in the
      // smallest unit of `currency`. For XTR that unit IS one star, and our
      // invoice posts `prices[0].amount` unscaled, so no descaling applies —
      // unlike a fiat Telegram invoice, which would be in cents.
      const telegramPayment = resolveTelegramPaymentPayload(input.rawPayload);
      return {
        amount: readOptionalString(telegramPayment, ['total_amount']),
        currency: readOptionalString(telegramPayment, ['currency']),
      };
    }
    case PaymentGatewayType.YOOKASSA: {
      // `object.amount` is `{ value, currency }`, the same shape we post at
      // checkout and the shape the refund notifications carry.
      //
      // On a `refund.succeeded` this is the REFUNDED sum, not the sum paid —
      // the object is a Refund, which is exactly why `resolvePaymentId` and
      // `resolveEventStatus` both branch on it above. A consumer comparing
      // this against the booked amount must check `eventStatus` first, or
      // every partial refund reads as an amount mismatch.
      const yookassaAmount = readNestedObject(
        readNestedObject(input.rawPayload, 'object'),
        'amount',
      );
      return {
        amount: readOptionalString(yookassaAmount, ['value']),
        currency: readOptionalString(yookassaAmount, ['currency']),
      };
    }
    case PaymentGatewayType.HELEKET:
    case PaymentGatewayType.CRYPTOMUS:
      // `payment_amount` is what the buyer actually sent; `amount` is what we
      // invoiced. A mismatch check wants what ARRIVED, so `payment_amount`
      // wins and `amount` is the fallback for the bodies that omit it.
      //
      // `payer_amount`/`payer_currency` are the same money in the payer's own
      // coin and are deliberately NOT read: they pair with each other, and
      // pairing `payment_amount` with `payer_currency` would denominate a
      // settled sum in a ticker it was never expressed in.
      return {
        amount: readOptionalString(input.rawPayload, ['payment_amount', 'amount']),
        currency: readOptionalString(input.rawPayload, ['currency']),
      };
    case PaymentGatewayType.PLATEGA:
    case PaymentGatewayType.MULENPAY:
    case PaymentGatewayType.RIOPAY:
    case PaymentGatewayType.VALUTIX:
    case PaymentGatewayType.WATA:
    case PaymentGatewayType.AURAPAY:
    case PaymentGatewayType.LAVA:
      return {
        amount: readOptionalString(input.rawPayload, ['amount']),
        currency: readOptionalString(input.rawPayload, ['currency']),
      };
    case PaymentGatewayType.ROLLYPAY:
      // `payment_currency` is the name our checkout request uses; accept the
      // plain `currency` first in case the callback spells it either way.
      return {
        amount: readOptionalString(input.rawPayload, ['amount']),
        currency: readOptionalString(input.rawPayload, ['currency', 'payment_currency']),
      };
    case PaymentGatewayType.ANTILOPAY:
      // `original_amount` — «Сумма платежа, указанная при создании» — and NOT
      // `amount`, which Antilopay reports NET OF `fee`. Reading `amount` would
      // make every honest payment look short by the commission and fire a
      // mismatch alert on all of them; the alert holds entitlement back, so
      // the cost of that mistake is every Antilopay customer waiting on a
      // human.
      //
      // No fallback to `amount` for exactly that reason. A body without
      // `original_amount` yields nothing, which is a gap; falling back would
      // yield a confidently wrong number, which is a defect.
      return {
        amount: readOptionalString(input.rawPayload, ['original_amount']),
        currency: readOptionalString(input.rawPayload, ['currency']),
      };
    case PaymentGatewayType.OVERPAY: {
      // The same two shapes `resolvePaymentId` walks: card notifications nest
      // under `transaction`, the checkout-token one is flat with `order`.
      // Whichever carries the sum also carries its currency, so the container
      // is chosen once and both fields come out of it together.
      //
      // MINOR UNITS — our checkout posts `Math.round(amount * 100)` and
      // Overpay echoes the same scale back, so the raw field reads 1000 for a
      // 10.00 payment. Descaled here, not in the consumer: the unit is a fact
      // about this gateway, and a consumer unaware of it would see a 100×
      // mismatch on every Overpay payment.
      const overpayTransaction = readNestedObject(input.rawPayload, 'transaction');
      const overpayOrder = readNestedObject(input.rawPayload, 'order');
      const overpayMoney =
        readOptionalString(overpayTransaction, ['amount']) !== null
          ? overpayTransaction
          : readOptionalString(overpayOrder, ['amount']) !== null
            ? overpayOrder
            : input.rawPayload;
      return {
        amount: readOptionalString(overpayMoney, ['amount']),
        currency: readOptionalString(overpayMoney, ['currency']),
        minorUnitScale: 2,
      };
    }
    case PaymentGatewayType.PAYPALYCH:
      // Form fields, capitalised. `OutSum` is the sum actually paid and is
      // the field the md5 binds; `CurrencyIn` rides in the same body with
      // nothing authenticating it — see `SIGNED_CURRENCY_GATEWAYS`.
      return {
        amount: readOptionalString(input.rawPayload, ['OutSum']),
        currency: readOptionalString(input.rawPayload, ['CurrencyIn', 'Currency']),
      };
    case PaymentGatewayType.SEVERPAY: {
      // SeverPay wraps the event payload in `data: {...}` — flat on the
      // request we send, nested on the callback it sends back.
      const severpayData = readNestedObject(input.rawPayload, 'data');
      return {
        amount: readOptionalString(severpayData, ['amount']),
        currency: readOptionalString(severpayData, ['currency']),
      };
    }
    case PaymentGatewayType.CRYPTOPAY: {
      // The invoice sits under `payload`, and the coin ticker is `asset` —
      // CryptoPay has no `currency` field on the invoice.
      const cryptopayInvoice = readNestedObject(input.rawPayload, 'payload');
      return {
        amount: readOptionalString(cryptopayInvoice, ['amount']),
        currency: readOptionalString(cryptopayInvoice, ['asset']),
      };
    }
    default:
      return { amount: null, currency: null };
  }
}

/**
 * Applies typing and trust to whatever `resolveNotifiedMoneySource` found.
 *
 * Split from the per-gateway switch on purpose: "where is the field" is
 * knowledge about one provider, "what is it worth and how is it typed" is one
 * rule for all of them, and keeping the second in a single function is what
 * makes it impossible for a new gateway to be added with an amount but no
 * coverage answer.
 */
function buildNotifiedMoney(
  gatewayType: PaymentGatewayType,
  source: NotifiedMoneySourceInterface,
): NotifiedMoneyInterface {
  const amount = parseNotifiedAmount(source.amount, source.minorUnitScale ?? 0);
  return {
    ...(amount === null
      ? {}
      : {
          notifiedAmount: {
            value: amount,
            signatureCovered: SIGNED_AMOUNT_GATEWAYS.has(gatewayType),
          },
        }),
    ...(source.currency === null
      ? {}
      : {
          notifiedCurrency: {
            // Upper-cased to match our `Currency` enum: Antilopay and MulenPay
            // are invoiced in a lower-case `rub` and echo that spelling back, so
            // a consumer comparing raw strings would see a currency mismatch on
            // a perfectly correct notification.
            value: source.currency.toUpperCase(),
            signatureCovered: SIGNED_CURRENCY_GATEWAYS.has(gatewayType),
          },
        }),
  };
}

/**
 * Parses a provider's own amount string into the `Prisma.Decimal` the rest of
 * the codebase books money in.
 *
 * Never `number`: `Transaction.amount` is `Decimal(20, 8)`, and routing a
 * crypto sum through a float loses digits exactly where an equality check is
 * about to be run on it. Parsing at this boundary also means a provider that
 * sends something unparsable produces no amount at all, rather than a NaN that
 * would compare unequal to every booked sum and alert on every payment.
 */
function parseNotifiedAmount(
  rawAmount: string | null,
  minorUnitScale: number,
): Prisma.Decimal | null {
  if (rawAmount === null) {
    return null;
  }
  let parsedAmount: Prisma.Decimal;
  try {
    parsedAmount = new Prisma.Decimal(rawAmount);
  } catch {
    return null;
  }
  if (!parsedAmount.isFinite()) {
    return null;
  }
  return minorUnitScale === 0 ? parsedAmount : parsedAmount.div(10 ** minorUnitScale);
}

function parseWebhookPayload(
  rawBody: Buffer,
  gatewayType: PaymentGatewayType,
): Record<string, unknown> {
  // Pally posts its notification as `application/x-www-form-urlencoded`, not
  // JSON. Parsing it as JSON threw before signature verification even ran, so
  // no Pally payment could ever be confirmed. Parsed positionally by gateway
  // rather than by Content-Type: the header is attacker-supplied, the gateway
  // in the route is not.
  if (gatewayType === PaymentGatewayType.PAYPALYCH) {
    const form = new URLSearchParams(rawBody.toString('utf8'));
    const parsed: Record<string, unknown> = {};
    for (const [key, value] of form.entries()) {
      parsed[key] = value;
    }
    if (Object.keys(parsed).length === 0) {
      throw new BadRequestException(`PAYMENT_WEBHOOK_PAYLOAD_INVALID:${gatewayType}`);
    }
    return parsed;
  }
  try {
    const parsedPayload = JSON.parse(rawBody.toString('utf8')) as unknown;
    if (
      typeof parsedPayload !== 'object' ||
      parsedPayload === null ||
      Array.isArray(parsedPayload)
    ) {
      throw new BadRequestException('PAYMENT_WEBHOOK_PAYLOAD_INVALID');
    }
    return parsedPayload as Record<string, unknown>;
  } catch (error: unknown) {
    if (error instanceof BadRequestException) {
      throw error;
    }
    throw new BadRequestException(`PAYMENT_WEBHOOK_PAYLOAD_INVALID:${gatewayType}`);
  }
}

function resolveTelegramPaymentPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const message = readNestedObject(payload, 'message');
  const successfulPayment = readNestedObject(message, 'successful_payment');
  if (Object.keys(successfulPayment).length > 0) {
    return successfulPayment;
  }
  const refundedPayment = readNestedObject(message, 'refunded_payment');
  if (Object.keys(refundedPayment).length > 0) {
    return refundedPayment;
  }
  const standalonePayment = readNestedObject(payload, 'successful_payment');
  if (Object.keys(standalonePayment).length > 0) {
    return standalonePayment;
  }
  const standaloneRefund = readNestedObject(payload, 'refunded_payment');
  if (Object.keys(standaloneRefund).length > 0) {
    return standaloneRefund;
  }
  throw new BadRequestException('PAYMENT_WEBHOOK_PAYMENT_ID_MISSING');
}

function resolveTelegramPaymentStatus(payload: Record<string, unknown>): string {
  const message = readNestedObject(payload, 'message');
  if (Object.keys(readNestedObject(message, 'successful_payment')).length > 0) {
    return 'SUCCESSFUL_PAYMENT';
  }
  if (Object.keys(readNestedObject(message, 'refunded_payment')).length > 0) {
    return 'REFUNDED_PAYMENT';
  }
  if (Object.keys(readNestedObject(payload, 'successful_payment')).length > 0) {
    return 'SUCCESSFUL_PAYMENT';
  }
  if (Object.keys(readNestedObject(payload, 'refunded_payment')).length > 0) {
    return 'REFUNDED_PAYMENT';
  }
  return 'TELEGRAM_PAYMENT_UPDATE';
}

function verifyTelegramStarsSignature(
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const expectedSecret = readStringSetting(gatewaySettings, 'webhookSecret');
  const actualSecret = readHeader(headers, 'x-telegram-bot-api-secret-token');
  if (!expectedSecret || !actualSecret || !compareSecrets(actualSecret, expectedSecret)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

/**
 * YooKassa does not sign its notifications at all — the documented way to
 * authenticate one is its published source-IP list, so this check is the ONLY
 * thing standing between the internet and a forged "payment succeeded".
 */
function verifyYookassaSourceIp(clientIp: string | null): void {
  if (clientIp === null || !isTrustedYookassaIp(clientIp)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

export function isTrustedYookassaIp(clientIp: string): boolean {
  return isTrustedSourceIp(yookassaTrustedBlockList, clientIp);
}

/**
 * lava.top authenticates its webhook with a static `X-Api-Key` and nothing
 * else, so this runs *in addition to* that header check — see the LAVA case in
 * `verifySignature`.
 */
function verifyLavaSourceIp(clientIp: string | null): void {
  if (clientIp === null || !isTrustedLavaIp(clientIp)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

export function isTrustedLavaIp(clientIp: string): boolean {
  return isTrustedSourceIp(lavaTrustedBlockList, clientIp);
}

/**
 * The single place any source-IP pin is evaluated, because getting it wrong is
 * silent and total.
 *
 * `BlockList.check(address)` defaults to `type: 'ipv4'` and returns false for
 * anything that is not a plain dotted quad. Omitting the family disabled two
 * things at once for YooKassa: its own documented `2a02:5180::/32` range, and —
 * far worse — every notification whenever the listening socket is dual-stack,
 * because Express then reports an IPv4-mapped `::ffff:185.71.76.1` that no IPv4
 * check can match. The failure is in the safe direction (legitimate traffic
 * rejected, nothing forged accepted), but it means silently dropped payments.
 */
function isTrustedSourceIp(blockList: BlockList, clientIp: string): boolean {
  const family: 'ipv4' | 'ipv6' = clientIp.includes(':') ? 'ipv6' : 'ipv4';
  if (blockList.check(clientIp, family)) {
    return true;
  }
  // A dual-stack socket reports IPv4 peers in the mapped `::ffff:a.b.c.d` form.
  // Node matches those against IPv6 rules only, so unwrap and retry as IPv4
  // rather than widen the allowlist with mapped duplicates.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(clientIp);
  return mapped !== null && blockList.check(mapped[1]!, 'ipv4');
}

function verifyRiopaySignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const apiToken = readStringSetting(gatewaySettings, 'apiToken');
  const signature = readHeader(headers, 'x-signature');
  if (!apiToken || !signature) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
  const expected = createHmac('sha512', apiToken).update(rawBody).digest('hex');
  if (!compareSecrets(expected, signature)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

/**
 * Antilopay, Overpay and Wata each verify with an RSA public key the operator
 * pastes in from the provider's own documentation — and the three docs show
 * three different encodings: Antilopay's Node.js sample prints PEM, Wata serves
 * PKCS1 PEM from `GET /api/h2h/public-key`, Overpay documents bare base64 DER.
 *
 * Antilopay's branch used to accept DER only, so an operator who followed
 * Antilopay's documentation to the letter got a 403 on every callback: money
 * taken, the transaction stuck PENDING until the expiry sweep cancelled it.
 * One helper rather than a third copy of the same two-branch check.
 *
 * The `trim()` is defensive but deliberate — a key pasted from a doc page or
 * read out of a file carries a trailing newline, and the private-key side of
 * Antilopay has a documented failure from exactly that. Interior newlines are
 * untouched, so PEM line wrapping still parses.
 */
function createWebhookPublicKey(publicKey: string): KeyObject {
  const normalizedKey = publicKey.trim();
  return normalizedKey.includes('BEGIN')
    ? createPublicKey(normalizedKey)
    : createPublicKey({
        key: Buffer.from(normalizedKey, 'base64'),
        format: 'der',
        type: 'spki',
      });
}

/**
 * Antilopay: SHA256withRSA, base64, over the **raw body** (not a canonical
 * string), carried in `X-Apay-Callback` and checked against the merchant's
 * SPKI public key.
 */
function verifyAntilopaySignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  settings: Record<string, unknown>,
): void {
  const publicKey = readStringSetting(settings, 'publicKey');
  const signature = readHeader(headers, 'x-apay-callback');
  if (!publicKey || !signature) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
  try {
    const key = createWebhookPublicKey(publicKey);
    const verifier = createVerify('SHA256');
    verifier.update(rawBody);
    if (!verifier.verify(key, signature, 'base64')) {
      throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
    }
  } catch (error: unknown) {
    if (error instanceof ForbiddenException) throw error;
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

function verifyOverpaySignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  settings: Record<string, unknown>,
): void {
  const publicKey = readStringSetting(settings, 'publicKey');
  const signature = readHeader(headers, 'content-signature');
  if (!publicKey || !signature) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
  try {
    const key = createWebhookPublicKey(publicKey);
    const verifier = createVerify('SHA256');
    verifier.update(rawBody);
    if (!verifier.verify(key, signature, 'base64')) {
      throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
    }
  } catch (error: unknown) {
    if (error instanceof ForbiddenException) throw error;
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

/**
 * Pally (also sold as PayPalych / Pal24 — one service, one Bearer token).
 *
 * `SignatureValue = strtoupper(md5(OutSum + ":" + InvId + ":" + apiToken))`,
 * carried **in the form body**. The previous implementation computed an
 * HMAC-SHA256 over the raw body and looked for it in an `x-signature` header:
 * wrong algorithm, wrong input, wrong place, wrong case — nothing about it
 * could have matched. Note the secret is the API token itself; Pally has no
 * separate webhook secret.
 */
export function paypalychExpectedSignature(
  outSum: string,
  invId: string,
  apiToken: string,
): string {
  return createHash('md5').update(`${outSum}:${invId}:${apiToken}`).digest('hex').toUpperCase();
}

function verifyPaypalychSignature(
  rawPayload: Record<string, unknown>,
  settings: Record<string, unknown>,
): void {
  // The token doubles as the signing secret; accept either setting name so an
  // operator who filled in `apiKey` is not silently rejected.
  const secret =
    readStringSetting(settings, 'apiKey') ?? readStringSetting(settings, 'secretKey');
  const signature = readOptionalString(rawPayload, ['SignatureValue']);
  const outSum = readOptionalString(rawPayload, ['OutSum']);
  const invId = readOptionalString(rawPayload, ['InvId']);
  if (!secret || !signature || !outSum || !invId) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
  if (!compareSecrets(paypalychExpectedSignature(outSum, invId, secret), signature.toUpperCase())) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

/** Heleket is a Cryptomus fork; identical signature scheme. */
function verifyHeleketSignature(
  rawPayload: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  verifyCryptomusFamilySignature(rawPayload, headers, gatewaySettings);
}

function verifyPlategaHeaders(
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const expectedMerchantId = readStringSetting(gatewaySettings, 'merchantId');
  const expectedSecret = readStringSetting(gatewaySettings, 'secret');
  const actualMerchantId = readHeader(headers, 'x-merchantid');
  const actualSecret = readHeader(headers, 'x-secret');
  if (
    !expectedMerchantId ||
    !expectedSecret ||
    !actualMerchantId ||
    !actualSecret ||
    !compareSecrets(actualMerchantId, expectedMerchantId) ||
    !compareSecrets(actualSecret, expectedSecret)
  ) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

function verifyMulenPayHeaders(
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const expectedApiKey = readStringSetting(gatewaySettings, 'apiKey');
  const actualApiKey = readHeader(headers, 'x-api-key') ?? readHeader(headers, 'api-key');
  if (!expectedApiKey || !actualApiKey || !compareSecrets(actualApiKey, expectedApiKey)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

/**
 * Cryptomus and Heleket share one scheme (Heleket is a fork), so they share one
 * implementation here — they used to have two, and only one of them was right.
 *
 * `sign = md5( base64( json_encode(body without "sign") ) + apiKey )`, and the
 * signature travels **inside the body**, not in a header. Two traps:
 *
 *  - the `sign` field must be removed before hashing, otherwise the digest is
 *    taken over a document that includes the very value being checked;
 *  - the providers hash PHP's `json_encode` output, which escapes forward
 *    slashes as `\/`. `JSON.stringify` does not. Both docs call this out
 *    explicitly. Non-ASCII is safe — they pass `JSON_UNESCAPED_UNICODE`, which
 *    matches `JSON.stringify`.
 */
function verifyCryptomusFamilySignature(
  rawPayload: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const secret = readStringSetting(gatewaySettings, 'apiKey');
  const signature =
    readOptionalString(rawPayload, ['sign', 'signature']) ??
    readHeader(headers, 'sign') ??
    readHeader(headers, 'x-signature');
  if (!secret || !signature) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
  const candidates = cryptomusFamilySignatureCandidates(rawPayload, secret);
  if (!candidates.some((candidate) => compareSecrets(candidate, signature))) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

export function cryptomusFamilySignatureCandidates(
  rawPayload: Record<string, unknown>,
  secret: string,
): readonly string[] {
  const withoutSign = Object.fromEntries(
    Object.entries(rawPayload).filter(([key]) => key !== 'sign' && key !== 'signature'),
  );
  const serialized = JSON.stringify(withoutSign);
  const digest = (body: string): string =>
    createHash('md5').update(`${Buffer.from(body, 'utf8').toString('base64')}${secret}`).digest('hex');
  return [
    // Documented form: PHP-style escaped slashes.
    digest(serialized.replace(/\//g, '\\/')),
    // Tolerated: a payload with no slashes produces the same string either way,
    // and this keeps us working if a provider ever stops escaping.
    digest(serialized),
  ];
}

/**
 * Wata signs webhooks with **SHA512withRSA**, base64, in `X-Signature`, over the
 * raw body — verified with the merchant's PUBLIC key from
 * `GET /api/h2h/public-key` (PKCS1). There is no shared secret; the previous
 * HMAC-SHA256 with a `webhookSecret` matched nothing Wata offers, and could
 * never have passed.
 *
 * Getting this wrong is worse here than elsewhere: Wata's pre-payment webhook
 * expects a 200 within 10 seconds and treats anything else as a refusal — the
 * transaction is declined before the bank is even asked. A rejected signature
 * does not merely lose a notification, it kills the payment.
 */
function verifyWataSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const publicKey = readStringSetting(gatewaySettings, 'publicKey');
  const signature = readHeader(headers, 'x-signature') ?? readHeader(headers, 'x-wata-signature');
  if (!publicKey || !signature) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
  try {
    // PKCS1 ("BEGIN RSA PUBLIC KEY") is what Wata publishes; the shared helper
    // also takes SPKI PEM and bare base64 DER, so any pasted form works.
    const key = createWebhookPublicKey(publicKey);
    const verifier = createVerify('SHA512');
    verifier.update(rawBody);
    if (!verifier.verify(key, signature, 'base64')) {
      throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
    }
  } catch (error: unknown) {
    if (error instanceof ForbiddenException) throw error;
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

/**
 * Valutix: HMAC-SHA512 of the raw request body keyed by the gateway's
 * `apiToken`, hex-encoded. Header: `X-Signature`. Verified strictly — a
 * missing header or a mismatch is rejected.
 *
 * RioPay documents the identical scheme and `verifyRiopaySignature` enforces
 * it just as strictly. This note used to claim the opposite — that RIOPAY
 * defined no signature scheme and stayed permissive — which invited
 * "reconciling" that working check by loosening it. Neither may be relaxed.
 */
function verifyValutixSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const secret = readStringSetting(gatewaySettings, 'apiToken');
  const signature = readHeader(headers, 'x-signature');
  if (!secret || !signature) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
  const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
  if (!compareSecrets(expected, signature)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

/**
 * AuraPay: HMAC-SHA256 of the JSON values concatenated in alphabetical key
 * order, signed with secret key #2. Hex-encoded. Header: `X-SIGNATURE`.
 *
 * The `sign` field, if present in the payload, must be excluded from the
 * concatenation. AuraPay docs use HMAC-SHA256 + ksort (PHP-style).
 */
function verifyAurapaySignature(
  rawPayload: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const secret = readStringSetting(gatewaySettings, 'secretKey');
  const signature = readHeader(headers, 'x-signature');
  if (!secret || !signature) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }

  const sortedKeys = Object.keys(rawPayload)
    .filter((key) => key !== 'sign' && key !== 'signature')
    .sort();
  const concatenated = sortedKeys.map((key) => stringifyAurapayValue(rawPayload[key])).join('');
  const expected = createHmac('sha256', secret).update(concatenated).digest('hex');
  if (!compareSecrets(expected, signature)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

function stringifyAurapayValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  // Nested objects/arrays — serialize as JSON to match PHP's implode behavior
  // when those values are not scalars; AuraPay docs only show flat payloads.
  return JSON.stringify(value);
}

/**
 * RollyPay: HMAC-SHA256 of `${timestamp}.${rawBody}` with signing_secret.
 * Headers: `X-Signature` (hex) + `X-Timestamp` (Unix timestamp).
 */
function verifyRollypaySignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const secret = readStringSetting(gatewaySettings, 'signingSecret');
  const signature = readHeader(headers, 'x-signature');
  const timestamp = readHeader(headers, 'x-timestamp');
  if (!secret || !signature || !timestamp) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }

  const hmac = createHmac('sha256', secret);
  hmac.update(timestamp);
  hmac.update('.');
  hmac.update(rawBody);
  const expected = hmac.digest('hex');
  if (!compareSecrets(expected, signature)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

/**
 * SeverPay: HMAC-SHA256 of the JSON-encoded payload (with the `sign` key
 * removed) using the merchant's secretToken. The signature is delivered
 * **inside the body** as the `sign` field (not a header).
 *
 * SeverPay's PHP example uses `json_encode($input)` after `unset($input['sign'])`,
 * so we re-serialize with the same key order as Node's default (insertion order).
 */
function verifySeverpaySignature(
  rawPayload: Record<string, unknown>,
  gatewaySettings: Record<string, unknown>,
): void {
  const secret = readStringSetting(gatewaySettings, 'secretToken');
  const signature = readOptionalString(rawPayload, ['sign', 'signature']);
  if (!secret || !signature) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawPayload)) {
    if (key !== 'sign' && key !== 'signature') {
      cleaned[key] = value;
    }
  }
  const expected = createHmac('sha256', secret).update(JSON.stringify(cleaned)).digest('hex');
  if (!compareSecrets(expected, signature)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

/**
 * lava.top: webhook is authenticated by a static `X-Api-Key` header that
 * matches a key the merchant pre-registered with lava.top (see "Authorize
 * the recipient" in the developer portal). No payload signature.
 */
function verifyLavaApiKey(
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const expected = readStringSetting(gatewaySettings, 'webhookApiKey');
  const actual = readHeader(headers, 'x-api-key');
  if (!expected || !actual || !compareSecrets(actual, expected)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

/**
 * CryptoPay (@CryptoBot): the `crypto-pay-api-signature` header is the hex
 * HMAC-SHA256 of the raw (unparsed) JSON body, signed with a secret that is
 * the SHA256 digest of the app's API token. Mirrors the official check in
 * the Crypto Pay API docs.
 */
function verifyCryptopaySignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  gatewaySettings: Record<string, unknown>,
): void {
  const apiToken = readStringSetting(gatewaySettings, 'apiToken');
  const signature = readHeader(headers, 'crypto-pay-api-signature');
  if (!apiToken || !signature) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
  const secret = createHash('sha256').update(apiToken).digest();
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!compareSecrets(expected, signature)) {
    throw new ForbiddenException('PAYMENT_WEBHOOK_SIGNATURE_INVALID');
  }
}

function createTrustedBlockList(networks: readonly string[]): BlockList {
  const blockList = new BlockList();
  for (const network of networks) {
    const [address, prefix] = network.split('/');
    if (!address) {
      continue;
    }
    const family: 'ipv4' | 'ipv6' = address.includes(':') ? 'ipv6' : 'ipv4';
    // A bare address means a single host. Insisting on an explicit `/32` was
    // safe while every entry was a hard-coded constant, but it becomes a trap
    // once the list is operator-supplied: writing the plain address a provider
    // publishes would silently produce an empty allowlist, and an empty
    // allowlist rejects every notification.
    blockList.addSubnet(address, prefix ? Number(prefix) : hostPrefixLength(family), family);
  }
  return blockList;
}

function hostPrefixLength(family: 'ipv4' | 'ipv6'): number {
  return family === 'ipv6' ? 128 : 32;
}

/**
 * Reads the configured lava.top allowlist, falling back to the published
 * address.
 *
 * A malformed override discards the *whole* override rather than applying the
 * entries that happened to parse: a half-applied allowlist drops the addresses
 * that failed without saying so, and a dropped address here is a payment that
 * never completes. Falling back to the documented default keeps the gateway
 * working while the typo is visible in the env file.
 */
export function resolveLavaTrustedNetworks(rawValue: string | undefined): readonly string[] {
  const entries = (rawValue ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0 || !entries.every(isParsableNetwork)) {
    return LAVA_DEFAULT_NOTIFICATION_NETWORKS;
  }
  return entries;
}

function isParsableNetwork(network: string): boolean {
  const parts = network.split('/');
  if (parts.length > 2) {
    return false;
  }
  const addressFamily = isIP(parts[0] ?? '');
  if (addressFamily === 0) {
    return false;
  }
  if (parts[1] === undefined) {
    return true;
  }
  // `/0` matches the whole internet, which is never a deliberate entry in a
  // payment source pin — and a blank prefix (`1.2.3.4/`) coerces straight to it.
  // Both are malformed here, so they discard the override instead of widening it.
  const prefix = Number(parts[1]);
  return (
    parts[1].length > 0 &&
    Number.isInteger(prefix) &&
    prefix >= 1 &&
    prefix <= hostPrefixLength(addressFamily === 6 ? 'ipv6' : 'ipv4')
  );
}

function readNestedObject(
  value: Record<string, unknown>,
  propertyName: string,
): Record<string, unknown> {
  const propertyValue = value[propertyName];
  if (typeof propertyValue !== 'object' || propertyValue === null || Array.isArray(propertyValue)) {
    return {};
  }
  return propertyValue as Record<string, unknown>;
}

function readRequiredString(
  value: Record<string, unknown>,
  propertyNames: readonly string[],
  errorCode: string,
): string {
  const resolvedValue = readOptionalString(value, propertyNames);
  if (!resolvedValue) {
    throw new BadRequestException(errorCode);
  }
  return resolvedValue;
}

/**
 * True for a YooKassa `refund.succeeded` notification. Refund notifications
 * carry the Refund object (with `payment_id`) rather than a Payment object, so
 * both the payment-id resolution and the event status branch specially.
 */
function isYookassaRefundEvent(rawPayload: Record<string, unknown>): boolean {
  return readOptionalString(rawPayload, ['event']) === 'refund.succeeded';
}

function readOptionalString(
  value: Record<string, unknown>,
  propertyNames: readonly string[],
): string | null {
  for (const propertyName of propertyNames) {
    const propertyValue = value[propertyName];
    if (typeof propertyValue === 'string' && propertyValue.trim().length > 0) {
      return propertyValue.trim();
    }
    if (typeof propertyValue === 'number' && Number.isFinite(propertyValue)) {
      return String(propertyValue);
    }
  }
  return null;
}

function readStringSetting(settings: Record<string, unknown>, propertyName: string): string | null {
  const propertyValue = settings[propertyName];
  return typeof propertyValue === 'string' && propertyValue.trim().length > 0
    ? propertyValue.trim()
    : null;
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  headerName: string,
): string | null {
  const directHeader = headers[headerName];
  if (typeof directHeader === 'string' && directHeader.trim().length > 0) {
    return directHeader.trim();
  }
  const normalizedHeader = headers[headerName.toLowerCase()];
  if (typeof normalizedHeader === 'string' && normalizedHeader.trim().length > 0) {
    return normalizedHeader.trim();
  }
  if (Array.isArray(normalizedHeader) && typeof normalizedHeader[0] === 'string') {
    return normalizedHeader[0].trim();
  }
  return null;
}

function compareSecrets(actualValue: string, expectedValue: string): boolean {
  const actualBuffer = Buffer.from(actualValue);
  const expectedBuffer = Buffer.from(expectedValue);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
