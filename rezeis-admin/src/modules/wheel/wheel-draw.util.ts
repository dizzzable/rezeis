import { WheelSectorKind } from '@prisma/client';

/**
 * Who may be drawn, and which of them came up.
 *
 * ── Every spin is its own draw ────────────────────────────────────────────
 *
 * There is no memory here, and that is a decision rather than an omission.
 * The wheel does not remember that somebody has lost four times, does not
 * raise their odds, does not "owe" them anything, and does not consume a
 * sector by landing on it. The operator sets a weight; that weight is what
 * every single spin is judged against, for everybody, forever. A pity timer
 * would make the configured percentage a lie — the operator would set 5 % and
 * the wheel would pay something else — and the percentage is the only thing
 * the operator can actually reason about.
 *
 * Which is also why this is a function of its arguments and a random source,
 * with nothing stored between calls: state is the thing that would make two
 * consecutive spins differ, so there is none to have.
 *
 * ── The odds are never shown ──────────────────────────────────────────────
 *
 * Nothing in this file is reachable from a cabinet response. What the cabinet
 * learns is which sectors are on the wheel and, for the person asking,
 * whether each one can still be won by them — never how likely it is.
 */

/** Why a sector is not in the draw. */
export type SectorExclusion =
  /** The operator turned it off. */
  | 'DISABLED'
  /** Weight zero: on the wheel, never drawn. */
  | 'ZERO_WEIGHT'
  /** This person has already won it as often as they are allowed to. */
  | 'USER_CAP'
  /** Nobody can win it any more — the global ceiling is reached. */
  | 'EXHAUSTED'
  /** A KEY sector whose pool has run dry. */
  | 'OUT_OF_STOCK'
  /** Configured into a state it cannot pay from: a KEY sector with no pool. */
  | 'UNCONFIGURED';

export interface SectorForDraw {
  readonly id: string;
  readonly kind: WheelSectorKind;
  readonly enabled: boolean;
  readonly weight: number;
  /** NULL = no ceiling. */
  readonly maxWinsPerUser: number | null;
  /** NULL = no ceiling. */
  readonly maxWinsTotal: number | null;
  readonly wonCount: number;
  /** KEY sectors only: the pool it draws from, `null` when none is set. */
  readonly keyPoolId?: string | null;
  /**
   * KEY sectors only: unclaimed keys left in the pool. `null` for every other
   * kind, which has no stock to run out of.
   */
  readonly keysAvailable?: number | null;
  /**
   * PROMOCODE sectors that mint a SUBSCRIPTION code: whether the plan they
   * name still exists. `true` for everything else — there is nothing to
   * resolve. A plan can be deleted long after the sector was configured, and
   * `promo_plan_id` carries no foreign key to stop it.
   */
  readonly promoPlanResolves?: boolean;
}

export interface DrawCandidate {
  readonly id: string;
  readonly weight: number;
}

export interface DrawPool {
  /** The sectors that may come up, with the weights the draw uses. */
  readonly candidates: readonly DrawCandidate[];
  /** Why each of the others may not, keyed by sector id. */
  readonly excluded: ReadonlyMap<string, SectorExclusion>;
  /** Sum of the candidate weights — the denominator of every percentage. */
  readonly totalWeight: number;
}

/**
 * Decide who is in the draw for ONE person at ONE instant.
 *
 * A capped-out sector is removed rather than drawn-and-refunded. Drawing it
 * and falling back to "не повезло" would quietly pay the loss sector more
 * often than the operator configured, and the operator would have no way to
 * see it: the sector that was actually paid is the one the numbers must
 * describe. Removing it renormalises the rest, which is the same wheel minus
 * a prize this person cannot have.
 */
export function resolveDrawPool(input: {
  readonly sectors: readonly SectorForDraw[];
  /** How many times this person has already won each sector, by sector id. */
  readonly userWins: ReadonlyMap<string, number>;
}): DrawPool {
  const candidates: DrawCandidate[] = [];
  const excluded = new Map<string, SectorExclusion>();

  for (const sector of input.sectors) {
    const exclusion = excludeSector(sector, input.userWins.get(sector.id) ?? 0);
    if (exclusion !== null) {
      excluded.set(sector.id, exclusion);
      continue;
    }
    candidates.push({ id: sector.id, weight: sector.weight });
  }

  const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  return { candidates, excluded, totalWeight };
}

function excludeSector(sector: SectorForDraw, winsByThisUser: number): SectorExclusion | null {
  if (!sector.enabled) return 'DISABLED';

  // A KEY sector with no pool behind it is a prize that cannot be handed
  // over. It is excluded rather than allowed to come up and fail, because a
  // spin is spent whatever happens next.
  if (sector.kind === WheelSectorKind.KEY) {
    if (sector.keyPoolId === null || sector.keyPoolId === undefined) return 'UNCONFIGURED';
    if ((sector.keysAvailable ?? 0) <= 0) return 'OUT_OF_STOCK';
  }

  // The same reasoning one kind over: a subscription code whose plan has been
  // deleted throws in the payout, and the spin is refunded — but the sector
  // keeps coming up and keeps failing, for everybody, until somebody notices.
  // Better it simply stops being offered.
  if (sector.promoPlanResolves === false) return 'UNCONFIGURED';

  // NOTHING is deliberately exempt from both ceilings: it is what keeps the
  // pool non-empty for everybody, always. A capped loss sector would leave
  // somebody with a wheel that has nothing left to give them, and the only
  // honest answer then is to refuse the spin — which is a worse product than
  // the one the operator asked for.
  if (sector.kind !== WheelSectorKind.NOTHING) {
    if (sector.maxWinsPerUser !== null && winsByThisUser >= sector.maxWinsPerUser) return 'USER_CAP';
    if (sector.maxWinsTotal !== null && sector.wonCount >= sector.maxWinsTotal) return 'EXHAUSTED';
  }

  if (!Number.isInteger(sector.weight) || sector.weight <= 0) return 'ZERO_WEIGHT';

  return null;
}

/**
 * The live percentage of a sector, which is what the PANEL shows while the
 * operator edits and what nobody else ever sees.
 *
 * Derived from the weights rather than stored, so the column adds up to a
 * hundred by construction: there is no state in which the operator has
 * entered numbers that do not.
 */
export function sectorChancePercent(weight: number, totalWeight: number): number {
  if (totalWeight <= 0 || weight <= 0) return 0;
  return (weight * 100) / totalWeight;
}

/**
 * Draw one sector.
 *
 * `random` must return a number in [0, 1) — `Math.random` in production, a
 * fixed sequence in the tests. It is a parameter because a draw whose source
 * of chance is baked in cannot be tested for the thing that matters: that a
 * given roll lands on a given sector, at both ends of every interval.
 *
 * Returns `null` only when there is nothing to draw from, which the caller
 * has to treat as "this wheel cannot pay" — never as a loss.
 */
export function drawSector(pool: DrawPool, random: () => number): string | null {
  if (pool.candidates.length === 0 || pool.totalWeight <= 0) return null;

  const roll = random();
  // Guard both ends. A source that hands back exactly 1 (or something worse)
  // would otherwise walk off the end of the cumulative sum and return null,
  // which the caller reads as a broken wheel rather than as a win.
  const bounded = Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 0.999999999999) : 0;
  const ticket = bounded * pool.totalWeight;

  let cumulative = 0;
  for (const candidate of pool.candidates) {
    cumulative += candidate.weight;
    if (ticket < cumulative) return candidate.id;
  }

  // Floating point can leave `ticket` a hair above the final boundary. The
  // last candidate owns that hair; returning null here would drop a spin.
  return pool.candidates[pool.candidates.length - 1]?.id ?? null;
}

/**
 * Whether the wheel can be spun at all right now.
 *
 * Checked BEFORE a spin is paid for. A wheel with no loss sector and no
 * winnable prize left would take somebody's spin and hand back nothing, and
 * "the operator misconfigured it" is not a thing to charge for.
 */
export function isWheelSpinnable(pool: DrawPool): boolean {
  return pool.candidates.length > 0 && pool.totalWeight > 0;
}

/**
 * The kinds this platform settles inside the spin's own transaction. Anything
 * else is owed after it — recorded PENDING, handed to an operator or to the
 * step that issues it.
 */
export const SETTLED_IN_TRANSACTION: ReadonlySet<WheelSectorKind> = new Set([
  WheelSectorKind.POINTS,
  WheelSectorKind.SPINS,
  WheelSectorKind.DAYS,
  WheelSectorKind.TRAFFIC,
  WheelSectorKind.DISCOUNT,
  WheelSectorKind.PROMOCODE,
  WheelSectorKind.KEY,
]);
