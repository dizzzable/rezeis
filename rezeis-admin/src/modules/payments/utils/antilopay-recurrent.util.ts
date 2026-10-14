import { ProviderSubscriptionStatus } from '@prisma/client';

import { type AntilopayRefund, readAntilopayRefunds } from './antilopay-refund.util';
import {
  ANTILOPAY_DELAY_UNITS,
  antilopayDelayUnitDays,
  type AntilopayDelayUnit,
  antilopayRecurrentTypeFor,
  type ProviderPeriod,
} from './provider-subscription-period.util';

/**
 * Antilopay's repeat charges (documentation 1.51, «Создание платежа» →
 * `recurrent`, «Статус рекуррентного платежа», «Отмена рекуррентного платежа»).
 *
 * Antilopay runs the schedule itself, like Platega and RollyPay: the payer
 * confirms one sum and one period, and Antilopay charges on its own. There is
 * no call to charge an arbitrary sum at an arbitrary time.
 *
 * Two ways to sign a payer up, chosen by the payer BEFORE the payment form
 * opens (the categories are tied to a method, not to a choice on the form):
 *   - CARD: `category: PAYMENT_TEMPLATE`, cards only. The first payment is
 *     made on Antilopay's form, and Antilopay charges the card on schedule
 *     after it.
 *   - SBP: `category: SUBSCRIPTION`, SBP only. The payer subscribes on the
 *     form; with `delay: 0` the first charge is made at activation, and with
 *     the operator's «Отсрочка первого списания по СБП» (`AntilopayDelay`) it
 *     is made after the delay, the payer holding the plan meanwhile.
 */
export type AntilopayAutopayMethod = 'CARD' | 'SBP';

export const ANTILOPAY_AUTOPAY_METHODS: readonly AntilopayAutopayMethod[] = ['CARD', 'SBP'];

export function isAntilopayAutopayMethod(value: unknown): value is AntilopayAutopayMethod {
  return value === 'CARD' || value === 'SBP';
}

/**
 * The operator's optional setting «Число списаний (вместе с первым)»: sent as
 * `recurrent.payment_count` only when set. The documentation calls the field
 * optional and does not say what an absent one means; an operator who wants a
 * fixed number of charges sets it, and nobody is sent a number they did not
 * choose.
 */
export const ANTILOPAY_PAYMENT_COUNT_SETTING = 'recurrentPaymentCount';

/** «Число списаний (вместе с первым)»: a whole number, at least 2, or null. */
export function readAntilopayPaymentCount(settings: Record<string, unknown>): number | null {
  const raw = settings[ANTILOPAY_PAYMENT_COUNT_SETTING];
  const value = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 2 ? value : null;
}

/**
 * «Отсрочка первого списания по СБП»: how long an SBP subscription waits before
 * its first charge (`recurrent.delay` × `recurrent.delay_type`). Only SBP has
 * one: «параметр category - SUBSCRIPTION работает только с СБП платежами, а
 * PAYMENT_TEMPLATE - только с картами», and only SUBSCRIPTION takes a delay, so
 * a card's first payment is always charged on the form.
 */
// A type alias, not an interface: it is stored in the draft's JSON snapshot, and
// only an alias is assignable to what a JSON column takes.
export type AntilopayDelay = {
  readonly count: number;
  /** The wire word, upper-case: `DAY`, `WEEK`, `MONTH`, `QUARTER` or `YEAR`. */
  readonly unit: AntilopayDelayUnit;
  /** The days the delay is worth: what the payer is given for it (`antilopayDelayUnitDays`). */
  readonly days: number;
};

/** The operator's two settings that make a delay: a whole number, and a unit. */
export const ANTILOPAY_DELAY_COUNT_SETTING = 'sbpDelayCount';
export const ANTILOPAY_DELAY_UNIT_SETTING = 'sbpDelayUnit';

/**
 * The longest delay the panel will give away: a year. A typo (a quarter typed
 * as 90 quarters) would otherwise grant years of free access to every first-time
 * payer; the settings refuse it when saved and this reads it as no delay.
 */
export const ANTILOPAY_MAX_DELAY_DAYS = 366;

export function isAntilopayDelayUnit(value: unknown): value is AntilopayDelayUnit {
  // Case-sensitive on purpose: the wire value is `DAY`, never `day`.
  return typeof value === 'string' && (ANTILOPAY_DELAY_UNITS as readonly string[]).includes(value);
}

/** A delay of `count` × `unit`, or null when it is none, or longer than {@link ANTILOPAY_MAX_DELAY_DAYS}. */
export function makeAntilopayDelay(count: unknown, unit: unknown): AntilopayDelay | null {
  if (!isAntilopayDelayUnit(unit)) return null;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) return null;
  const days = count * antilopayDelayUnitDays(unit);
  return days > ANTILOPAY_MAX_DELAY_DAYS ? null : { count, unit, days };
}

/**
 * «Отсрочка первого списания по СБП» as the operator stored it, or null for
 * none: empty, 0, a unit that is not one of the five (a lower-case `day` is not
 * one), or a delay past the cap. Null is today's behaviour: the first charge is
 * made at activation.
 */
export function readAntilopayDelay(settings: Record<string, unknown>): AntilopayDelay | null {
  const raw = settings[ANTILOPAY_DELAY_COUNT_SETTING];
  const count = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return makeAntilopayDelay(count, settings[ANTILOPAY_DELAY_UNIT_SETTING]);
}

/** What `payment/create` is sent to make a payment the start of a subscription. */
export interface AntilopayRecurrentRequest {
  readonly recurrent: Readonly<Record<string, unknown>>;
  /** `prefer_methods`: keeps the form on the method the category works with. */
  readonly preferMethods: readonly string[];
}

/**
 * The `recurrent` object and `prefer_methods` for a sign-up, or null when the
 * period is not one of Antilopay's. Nothing else is decided here: the sum is
 * the payment's own `amount`, the same every period.
 */
export function buildAntilopayRecurrent(input: {
  readonly period: ProviderPeriod;
  readonly method: AntilopayAutopayMethod;
  readonly paymentCount: number | null;
  /** SBP only; a card has none. Absent or null: the first charge is made at activation. */
  readonly delay?: AntilopayDelay | null;
}): AntilopayRecurrentRequest | null {
  const type = antilopayRecurrentTypeFor(input.period);
  if (type === null) return null;
  const count = input.paymentCount === null ? {} : { payment_count: input.paymentCount };
  if (input.method === 'CARD') {
    return {
      recurrent: { type, category: 'PAYMENT_TEMPLATE', ...count },
      preferMethods: ['CARD_RU'],
    };
  }
  // «Можно указать 0 чтобы сразу при активации произвести списание»: the first
  // charge is made when the subscription is activated. `delay_type` is the
  // period's own unit, so a delay of 0 reads the same whichever is meant.
  // With the operator's delay, nothing is charged at activation: the first
  // charge comes after `delay` × `delay_type`, and `delay_type` is the delay's
  // own word (`DAY`, which a charging period never is).
  const delay = input.delay ?? null;
  return {
    recurrent: {
      type,
      category: 'SUBSCRIPTION',
      delay: delay === null ? 0 : delay.count,
      delay_type: delay === null ? type : delay.unit,
      ...count,
    },
    preferMethods: ['SBP'],
  };
}

/**
 * Antilopay's `status` of a recurrent, in the panel's own words. An unknown
 * word maps to null and is never read as a cancellation (the caller logs it).
 *
 *   CREATED, WAIT_CONFIRM      the payer has not paid, or the payment awaits
 *                              its provider: PENDING
 *   ACTIVE, PROCESSING         charging: ACTIVE
 *   ACTIVE_FAILED              charging, and the last attempt failed: PAST_DUE
 *   COMPLETE                   the plan of charges ran out
 *   CANCEL, PROVIDER_CANCEL    cancelled by us / by Antilopay
 *   ERROR                      ended after several failed charges in a row
 *
 * The last four are ended: CANCELLED. Who ended it is the caller's to say.
 */
export function mapAntilopayRecurrentStatus(value: string | null): ProviderSubscriptionStatus | null {
  switch ((value ?? '').trim().toUpperCase()) {
    case 'CREATED':
    case 'WAIT_CONFIRM':
      return ProviderSubscriptionStatus.PENDING;
    case 'ACTIVE':
    case 'PROCESSING':
      return ProviderSubscriptionStatus.ACTIVE;
    case 'ACTIVE_FAILED':
      return ProviderSubscriptionStatus.PAST_DUE;
    case 'COMPLETE':
    case 'CANCEL':
    case 'PROVIDER_CANCEL':
    case 'ERROR':
      return ProviderSubscriptionStatus.CANCELLED;
    default:
      return null;
  }
}

/** The recurrent statuses that mean nothing will be charged any more. */
export function isAntilopayRecurrentEnded(value: string | null): boolean {
  return mapAntilopayRecurrentStatus(value) === ProviderSubscriptionStatus.CANCELLED;
}

/** The recurrent statuses of an autopay whose payer has not activated it yet. */
export function isAntilopayRecurrentNotActiveYet(value: string | null): boolean {
  return mapAntilopayRecurrentStatus(value) === ProviderSubscriptionStatus.PENDING;
}

/** One payment of a recurrent that money moved for, as `payments[]` lists it. */
export interface AntilopayCharge {
  /** Antilopay's `payment_id`: the key of the charge, never its position. */
  readonly id: string;
  /**
   * The payment's `order_id`: OUR order for the sign-up's own first payment,
   * Antilopay's own for a charge it makes on schedule. What tells the two apart,
   * where the position in the list cannot.
   */
  readonly orderId: string | null;
  readonly at: Date | null;
  /** SUCCESS, or CHARGEBACK / REVERSED: taken, and then given back. */
  readonly providerStatus: string;
  /** Given back after it was taken (CHARGEBACK, REVERSED). */
  readonly disputed: boolean;
  /** `original_amount`, the sum the charge was made for; null when not reported. */
  readonly amount: string | null;
  /** Refunds listed beside it (`refunds[]`): money given back after the day of the payment. */
  readonly refunds: readonly AntilopayRefund[];
}

export interface AntilopayRecurrentState {
  readonly status: ProviderSubscriptionStatus | null;
  /** Antilopay's own word, as read. */
  readonly providerStatus: string | null;
  /** `count`: how many charges are planned in all. */
  readonly plannedChargeCount: number | null;
  readonly nextChargeAt: Date | null;
  /** `end_date`: the end of the plan of charges. */
  readonly endsAt: Date | null;
  /**
   * Payments money moved for, oldest first. A payment that is pending or failed
   * is not here: nothing was taken, and if it succeeds later it appears then.
   */
  readonly charges: readonly AntilopayCharge[];
}

const TAKEN_PAYMENT_STATUSES: ReadonlySet<string> = new Set(['SUCCESS', 'CHARGEBACK', 'REVERSED']);
const DISPUTED_PAYMENT_STATUSES: ReadonlySet<string> = new Set(['CHARGEBACK', 'REVERSED']);

/** `payment/recurrent/check`'s body (`code` already read as 0). */
export function parseAntilopayRecurrent(data: Record<string, unknown>): AntilopayRecurrentState {
  const providerStatus = readText(data['status']);
  const payments = Array.isArray(data['payments']) ? (data['payments'] as unknown[]) : [];
  const seen = new Set<string>();
  const taken: Array<{ readonly charge: AntilopayCharge; readonly index: number }> = [];
  payments.forEach((entry, index) => {
    const payment = asRecord(entry);
    const id = readText(payment['payment_id']);
    const status = readText(payment['status'])?.toUpperCase() ?? null;
    if (id === null || status === null || !TAKEN_PAYMENT_STATUSES.has(status) || seen.has(id)) return;
    seen.add(id);
    taken.push({
      charge: {
        id,
        orderId: readText(payment['order_id']),
        at: readTimestamp(payment['ctime']),
        providerStatus: status,
        disputed: DISPUTED_PAYMENT_STATUSES.has(status),
        amount: readAmountText(payment['original_amount']),
        refunds: readAntilopayRefunds(payment['refunds']),
      },
      index,
    });
  });
  taken.sort((left, right) => {
    const leftAt = left.charge.at;
    const rightAt = right.charge.at;
    if (leftAt !== null && rightAt !== null && leftAt.getTime() !== rightAt.getTime()) {
      return leftAt.getTime() - rightAt.getTime();
    }
    return left.index - right.index;
  });
  return {
    status: mapAntilopayRecurrentStatus(providerStatus),
    providerStatus,
    plannedChargeCount: readCount(data['count']),
    nextChargeAt: readDay(data['next_payment_date']),
    endsAt: readDay(data['end_date']),
    charges: taken.map((entry) => entry.charge),
  };
}

/**
 * What a charge of a recurrent IS to the panel: the payment that completes the
 * sign-up's checkout, one that renews a term, or the start of an SBP
 * subscription that is not a charge at all.
 */
export type AntilopayChargeRole = 'FIRST' | 'START' | 'RENEW';

/**
 * How far after the start of an SBP subscription the charge made at activation
 * may come and still be that charge. Its shortest period is a week, so no
 * scheduled charge is ever this close to the start.
 */
export const ANTILOPAY_ACTIVATION_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** `ctime` names no zone: a sign-up's own time is compared with it only this loosely. */
const ANTILOPAY_CLOCK_SLACK_MS = 12 * 60 * 60 * 1000;

/**
 * Which charge completes the first payment of a sign-up, and which renew — by
 * WHAT each charge is, never by where it stands in the list.
 *
 * A charge is the sign-up's START when it is the initiating payment
 * (`payment_id` is the id `payment/create` answered with) or the payment of
 * OUR order (`order_id` is the first transaction's payment id). By position the
 * first listed charge was taken for it, and two lists broke that: one without
 * the initiating payment gave the first SCHEDULED charge to the checkout that
 * was already delivered (charged, and nothing renewed), and, for SBP, one with
 * the start listed as SUCCESS bought the first term with a start and the second
 * with the charge made at activation.
 *
 *  - CARD (`PAYMENT_TEMPLATE`): the start is the first payment, money moved.
 *    It is FIRST; every other charge, however close, renews under its own id.
 *  - SBP (`SUBSCRIPTION`): the start may be no more than the start of the
 *    subscription («Нельзя сделать возврат у начала подписки»), and the first
 *    charge is a separate payment made at activation (`delay: 0`). A charge
 *    within {@link ANTILOPAY_ACTIVATION_WINDOW_MS} of the start (of the
 *    sign-up, when the start is not listed) is that charge: it is FIRST and
 *    the start is not counted. When there is none, the start is FIRST.
 *
 * Last resort: with no FIRST and the first transaction not yet delivered, the
 * earliest charge is given to it — money was taken and nothing else can
 * deliver it, and a renewal would wait for a delivery that never comes.
 *
 * A DELAYED SBP subscription (`delayed`) has no charge at activation, and the
 * first transaction is the access it grants for the delay, not a charge: the
 * start is never FIRST, and every charge that is not the start renews — a
 * weekly subscription with a one-day delay charges within the window above,
 * and that charge is the first renewal, not the checkout.
 */
export function assignAntilopayChargeRoles(input: {
  readonly charges: readonly AntilopayCharge[];
  readonly providerSubscriptionId: string;
  readonly firstOrderId: string | null;
  readonly method: string | null;
  readonly signedUpAt: Date;
  readonly firstDelivered: boolean;
  readonly delayed?: boolean;
}): ReadonlyMap<string, AntilopayChargeRole> {
  const isStart = (charge: AntilopayCharge): boolean =>
    charge.id === input.providerSubscriptionId ||
    (input.firstOrderId !== null && charge.orderId === input.firstOrderId);
  if (input.delayed === true) {
    return new Map(input.charges.map((charge) => [charge.id, isStart(charge) ? 'START' : 'RENEW'] as const));
  }
  const start = input.charges.find(isStart) ?? null;
  let first: AntilopayCharge | null = start;
  let startIsNotACharge = false;
  if (input.method === 'SBP') {
    const anchor = (start?.at ?? input.signedUpAt).getTime();
    const activation = input.charges.find(
      (charge) =>
        !isStart(charge) &&
        !charge.disputed &&
        charge.at !== null &&
        charge.at.getTime() >= anchor - ANTILOPAY_CLOCK_SLACK_MS &&
        charge.at.getTime() <= anchor + ANTILOPAY_ACTIVATION_WINDOW_MS,
    );
    if (activation !== undefined) {
      first = activation;
      startIsNotACharge = start !== null;
    }
  }
  if (first === null && !input.firstDelivered) {
    first = input.charges.find((charge) => !charge.disputed) ?? null;
  }
  const roles = new Map<string, AntilopayChargeRole>();
  for (const charge of input.charges) {
    roles.set(
      charge.id,
      charge.id === first?.id ? 'FIRST' : startIsNotACharge && charge.id === start?.id ? 'START' : 'RENEW',
    );
  }
  return roles;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readCount(value: unknown): number | null {
  const parsed = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function readAmountText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()) ? value.trim() : null;
}

/** `YYYY-MM-DD`, read as that day at 00:00 UTC. Anything else is null. */
function readDay(value: unknown): Date | null {
  const text = readText(value);
  if (text === null || !/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  const parsed = new Date(`${text.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** `2025-07-20 14:30:00.123456`, read as UTC. Only the order of payments and the date depend on it. */
function readTimestamp(value: unknown): Date | null {
  const text = readText(value);
  if (text === null) return null;
  const parsed = new Date(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
