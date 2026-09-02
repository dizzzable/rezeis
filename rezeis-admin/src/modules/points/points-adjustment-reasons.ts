/**
 * Why an operator moved a subscriber's points by hand.
 *
 * A CODE, not free text, because the subscriber sees it: the cabinet renders
 * it in the subscriber's language, and a free-text field would land whatever
 * the operator typed — including "suspected fraud" — in the client's own
 * history. Free text exists too, as an internal note, and stays in the panel.
 *
 * Fixed in the first version. Operator-defined reasons need a label in both
 * cabinet languages, which is a settings surface of its own; it can be added
 * without touching the ledger, whose `details` column already carries the code.
 */
export const POINTS_ADJUSTMENT_REASONS = [
  'COMPENSATION',
  'PROMOTION',
  'CORRECTION',
  'VIOLATION',
  'OTHER',
] as const;

export type PointsAdjustmentReason = (typeof POINTS_ADJUSTMENT_REASONS)[number];

export function isPointsAdjustmentReason(value: unknown): value is PointsAdjustmentReason {
  return (
    typeof value === 'string' &&
    (POINTS_ADJUSTMENT_REASONS as readonly string[]).includes(value)
  );
}
