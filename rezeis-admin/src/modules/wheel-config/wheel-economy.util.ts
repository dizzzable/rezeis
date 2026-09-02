import { WheelSectorKind } from '@prisma/client';

/**
 * Whether the wheel can stop.
 *
 * ── The thing percentages do not catch ────────────────────────────────────
 *
 * Weights that add up to a hundred say nothing about whether the wheel pays
 * for itself. A sector that awards SPINS gives back the very thing a spin
 * costs, so what matters is the EXPECTED number of spins one spin returns:
 *
 *     R = Σ over drawable sectors of  p(sector) × spins(sector)
 *
 * With 70 % nothing, 5 % points and 25 % "+5 spins", the weights are a
 * perfectly tidy hundred and R = 0.25 × 5 = 1.25. Every spin buys, on
 * average, a quarter more than a spin — the wheel never stops, and it hands
 * out the other prizes forever while it does not.
 *
 * R is the reproduction rate of a branching process, so the reading is exact:
 *
 *   R ≥ 1  — the spins never run out. The expected number of spins from one
 *            is infinite (at R = 1 exactly it still ends with probability
 *            one, but the expected wait is unbounded — not a thing to ship).
 *   R < 1  — one spin becomes 1 / (1 − R) spins on average before it dies.
 *            R = 0.9 means every spin somebody buys is really ten.
 *
 * That second number is the one an operator can actually reason about, so it
 * is what the panel shows next to the percentages.
 *
 * ── Which sectors count ───────────────────────────────────────────────────
 *
 * The ones a fresh person can draw: enabled, positive weight. Per-user and
 * global ceilings only ever REMOVE sectors from somebody's pool, so ignoring
 * them here gives the wheel's most generous configuration — which is the one
 * worth guarding against.
 */

export interface EconomySector {
  readonly kind: WheelSectorKind;
  readonly enabled: boolean;
  readonly weight: number;
  /** Spins awarded, read only for a SPINS sector. */
  readonly amount: number;
}

export interface WheelEconomy {
  /** Σ of the drawable weights — the denominator of every percentage. */
  readonly totalWeight: number;
  /** R: expected spins returned per spin. */
  readonly spinsReturnedPerSpin: number;
  /**
   * How many spins one spin becomes, on average, before the chain dies.
   * `null` when it never does.
   */
  readonly expectedTotalSpins: number | null;
  /** R ≥ 1: the wheel cannot stop. */
  readonly perpetual: boolean;
  /**
   * R is high enough to be worth saying out loud, but the wheel still ends.
   * Not a refusal — an operator may want a generous wheel for a weekend.
   */
  readonly generous: boolean;
}

/** Above this, one bought spin is already worth five. */
export const GENEROUS_THRESHOLD = 0.8;

export function readWheelEconomy(sectors: readonly EconomySector[]): WheelEconomy {
  const drawable = sectors.filter(
    (sector) => sector.enabled && Number.isInteger(sector.weight) && sector.weight > 0,
  );
  const totalWeight = drawable.reduce((sum, sector) => sum + sector.weight, 0);
  if (totalWeight <= 0) {
    return {
      totalWeight: 0,
      spinsReturnedPerSpin: 0,
      expectedTotalSpins: 1,
      perpetual: false,
      generous: false,
    };
  }

  const spinsReturnedPerSpin = drawable.reduce((sum, sector) => {
    if (sector.kind !== WheelSectorKind.SPINS) return sum;
    const awarded = Number.isFinite(sector.amount) && sector.amount > 0 ? sector.amount : 0;
    return sum + (sector.weight / totalWeight) * awarded;
  }, 0);

  const perpetual = spinsReturnedPerSpin >= 1;
  return {
    totalWeight,
    spinsReturnedPerSpin,
    expectedTotalSpins: perpetual ? null : 1 / (1 - spinsReturnedPerSpin),
    perpetual,
    generous: !perpetual && spinsReturnedPerSpin >= GENEROUS_THRESHOLD,
  };
}

/** Why a wheel may not be switched on. */
export type WheelBlocker =
  /** R ≥ 1: the spins would never run out. */
  | 'PERPETUAL'
  /** No enabled sector at all, so a spin would have nothing to land on. */
  | 'NO_SECTORS'
  /**
   * No enabled "не повезло" sector.
   *
   * It is the one kind exempt from every ceiling, which is what keeps the
   * draw non-empty for every person at every instant. Without one, somebody
   * who has taken their one permanent discount and their one key can arrive
   * at a wheel with nothing left it may give them — and the only honest thing
   * left to do is refuse their spin.
   */
  | 'NO_LOSS_SECTOR';

/**
 * What stands between this configuration and a wheel that may be switched on.
 *
 * Returned as a list rather than as the first failure, because an operator
 * fixing a wheel wants to see the whole bill.
 */
export function readWheelBlockers(sectors: readonly EconomySector[]): readonly WheelBlocker[] {
  const blockers: WheelBlocker[] = [];
  const drawable = sectors.filter((sector) => sector.enabled && sector.weight > 0);

  if (drawable.length === 0) blockers.push('NO_SECTORS');
  if (!drawable.some((sector) => sector.kind === WheelSectorKind.NOTHING)) {
    blockers.push('NO_LOSS_SECTOR');
  }
  if (readWheelEconomy(sectors).perpetual) blockers.push('PERPETUAL');

  return blockers;
}
