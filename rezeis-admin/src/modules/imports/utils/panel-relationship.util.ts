/**
 * panel-relationship.util
 * ───────────────────────
 * Is the Remnawave panel this install talks to the SAME installation the donor
 * bot was selling on?
 *
 * Every importer so far assumed yes, because that was the only case anybody
 * had: the operator ran two bots against one panel and wanted the customers in
 * one place. Moving to a NEW panel breaks that assumption in the worst possible
 * direction — silently, and in favour of destroying data:
 *
 *   • the dump's identifiers name profiles that do not exist here, so the
 *     overlay reads "the panel proves this profile is gone" and writes EXPIRED
 *     over every ACTIVE subscription in the file — the whole customer base, on
 *     a run that reports success;
 *   • Remnawave 3.x identifies users by a small dense NUMBER, so ids collide
 *     across installations. Id 5 exists on both panels and belongs to two
 *     different people. A miss is not even the common case: the common case is
 *     a HIT on somebody else's profile.
 *
 * Per row the two readings are genuinely indistinguishable — one deleted
 * profile looks exactly like one absent installation. Across a RUN they are
 * not: a thousand identifiers of which not one resolves, or which resolve to a
 * thousand strangers, is not a thousand deletions. So the verdict is taken once
 * for the run, from a bounded sample, and the importer branches on it.
 *
 * The verdict never guesses. Anything short of evidence is `unknown`, which
 * means "behave exactly as this importer did before" — the per-row owner check
 * still refuses individual collisions, loudly.
 */
import type { PanelLookup } from './remnawave-overlay.util';

export type PanelRelationship =
  /** The panel holds these profiles and they belong to these people. */
  | 'same'
  /** These identities are not this panel's — profiles must be created fresh. */
  | 'different'
  /** Not enough evidence to say. Callers keep their previous behaviour. */
  | 'unknown';

/** One identifier from the dump, with the person it is supposed to belong to. */
export interface PanelIdentitySample {
  readonly anchor: string;
  /** The donor's telegram id — the only owner fact both sides carry. */
  readonly telegramId: number | null;
}

export interface PanelRelationshipVerdict {
  readonly relationship: PanelRelationship;
  /** One line, written for the operator's report rather than the log. */
  readonly reason: string;
  readonly sampled: number;
  /** Resolved to a profile whose telegram owner is the expected person. */
  readonly matchedOwners: number;
  /** Resolved to a profile that belongs to somebody else entirely. */
  readonly mismatchedOwners: number;
  /** The panel was asked and PROVED it has no such profile. */
  readonly absent: number;
  /** Asked, and the answer could not be trusted either way. */
  readonly unconfirmed: number;
}

/**
 * How many identifiers we are willing to spend a verdict on.
 *
 * A ceiling, not a target: on a healthy same-panel run every one of these is a
 * hit in the bulk map and costs no network call at all. It is only a TRUNCATED
 * panel read that turns a sample into round trips — and those are round trips
 * the same rows would each make later anyway.
 */
export const PANEL_VERDICT_SAMPLE_SIZE = 25;

/**
 * Below this, "none of them resolved" is not a migration.
 *
 * Two customers whose profiles the operator deleted last week look identical to
 * two customers on another panel, and on a base that small the wrong branch is
 * cheap to undo by hand either way. The signal only becomes a signal in bulk.
 */
export const PANEL_VERDICT_MIN_EVIDENCE = 5;

/** Whole-string digits — the shape a Remnawave 3.x identity decodes to. */
function looksNumeric(value: string): boolean {
  return /^\d+$/.test(value);
}

/**
 * Spread a sample across the whole list instead of taking its head.
 *
 * A backup's rows come out in insertion order, so its first identifiers are the
 * OLDEST customers — precisely the cohort an operator is most likely to have
 * pruned from the panel over the years. Twenty-five deleted veterans read
 * exactly like a panel that has none of them, and the run would then provision
 * a duplicate profile for every customer who already had a working one. A
 * stride costs nothing and cannot be fooled that way.
 */
function stride<T>(items: readonly T[], size: number): T[] {
  if (items.length <= size) return [...items];
  const step = items.length / size;
  const picked: T[] = [];
  for (let i = 0; i < size; i += 1) picked.push(items[Math.floor(i * step)]);
  return picked;
}

/**
 * Pick the identifiers worth asking about: distinct, and owners first.
 *
 * Owner agreement is the only signal that survives id collision, so a sample
 * full of anonymous web accounts would answer the weaker question. Rows that
 * carry a telegram id therefore get the seats, and the rest only fill what is
 * left — they still count for "the panel has none of these".
 */
function chooseSamples(
  samples: readonly PanelIdentitySample[],
  size: number,
): readonly PanelIdentitySample[] {
  const seen = new Set<string>();
  const withOwner: PanelIdentitySample[] = [];
  const anonymous: PanelIdentitySample[] = [];
  for (const sample of samples) {
    if (sample.anchor.length === 0 || seen.has(sample.anchor)) continue;
    seen.add(sample.anchor);
    (sample.telegramId === null ? anonymous : withOwner).push(sample);
  }
  const chosen = stride(withOwner, size);
  if (chosen.length >= size) return chosen;
  return [...chosen, ...stride(anonymous, size - chosen.length)];
}

/**
 * Decide, once per run, whether the dump's panel identities are this panel's.
 *
 * `resolve` is the same `resolvePanelProfile` the importer uses per row,
 * already closed over the run's lookup, the per-profile read and the absence
 * probe — so this pass inherits every rule that read already follows: a
 * namespace mismatch is not evidence, a truncated list is confirmed per
 * profile, and only a strict 404 counts as "gone".
 */
export async function decidePanelRelationship(input: {
  readonly samples: readonly PanelIdentitySample[];
  readonly lookup: PanelLookup;
  readonly resolve: (
    anchor: string,
  ) => Promise<{ panel: { telegramId?: string | number | null } | null; known: boolean }>;
}): Promise<PanelRelationshipVerdict> {
  const { samples, lookup, resolve } = input;
  const empty = { sampled: 0, matchedOwners: 0, mismatchedOwners: 0, absent: 0, unconfirmed: 0 };

  // An unreachable panel has no opinion. Reading its silence as "different"
  // would create a second profile for every customer on the next outage.
  if (!lookup.reachable) {
    return { relationship: 'unknown', reason: 'panel unreachable', ...empty };
  }

  const chosen = chooseSamples(samples, PANEL_VERDICT_SAMPLE_SIZE);
  if (chosen.length < PANEL_VERDICT_MIN_EVIDENCE) {
    return {
      relationship: 'unknown',
      reason: `only ${chosen.length} panel identifier(s) in the backup — too few to tell`,
      ...empty,
      sampled: chosen.length,
    };
  }

  // A panel still keyed by 2.x uuids cannot be holding the numeric ids a 3.x
  // Bedolaga wrote: not one of them could ever resolve, whatever we ask it.
  // This is the one verdict that is a fact about the two schemas rather than
  // about the profiles, so it is settled before spending a single call.
  if (lookup.keyKind === 'uuid' && chosen.every((sample) => looksNumeric(sample.anchor))) {
    return {
      relationship: 'different',
      reason:
        'the panel identifies users by uuid, the backup by numeric id — these are not its profiles',
      ...empty,
      sampled: chosen.length,
    };
  }

  let present = 0;
  let matchedOwners = 0;
  let mismatchedOwners = 0;
  let absent = 0;
  let unconfirmed = 0;

  for (const sample of chosen) {
    const { panel, known } = await resolve(sample.anchor);
    if (panel === null) {
      if (known) absent += 1;
      else unconfirmed += 1;
      continue;
    }
    present += 1;
    const owner = panel.telegramId;
    if (owner === null || owner === undefined || sample.telegramId === null) continue;
    if (String(owner) === String(sample.telegramId)) matchedOwners += 1;
    else mismatchedOwners += 1;
  }

  const counted = { sampled: chosen.length, matchedOwners, mismatchedOwners, absent, unconfirmed };

  // One identifier that resolves to the very person the backup says owns it
  // settles the question on its own: numeric ids collide across installations,
  // telegram ids do not. Absences alongside it are ordinary deleted profiles.
  if (matchedOwners > 0 && mismatchedOwners === 0) {
    return {
      relationship: 'same',
      reason: `${matchedOwners} of ${chosen.length} identifiers resolve to the expected owner`,
      ...counted,
    };
  }

  // The two ways a panel says "not mine" — it has no such profile, or it has
  // one belonging to somebody else — are the SAME evidence and have to be
  // counted together. A panel with two customers of its own answers a
  // migrating dump with a mixture of both, and weighing them separately is how
  // the first draft of this file returned `unknown` for the very case it was
  // written for.
  const against = absent + mismatchedOwners;
  if (matchedOwners === 0 && against >= PANEL_VERDICT_MIN_EVIDENCE) {
    return {
      relationship: 'different',
      reason:
        mismatchedOwners === 0
          ? `the panel has none of the ${absent} profiles checked`
          : `of ${against} identifiers checked, ${mismatchedOwners} resolve to other people and ${absent} to nobody`,
      ...counted,
    };
  }

  return {
    relationship: 'unknown',
    reason:
      present === 0
        ? 'the panel could not confirm whether it has these profiles'
        : 'the panel answers inconsistently about who owns these profiles',
    ...counted,
  };
}
