/**
 * Single hit returned by the admin quick-search overlay.
 *
 * `id` is opaque from the frontend's perspective; the route table in
 * `quick-search-overlay.tsx` decides where it points based on `type`.
 *
 * `subtitle` is optional and intended for the secondary line in the result
 * row (e.g. plan name for a subscription, login for a user).
 */
export type QuickSearchHitType =
  | 'user'
  | 'subscription'
  | 'transaction'
  | 'promocode'
  | 'partner';

export interface QuickSearchHitInterface {
  readonly type: QuickSearchHitType;
  readonly id: string;
  readonly label: string;
  readonly subtitle?: string;
}
