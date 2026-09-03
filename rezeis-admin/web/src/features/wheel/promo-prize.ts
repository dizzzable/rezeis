import type { PromocodeRewardType } from './wheel-config-api'

/**
 * How a PROMOCODE prize is configured, on the wheel and in a contest.
 *
 * A promocode prize is not "a code" — it is a code that DOES something, and
 * the four fields below are that something. Without them the server fills in
 * its own default (days), so a sector meant to hand out a month of a
 * particular plan silently handed out a number of days instead, and editing
 * such a sector from this form erased whatever had been configured elsewhere.
 *
 * The plan filter is the point of the whole prize. It is the deferred half of
 * the discount decision: the code is won now and spent later, possibly weeks
 * later on a different plan, so the restriction has to travel WITH the code
 * rather than being checked when it is issued.
 */

export const PROMO_REWARD_TYPES: readonly PromocodeRewardType[] = [
  'DURATION',
  'TRAFFIC',
  'DEVICES',
  'SUBSCRIPTION',
  'PERSONAL_DISCOUNT',
  'PURCHASE_DISCOUNT',
]

export interface PromoDraft {
  rewardType: PromocodeRewardType
  /** SUBSCRIPTION only: which plan the code grants. */
  planId: string
  /** Where the code may be spent. Empty = anywhere. */
  planIds: string[]
  /** Days until it expires. Empty = never. */
  lifetime: string
}

export function emptyPromoDraft(): PromoDraft {
  return { rewardType: 'DURATION', planId: '', planIds: [], lifetime: '' }
}

export function promoDraftOf(source: {
  readonly promoRewardType: PromocodeRewardType | null
  readonly promoPlanId: string | null
  readonly promoPlanIds: readonly string[]
  readonly promoLifetime: number | null
}): PromoDraft {
  return {
    rewardType: source.promoRewardType ?? 'DURATION',
    planId: source.promoPlanId ?? '',
    planIds: [...source.promoPlanIds],
    lifetime: source.promoLifetime === null ? '' : String(source.promoLifetime),
  }
}

/**
 * The four fields as the API takes them — nulled out wholesale for any kind
 * that is not a promocode, so switching a sector away from PROMOCODE clears
 * its promo configuration instead of leaving it behind to confuse the next
 * person who opens the form.
 */
export interface PromoFields {
  readonly promoRewardType: PromocodeRewardType | null
  readonly promoPlanId: string | null
  readonly promoPlanIds: readonly string[]
  readonly promoLifetime: number | null
}

export function promoPayload(kind: string, draft: PromoDraft): PromoFields {
  if (kind !== 'PROMOCODE') {
    return { promoRewardType: null, promoPlanId: null, promoPlanIds: [], promoLifetime: null }
  }
  const lifetime = draft.lifetime.trim() === '' ? null : Math.trunc(Number(draft.lifetime))
  return {
    promoRewardType: draft.rewardType,
    promoPlanId: draft.rewardType === 'SUBSCRIPTION' && draft.planId !== '' ? draft.planId : null,
    promoPlanIds: draft.planIds,
    promoLifetime: lifetime !== null && Number.isFinite(lifetime) && lifetime > 0 ? lifetime : null,
  }
}
