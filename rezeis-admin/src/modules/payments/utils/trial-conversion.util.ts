/**
 * The mark a checkout draft carries when its UPGRADE converts the buyer's trial
 * (`isConvertibleTrial` at draft time), and the reader fulfilment uses.
 *
 * A trial converts once. Fulfilling a conversion restarts the term from the
 * payment (`UPGRADE_RESETS_EXPIRY`), which is right for the first one and
 * destroys paid time for a second: a buyer who paid the conversion twice — two
 * tabs, a card beside «для автоматического списания», two sign-ups confirmed
 * together — held one term for two payments. Fulfilment reads this mark to tell
 * a conversion from a change of a paid plan, and a conversion whose trial
 * another payment converted first is received but not applied — withheld, see
 * {@link CONVERSION_WITHHELD_AT_KEY}.
 */
export const TRIAL_CONVERSION_SNAPSHOT_KEY = 'convertsTrial';

export function isTrialConversionSnapshot(planSnapshot: unknown): boolean {
  return (
    typeof planSnapshot === 'object' &&
    planSnapshot !== null &&
    !Array.isArray(planSnapshot) &&
    (planSnapshot as Record<string, unknown>)[TRIAL_CONVERSION_SNAPSHOT_KEY] === true
  );
}

/**
 * Stamped on a conversion's `gatewayData`, with {@link TRIAL_CONVERTED_BY_KEY},
 * when its payment arrived after another payment had converted the trial: the
 * money was received and nothing was applied, for the operator to refund.
 *
 * The row is settled like any fulfilled payment (COMPLETED, `fulfilledAt`), so
 * the notification is processed rather than failed, the plan it names can be
 * deleted, and a refund can close it. This mark is what keeps everything that
 * follows a fulfilment from treating it as a sale: the post-payment hooks do
 * not run for it, the sweep stops the provider subscription it signed up, a
 * refund revokes nothing, and a second conversion never names it as the one
 * that converted the trial. Written once, in the fulfilment's own transaction,
 * which is also what keys the operator's notice to one per payment.
 */
export const CONVERSION_WITHHELD_AT_KEY = 'conversionWithheldAt';

/** The payment whose conversion came first, beside {@link CONVERSION_WITHHELD_AT_KEY}. */
export const TRIAL_CONVERTED_BY_KEY = 'trialConvertedByPaymentId';

/** Whether a transaction's `gatewayData` carries {@link CONVERSION_WITHHELD_AT_KEY}. */
export function isWithheldConversion(gatewayData: unknown): boolean {
  return (
    typeof gatewayData === 'object' &&
    gatewayData !== null &&
    !Array.isArray(gatewayData) &&
    typeof (gatewayData as Record<string, unknown>)[CONVERSION_WITHHELD_AT_KEY] === 'string'
  );
}

/**
 * Stamped on a withheld conversion's `gatewayData`, with
 * {@link MANUAL_REFUND_RECORDED_BY_KEY}, when an operator records in the panel
 * that its money was returned at the provider («Отметить возврат»). Most
 * gateways never report a refund, so without it such a payment stayed a
 * received, unapplied sale for good. The reversal it triggers is the one a
 * provider's refund notification runs; this only says who asked, and when.
 */
export const MANUAL_REFUND_RECORDED_AT_KEY = 'manualRefundRecordedAt';

/** The admin who recorded the refund, beside {@link MANUAL_REFUND_RECORDED_AT_KEY}. */
export const MANUAL_REFUND_RECORDED_BY_KEY = 'manualRefundRecordedBy';

/**
 * Where an operator records a withheld payment's refund, in the words the
 * panel shows: the Payments page, its Transactions tab, the payment's details,
 * the button. The operator's card names it, so it must match the SPA
 * (`adminNav.items.payments`, `paymentsPage.tabs.transactions`,
 * `paymentsPage.withheld.recordRefund`).
 */
export const WITHHELD_REFUND_UI_PATH = '«Платежи» → «Транзакции» → этот платёж → «Отметить возврат»';

/** What the panel shows about a withheld conversion. */
export interface WithheldConversionMark {
  /** When fulfilment withheld it. */
  readonly withheldAt: string;
  /** The payment that converted the trial first. */
  readonly convertedByPaymentId: string | null;
  /**
   * When its refund was reversed — recorded by an operator or reported by the
   * provider — or null while the money is still held.
   */
  readonly refundedAt: string | null;
}

/** The withheld mark on a transaction's `gatewayData`, or null for any other payment. */
export function readWithheldConversion(gatewayData: unknown): WithheldConversionMark | null {
  if (!isWithheldConversion(gatewayData)) return null;
  const record = gatewayData as Record<string, unknown>;
  const convertedBy = record[TRIAL_CONVERTED_BY_KEY];
  const refundedAt = record['refundReversedAt'];
  return {
    withheldAt: record[CONVERSION_WITHHELD_AT_KEY] as string,
    convertedByPaymentId: typeof convertedBy === 'string' ? convertedBy : null,
    refundedAt: typeof refundedAt === 'string' ? refundedAt : null,
  };
}
