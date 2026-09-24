import { GIB_BYTES } from './cutover-baseline';

/**
 * A FREE LIMIT BONUS IN THE TERM MODEL — the gigabytes or devices a promo code,
 * a points exchange, a quest or a wheel prize gives on top of what the
 * subscription pays for. Pure.
 *
 * ── What a bonus is today, and why it needs a home here ──────────────────
 *
 * Outside the term model a bonus is a raise of the limit COLUMN that also
 * rewrites the stored `planSnapshot` to the raised value
 * (`patchSnapshotNumeric`). The column then still reads as tracking its plan
 * (INHERITED), so the next renewal puts the plan's own value back: the bonus
 * lasts until the next renewal, never longer.
 *
 * In the term model the projection has the last word over those columns —
 * `desired = term base + live add-ons`, and the base of an INHERITED field is
 * the term's — so the same write lasted only until the next recompute: a bonus
 * of +50 GB followed by a paid +10 GB left 110 GB, not 160.
 *
 * ── The rule ─────────────────────────────────────────────────────────────
 *
 * A bonus given to a subscription in the term model is recorded ON THE TERMS
 * that exist when it is given — the ACTIVE one and every queued SCHEDULED one
 * — under `planSnapshot.limitBonuses`, and the projection counts the ACTIVE
 * term's bonuses as a contribution, exactly as it counts a live add-on
 * (`EffectiveProjectionService`). So it lasts while one of those terms is the
 * active one, and ends when a term minted after it takes over: the term the
 * next renewal pays for, or a plan change's. That is "until the next renewal"
 * in term-model words — measured to the end of the period already paid for
 * rather than to the moment of the payment, since a paid period's limits
 * change when it starts, not when it is bought. A queued term carries it too
 * because in legacy a bonus given after an early renewal was paid lasts
 * through the period that renewal bought: the refresh it would have ended at
 * had already happened.
 *
 * A PAID UPGRADE does not end it. The owner's rule for a live add-on across a
 * paid upgrade (24.09.2026) — it keeps its own end, clamped to the new one —
 * holds for a bonus too: the upgrade carries it onto its terms with that end
 * written down (`until`), and the boundary sweep takes it off when the end has
 * passed (`term-limit-bonus.util.ts`). Outside the model an upgrade still ends
 * a bonus, as it always has: the snapshot the bonus rewrote makes the field
 * read as the plan's, and the new plan's value is written.
 *
 * Counted as a contribution, it also stays out of the ownership test the way
 * an add-on does: the columns mirror `base + contributions`, and the recorded
 * contribution is what `resolvePlanLimitOwnership` subtracts before comparing
 * with the stored snapshot — so the snapshot is NOT rewritten, and a renewal
 * or a plan change handles the field as the plan's.
 *
 * ── Why the term, and not an add-on entitlement ──────────────────────────
 *
 * An `AddOnEntitlement` needs a paying `Transaction` as its source
 * (`source_transaction_id` NOT NULL, a foreign key), so a bonus there needs a
 * migration or a synthetic zero-value payment in the money tables. It would
 * also be the wrong thing everywhere an add-on is read: it would be listed
 * under the customer's purchased options, offered again at renewal, notified
 * as an expiring purchase («Купить снова»), refunded, and reduced by the
 * device-cleanup saga — a bonus's devices were never removed from anybody.
 * The term's own JSON needs none of that and no migration; the one add-on
 * rule a bonus shares, its end across a paid upgrade, is written as `until`.
 */
export const TERM_LIMIT_BONUSES_KEY = 'limitBonuses';

export type TermLimitBonusResource = 'TRAFFIC' | 'DEVICES';

/** Which writer gave the bonus. */
export type TermLimitBonusSource = 'PROMOCODE' | 'POINTS_EXCHANGE' | 'REWARD';

export interface TermLimitBonus {
  readonly id: string;
  readonly resource: TermLimitBonusResource;
  /** Gigabytes for TRAFFIC, devices for DEVICES: a positive whole number. */
  readonly value: number;
  readonly source: TermLimitBonusSource;
  /** The promo code, the points exchange, or the quest completion or spin behind it. */
  readonly sourceRef: string;
  readonly grantedAt: string;
  /**
   * An end of its OWN, as an ISO instant — set only when a paid upgrade
   * carried the bonus onto a term it was not given on. The owner's rule for a
   * live add-on across a paid upgrade (24.09.2026): it keeps its own end, the
   * end of the period it was given in, clamped to the subscription's new end.
   * The boundary sweep takes it off once that instant has passed
   * (`pruneEndedTermLimitBonusesInTransaction`). Without one, a bonus ends
   * with the last term that carries it.
   */
  readonly until?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isBonusEntry(value: unknown): value is TermLimitBonus {
  const entry = asRecord(value);
  if (entry === null) return false;
  return (
    typeof entry['id'] === 'string' &&
    (entry['resource'] === 'TRAFFIC' || entry['resource'] === 'DEVICES') &&
    typeof entry['value'] === 'number' &&
    Number.isInteger(entry['value']) &&
    entry['value'] > 0 &&
    (entry['until'] === undefined || (typeof entry['until'] === 'string' && !Number.isNaN(Date.parse(entry['until']))))
  );
}

/** The bonuses a term carries. An entry that cannot be read counts for nothing. */
export function readTermLimitBonuses(planSnapshot: unknown): TermLimitBonus[] {
  const raw = asRecord(planSnapshot)?.[TERM_LIMIT_BONUSES_KEY];
  return Array.isArray(raw) ? raw.filter(isBonusEntry) : [];
}

/** What a term's bonuses add, in the projection's units. */
export function sumTermLimitBonuses(planSnapshot: unknown): {
  readonly trafficBytes: bigint;
  readonly devices: number;
} {
  let trafficBytes = 0n;
  let devices = 0;
  for (const bonus of readTermLimitBonuses(planSnapshot)) {
    if (bonus.resource === 'TRAFFIC') trafficBytes += BigInt(bonus.value) * GIB_BYTES;
    else devices += bonus.value;
  }
  return { trafficBytes, devices };
}

/** The term's snapshot with one more bonus; every other key untouched. */
export function withTermLimitBonus(planSnapshot: unknown, bonus: TermLimitBonus): Record<string, unknown> {
  const snapshot = asRecord(planSnapshot) ?? {};
  const raw = snapshot[TERM_LIMIT_BONUSES_KEY];
  return { ...snapshot, [TERM_LIMIT_BONUSES_KEY]: [...(Array.isArray(raw) ? raw : []), bonus] };
}

/**
 * The term's snapshot without the bonuses whose own end has passed at `now`,
 * or `null` when it has none. Pure; entries that cannot be read are kept
 * as they are (they count for nothing anyway).
 */
export function withoutEndedTermLimitBonuses(planSnapshot: unknown, now: Date): Record<string, unknown> | null {
  const snapshot = asRecord(planSnapshot);
  if (snapshot === null) return null;
  const raw = snapshot[TERM_LIMIT_BONUSES_KEY];
  if (!Array.isArray(raw)) return null;
  const kept = raw.filter((entry) => !(isBonusEntry(entry) && bonusEndedAt(entry, now)));
  return kept.length === raw.length ? null : { ...snapshot, [TERM_LIMIT_BONUSES_KEY]: kept };
}

/** Has this bonus's own end (`until`) passed at `now`? A bonus without one ends with its term. */
export function bonusEndedAt(bonus: TermLimitBonus, now: Date): boolean {
  return bonus.until !== undefined && Date.parse(bonus.until) <= now.getTime();
}

/**
 * The term's snapshot as the SUBSCRIPTION may carry it (the boundary copies a
 * deferred plan's snapshot onto the row at activation): the bonuses stay with
 * the term, which is the only place they count.
 */
export function withoutTermLimitBonuses(planSnapshot: Record<string, unknown>): Record<string, unknown> {
  if (!(TERM_LIMIT_BONUSES_KEY in planSnapshot)) return planSnapshot;
  const { [TERM_LIMIT_BONUSES_KEY]: _dropped, ...rest } = planSnapshot;
  return rest;
}
