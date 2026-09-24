/**
 * The rows of «Откуда деньги» (the «Выручка» tab), kept out of the component
 * file so a test reads them without rendering the tab.
 */
import type { PurchaseKind, RevenueReport } from './analytics-api'

/** What a payment bought: the four kinds the card always shows. */
export const SALE_KINDS: readonly PurchaseKind[] = ['new', 'renewal', 'change', 'addon']

/**
 * The kinds «Откуда деньги» shows: the four always, and money withheld for
 * refund («Не применён (к возврату)») only while the window holds some — a row
 * of zeros there would read as a fifth kind of sale.
 */
export function revenueKindsOf(report: Pick<RevenueReport, 'byKind'>): readonly PurchaseKind[] {
  const withheld = report.byKind.find((kind) => kind.kind === 'withheld')
  return withheld !== undefined && (withheld.payments > 0 || withheld.figure.value !== 0)
    ? [...SALE_KINDS, 'withheld']
    : SALE_KINDS
}
