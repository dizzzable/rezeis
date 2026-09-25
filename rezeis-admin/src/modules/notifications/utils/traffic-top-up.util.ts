import { AddOnType } from '@prisma/client';

/**
 * «📦 Докупить трафик» ONLY WHEN THERE IS SOMETHING TO BUY (N1 gap 4, 25.09.2026).
 *
 * «Трафик исчерпан» about a subscription with no end date turns its renewal
 * button into «📦 Докупить трафик» on the add-on page (the owner, 24.09.2026),
 * because such a subscription is never renewed. But a lifetime subscription on
 * a plan without a traffic reset is sold no traffic add-on at all — "until the
 * end" would be for ever (`resolveAddOnLifetimeGrant`) — and without «Сброс
 * трафика» in the catalogue the button opened a page with nothing on it. So
 * the notice records, when it is written, whether its subscription can buy
 * anything that brings traffic back: this key in its payload. The bot button,
 * the push and the cabinet's bell (reiwa `notification-target.ts`) all read
 * that one answer:
 *  - `true`: «📦 Докупить трафик» → the add-on page, as before;
 *  - `false`: no such button, and the push and the bell do not open the add-on
 *    page either — the notice itself stays;
 *  - absent (a notice written before the key, or one whose answer could not be
 *    read): as before.
 */
export const TRAFFIC_TOP_UP_KEY = 'trafficTopUp';

/** The add-on types that bring traffic back: more of it, or the counter zeroed. */
const TRAFFIC_BRINGING_TYPES: ReadonlySet<AddOnType> = new Set<AddOnType>([
  AddOnType.EXTRA_TRAFFIC,
  AddOnType.RESET_TRAFFIC,
]);

/**
 * Whether an add-on offer — the list the cabinet's add-on page shows,
 * `AddOnEligibilityService.listForSubscription` — holds anything that brings
 * traffic back. The offer lists only what this subscription can buy now, each
 * with a price (a catalogue add-on has at least one), so being listed is being
 * purchasable.
 */
export function offerBringsTrafficBack(offer: {
  readonly addOns: ReadonlyArray<{ readonly type: AddOnType }>;
}): boolean {
  return offer.addOns.some((addOn) => TRAFFIC_BRINGING_TYPES.has(addOn.type));
}

/** What a notice's payload says: `true`/`false` when it was decided, `null` when it says nothing. */
export function readTrafficTopUp(payload: unknown): boolean | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[TRAFFIC_TOP_UP_KEY];
  return typeof value === 'boolean' ? value : null;
}
