import { createHash, randomUUID } from 'node:crypto';

import { ProviderSubscriptionStatus } from '@prisma/client';

import { type ProviderPeriod, rollypayIntervalFor } from './provider-subscription-period.util';

/**
 * RollyPay's recurring SBP subscriptions (docs.rollypay.io/api/recurring).
 *
 * RollyPay sets the tariffs up for a kassa itself; a merchant cannot create
 * one through the API. So the operator names, in the gateway's settings, the
 * kassa and the tariffs RollyPay made for it, and a sign-up picks among those
 * the one whose period and sum are what the payer was shown.
 */
export const ROLLYPAY_API = 'https://rollypay.io/api/v1';

/** The kassa's UUID; tariffs are listed and subscriptions created under it. */
export const ROLLYPAY_TERMINAL_SETTING = 'terminalId';
/** The tariff UUIDs a sign-up may use, as the operator typed them. */
export const ROLLYPAY_PLAN_IDS_SETTING = 'subscriptionPlanIds';

/**
 * `GET /subscriptions/{id}/charges` returns «до 100 последних записей». A
 * subscription with at least this many has older charges out of sight, and
 * its count of paid cycles then comes from `successful_cycles`.
 */
export const ROLLYPAY_CHARGES_PAGE = 100;

/**
 * A payment's final states that mean the money was taken. A refund or a
 * chargeback afterwards is the refund's business: a charge is delivered in
 * order, so one skipped here would shift every later one onto the wrong key.
 */
export const ROLLYPAY_TAKEN_PAYMENT_STATUSES: ReadonlySet<string> = new Set(['paid', 'refunded', 'chargeback']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function rollypayHeaders(apiKey: string): Record<string, string> {
  // A fresh nonce on every request, retries included: RollyPay refuses a reused one.
  return { 'X-API-Key': apiKey, 'X-Nonce': randomUUID() };
}

export function readRollypayTerminalId(settings: Record<string, unknown>): string | null {
  const value = settings[ROLLYPAY_TERMINAL_SETTING];
  return typeof value === 'string' && UUID.test(value.trim()) ? value.trim().toLowerCase() : null;
}

/** The operator's tariff UUIDs, in the order typed; anything that is not a UUID is dropped. */
export function readRollypayPlanIds(settings: Record<string, unknown>): readonly string[] {
  const value = settings[ROLLYPAY_PLAN_IDS_SETTING];
  if (typeof value !== 'string') return [];
  const ids = value
    .split(/[\s,;]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => UUID.test(token));
  return [...new Set(ids)];
}

/**
 * The stable payer id RollyPay asks for (up to 32 bytes, ASCII advised). Our
 * user ids do not fit, and a Telegram id is not something every customer has,
 * so it is a digest of the user id: the same payer every time, and nothing
 * about them sent out.
 */
export function rollypayPayerId(userId: string): string {
  return `rz${createHash('sha256').update(userId).digest('hex').slice(0, 30)}`;
}

/** A RollyPay rouble sum («150.00») in kopecks, or null. */
export function rollypayKopecks(value: unknown): number | null {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string') return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (match === null) return null;
  const whole = Number.parseInt(match[1] as string, 10);
  const fraction = Number.parseInt((match[2] ?? '0').padEnd(2, '0'), 10);
  const total = whole * 100 + fraction;
  return Number.isSafeInteger(total) ? total : null;
}

export interface RollypayPlan {
  readonly id: string;
  readonly interval: string | null;
  /** What each charge takes from the payer, in kopecks; null on a tariff with a cap instead. */
  readonly payerKopecks: number | null;
  /** The most a sign-up may fix as its sum, in kopecks; null on a fixed tariff. */
  readonly capKopecks: number | null;
}

/** `GET /subscription-plans?terminal_id=…` → its `items`. */
export function parseRollypayPlans(data: unknown): readonly RollypayPlan[] {
  const items = asRecord(data)['items'];
  if (!Array.isArray(items)) return [];
  const plans: RollypayPlan[] = [];
  for (const item of items) {
    const plan = asRecord(item);
    const id = plan['id'];
    if (typeof id !== 'string' || !UUID.test(id)) continue;
    plans.push({
      id: id.toLowerCase(),
      interval: typeof plan['interval'] === 'string' ? plan['interval'] : null,
      payerKopecks: rollypayKopecks(plan['payer_amount_rub']),
      capKopecks: rollypayKopecks(plan['cap_amount_rub']),
    });
  }
  return plans;
}

/**
 * The tariff a sign-up for `amount` roubles every `period` goes on, or null
 * when the operator named none that fits.
 *
 * A fixed tariff fits when it charges exactly the price the payer was shown
 * («Не вычисляйте итоговое списание самостоятельно»: its `payer_amount_rub`
 * is the sum, a commission on the payer included). A tariff with a cap fits
 * any price up to the cap, and the price is fixed on the subscription. A
 * fixed one wins, then the operator's own order.
 */
export function pickRollypayPlan(
  plans: readonly RollypayPlan[],
  allowedIds: readonly string[],
  period: ProviderPeriod,
  amount: number,
): RollypayPlan | null {
  const interval = rollypayIntervalFor(period);
  if (interval === null) return null;
  const wanted = amount * 100;
  const usable = plans
    .filter((plan) => allowedIds.includes(plan.id) && plan.interval === interval)
    .sort((left, right) => allowedIds.indexOf(left.id) - allowedIds.indexOf(right.id));
  return (
    usable.find((plan) => plan.capKopecks === null && plan.payerKopecks === wanted) ??
    usable.find((plan) => plan.capKopecks !== null && wanted <= plan.capKopecks) ??
    null
  );
}

export interface RollypayCharge {
  readonly cycle: number;
  readonly status: string;
  readonly validation: string | null;
  readonly paymentId: string | null;
  readonly at: Date | null;
}

/** `GET /subscriptions/{id}/charges`: an array, newest or oldest first — the order is not documented. */
export function parseRollypayCharges(data: unknown): readonly RollypayCharge[] {
  const list = Array.isArray(data) ? data : asRecord(data)['items'];
  if (!Array.isArray(list)) return [];
  const charges: RollypayCharge[] = [];
  for (const item of list) {
    const charge = asRecord(item);
    const cycle = charge['cycle_number'];
    const status = charge['status'];
    if (typeof cycle !== 'number' || !Number.isSafeInteger(cycle) || cycle < 0) continue;
    if (typeof status !== 'string') continue;
    const paymentId = charge['payment_id'];
    const validation = charge['validation_status'];
    charges.push({
      cycle,
      status: status.toLowerCase(),
      validation: typeof validation === 'string' ? validation.toLowerCase() : null,
      paymentId: typeof paymentId === 'string' && paymentId.length > 0 ? paymentId : null,
      at: readDate(charge['actual_at']) ?? readDate(charge['scheduled_at']),
    });
  }
  return charges.sort((left, right) => left.cycle - right.cycle || time(left.at) - time(right.at));
}

/**
 * One charge per paid cycle, oldest first. «payed» on the charge is not yet
 * money: a charge under review, or without a payment in RollyPay's books, is
 * not paid («При review или отсутствии payment_id не выдавайте оплаченный
 * доступ»). Several attempts can belong to one cycle; the paid one counts once.
 */
export function rollypayPaidCycles(charges: readonly RollypayCharge[]): readonly RollypayCharge[] {
  const byCycle = new Map<number, RollypayCharge>();
  for (const charge of charges) {
    if (charge.status !== 'payed' || charge.validation === 'review' || charge.paymentId === null) continue;
    if (!byCycle.has(charge.cycle)) byCycle.set(charge.cycle, charge);
  }
  return [...byCycle.values()].sort((left, right) => left.cycle - right.cycle);
}

/**
 * Our status for RollyPay's pair of fields («учитывайте оба поля»). Null keeps
 * what we had: `review` waits for a person, `stop_pending` for RollyPay to
 * confirm, and a word we do not know is never read as a cancellation.
 */
export function mapRollypaySubscriptionStatus(input: {
  readonly state: string | null;
  readonly billingStatus: string | null;
  readonly lastAttemptFailed: boolean;
}): ProviderSubscriptionStatus | null {
  const state = input.state?.toLowerCase() ?? null;
  const billing = input.billingStatus?.toLowerCase() ?? null;
  if (state === 'stop' || billing === 'stopped') return ProviderSubscriptionStatus.CANCELLED;
  if (billing === 'review' || billing === 'stop_pending') return null;
  if (state === 'active' && billing === 'enabled') {
    return input.lastAttemptFailed ? ProviderSubscriptionStatus.PAST_DUE : ProviderSubscriptionStatus.ACTIVE;
  }
  if (state === 'new') return ProviderSubscriptionStatus.PENDING;
  return null;
}

/** Whether RollyPay has stopped, or taken the request to stop, a subscription it just returned. */
export function isRollypayStopTaken(subscription: unknown): boolean {
  const record = asRecord(subscription);
  const state = typeof record['state'] === 'string' ? record['state'].toLowerCase() : null;
  const billing = typeof record['billing_status'] === 'string' ? record['billing_status'].toLowerCase() : null;
  return state === 'stop' || billing === 'stopped' || billing === 'stop_pending';
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function time(value: Date | null): number {
  return value === null ? 0 : value.getTime();
}
