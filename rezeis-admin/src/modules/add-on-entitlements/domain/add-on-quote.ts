import { AddOnLifetime } from '@prisma/client';

import type { AddOnEndBound, AddOnLifetimeGrant } from './add-on-lifetime';

/**
 * THE QUOTE A CUSTOMER PAID FOR, carried from the checkout to the capture.
 *
 * `AddOnPurchaseService.checkout` answers "until when?" with
 * `resolveAddOnLifetimeGrant` and writes the answer into the payment's add-on
 * marker (`Transaction.planSnapshot`). The capture
 * (`PaymentSubscriptionMutationService.applyAddOnViaLedger`) binds to what is
 * written here, whatever the switches say by then: the stage-4 switch is a
 * panel switch, flipped while payments are in flight, and a capture that asked
 * again sold one thing and delivered another — a reset add-on became a
 * permanent increment when the switch went off between the two, and a «до
 * конца подписки» one would become a reset one when it went on.
 *
 * Flat keys beside the marker's own `lifetime`, so an older reader that knows
 * none of them still reads the marker it always did.
 */
export interface AddOnQuote {
  readonly lifetime: AddOnLifetime;
  /** When the add-on is taken off: the reset plus the margin, or the subscription's end. */
  readonly expiresAt: Date;
  readonly endsBound: AddOnEndBound;
  /** Remnawave's reset instant the quoted cycle ends at; `null` for «до конца подписки». */
  readonly resetAt: Date | null;
  /** The reset that opened the quoted cycle; `null` for «до конца подписки». */
  readonly cycleStartsAt: Date | null;
}

export const ADD_ON_QUOTE_KEYS = {
  expiresAt: 'quotedExpiresAt',
  endsBound: 'quotedEndsBound',
  resetAt: 'quotedResetAt',
  cycleStartsAt: 'quotedCycleStartsAt',
} as const;

/** The marker fields for `grant` — the lifetime under the marker's own `lifetime` key. */
export function addOnQuoteMarkerFields(grant: AddOnLifetimeGrant): Record<string, string | null> {
  return {
    lifetime: grant.lifetime,
    [ADD_ON_QUOTE_KEYS.expiresAt]: grant.expiresAt.toISOString(),
    [ADD_ON_QUOTE_KEYS.endsBound]: grant.endsBound,
    [ADD_ON_QUOTE_KEYS.resetAt]: grant.resetAt === null ? null : grant.resetAt.toISOString(),
    [ADD_ON_QUOTE_KEYS.cycleStartsAt]: grant.cycleStartsAt === null ? null : grant.cycleStartsAt.toISOString(),
  };
}

function readInstant(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

/**
 * The quote a marker carries, or `null` when it carries none — a draft made
 * before this release, or a field that does not read as what was written. A
 * reset quote must hold its whole window (`resetAt` after `cycleStartsAt`),
 * or it is not a quote the capture can bind to.
 */
export function readAddOnQuote(marker: Readonly<Record<string, unknown>>): AddOnQuote | null {
  const lifetime = marker['lifetime'];
  if (lifetime !== AddOnLifetime.UNTIL_NEXT_RESET && lifetime !== AddOnLifetime.UNTIL_SUBSCRIPTION_END) return null;
  const expiresAt = readInstant(marker[ADD_ON_QUOTE_KEYS.expiresAt]);
  const endsBound = marker[ADD_ON_QUOTE_KEYS.endsBound];
  if (expiresAt === null || (endsBound !== 'reset' && endsBound !== 'subscription_end')) return null;
  const resetAt = readInstant(marker[ADD_ON_QUOTE_KEYS.resetAt]);
  const cycleStartsAt = readInstant(marker[ADD_ON_QUOTE_KEYS.cycleStartsAt]);
  if (lifetime === AddOnLifetime.UNTIL_NEXT_RESET) {
    if (resetAt === null || cycleStartsAt === null || cycleStartsAt.getTime() >= resetAt.getTime()) return null;
    return { lifetime, expiresAt, endsBound, resetAt, cycleStartsAt };
  }
  return { lifetime, expiresAt, endsBound: 'subscription_end', resetAt: null, cycleStartsAt: null };
}
