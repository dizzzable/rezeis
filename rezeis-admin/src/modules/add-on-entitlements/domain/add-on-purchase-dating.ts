import { AddOnLifetime, AddOnType } from '@prisma/client';

/**
 * WILL AN ADD-ON BOUGHT NOW BE RECORDED WITH AN END?
 *
 * The offer tells the customer until when an add-on works («Действует до …»),
 * and it may say so only when the purchase really ends: when the fulfilment
 * records it in the ledger as an entitlement with that end. Otherwise the
 * purchase is the legacy increment — raw columns, PERMANENT — and a date is a
 * promise nothing keeps. Before `dated`, against a panel with stage 2 off —
 * every panel up to 0.9.7.68, any install that sets it `false`, a rollback — the
 * cabinet showed «Действует до 12.10.26» on every card and on the confirmation,
 * for purchases that never end.
 *
 * The gates are the fulfilment's (`PaymentSubscriptionMutationService`,
 * `applyAddOnTopUp` → `applyAddOnViaLedger`), in its order:
 *   1. stage 2 (`directPurchase`): off, every purchase is the legacy increment;
 *   2. the subscription is in the term model, or enters it at the purchase: it
 *      has an ACTIVE term, or it has no term at all and stage 1
 *      (`entitlementShadow`) lets the purchase bring it in
 *      (`enterTermModelInTransaction`). One with terms but none ACTIVE is not
 *      entered again, and falls back;
 *   3. «until the end of the subscription» needs a finite end still ahead:
 *      the subscription's expiry, a queued (SCHEDULED) renewal's term included
 *      — the end the fulfilment binds (review R3a-05). A lifetime subscription
 *      has none, and falls back;
 *   4. «until the next reset» needs a reset window — which the offer already
 *      requires before it lists one (`resolveAddOnLifetimeGrant` with the
 *      intake capabilities, themselves gated on stage 2) — so one the offer
 *      lists is dated once 1 and 2 hold.
 * A traffic reset grants nothing that could end: never dated.
 *
 * The fulfilment does not call this — it decides by doing — so the two are
 * held together by `test/add-on-offer-dated-postgres.spec.ts`, which buys what
 * the offer lists through the real fulfilment in each of these states and
 * compares. Change a gate there and that spec names the difference.
 */
export interface AddOnPurchaseDatingInput {
  readonly type: AddOnType;
  readonly lifetime: AddOnLifetime;
  readonly flags: { readonly directPurchase: boolean; readonly entitlementShadow: boolean };
  /** The subscription's ACTIVE term, as stored, if it has one. */
  readonly activeTerm: { readonly endsAt: Date | null } | null;
  /** Whether the subscription has any term at all, ACTIVE or not. */
  readonly hasAnyTerm: boolean;
  readonly subscriptionExpiresAt: Date | null;
  readonly now: Date;
}

export function isAddOnPurchaseDated(input: AddOnPurchaseDatingInput): boolean {
  if (input.type === AddOnType.RESET_TRAFFIC) return false;
  if (!input.flags.directPurchase) return false;
  const inModel = input.activeTerm !== null || (!input.hasAnyTerm && input.flags.entitlementShadow);
  if (!inModel) return false;
  if (input.lifetime === AddOnLifetime.UNTIL_NEXT_RESET) return true;
  const end = input.subscriptionExpiresAt;
  return end !== null && end.getTime() > input.now.getTime();
}
