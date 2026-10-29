import { createHash, randomBytes } from 'node:crypto';

/** One entrant and how many tickets they hold. At least one: the entry itself. */
export interface WeightedEntrant {
  readonly id: string;
  readonly tickets: number;
}

/**
 * Who wins, and in which order.
 *
 * ── One place per person, chances by tickets ──────────────────────────────
 *
 * Every entrant has exactly one entry — the database says so — and holds one
 * ticket for it, plus whatever the contest gives for a purchase or a friend
 * who paid inside the window (the owner, 29.10.2026). The draw picks `count`
 * people without replacement, each remaining person as likely as their share
 * of the remaining tickets. Once drawn, a person is out: more tickets buy a
 * better chance of a place, never a second place.
 *
 * With every entrant on one ticket this is a plain partial Fisher–Yates
 * shuffle, roll for roll the same as the draw before tickets existed. The
 * order the winners come out in IS the order of the places, so first prize is
 * as random as last.
 *
 * ── Order does not matter ─────────────────────────────────────────────────
 *
 * The entrants are sorted by id before the draw, so the result depends only
 * on WHO entered, with how many tickets, and the source of chance — never on
 * the order the database returned rows in. With a fixed source the same field
 * gives the same winners, which is what makes the draw testable, retryable
 * (see `ContestService.draw`) and checkable after the fact.
 *
 * `random` must return a number in [0, 1).
 */
export function drawWeightedWinners(input: {
  readonly entrants: readonly WeightedEntrant[];
  readonly count: number;
  readonly random: () => number;
}): readonly string[] {
  const byId = new Map<string, number>();
  for (const entrant of input.entrants) {
    // A duplicate id keeps its larger holding rather than counting twice.
    const tickets = Math.max(1, Math.trunc(entrant.tickets) || 1);
    byId.set(entrant.id, Math.max(byId.get(entrant.id) ?? 0, tickets));
  }
  const pool = [...byId.keys()].sort();
  const weights = pool.map((id) => byId.get(id) as number);
  const wanted = Math.max(0, Math.min(Math.trunc(input.count), pool.length));

  let remaining = weights.reduce((sum, weight) => sum + weight, 0);
  for (let index = 0; index < wanted; index += 1) {
    const roll = input.random();
    const bounded = Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 0.999999999999) : 0;
    // Walk what is left until the roll falls inside somebody's tickets, then
    // swap them into the taken prefix.
    const target = Math.floor(bounded * remaining);
    let pick = index;
    let reached = weights[index] as number;
    while (reached <= target && pick < pool.length - 1) {
      pick += 1;
      reached += weights[pick] as number;
    }
    [pool[index], pool[pick]] = [pool[pick] as string, pool[index] as string];
    [weights[index], weights[pick]] = [weights[pick] as number, weights[index] as number];
    remaining -= weights[index] as number;
  }

  return pool.slice(0, wanted);
}

/** The draw with one ticket each: who entered, and nothing else. */
export function drawWinners(input: {
  readonly entrants: readonly string[];
  readonly count: number;
  readonly random: () => number;
}): readonly string[] {
  return drawWeightedWinners({
    entrants: input.entrants.map((id) => ({ id, tickets: 1 })),
    count: input.count,
    random: input.random,
  });
}

/**
 * A repeatable source of chance, derived from a seed.
 *
 * FNV-1a into mulberry32: small, uniform enough for a shuffle, and — the
 * whole point — the SAME sequence every time it is built from the same seed.
 * See the note in `ContestService.draw` for why that matters.
 */
export function seededRandom(seed: string): () => number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  let state = hash >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The seed a contest draws from, made when it is published.
 *
 * It used to be the contest id, which exists from the moment the draft is
 * saved — anybody who could read the entrants could work out the winners
 * before the end. A seed made at publish and kept out of every answer until
 * the draw closes that; its hash is shown from the start, so the seed shown
 * afterwards can be checked against what was promised.
 */
export function newDrawSeed(): string {
  return randomBytes(32).toString('hex');
}

/** What the cabinet shows while the contest runs: SHA-256 of the seed, hex. */
export function hashDrawSeed(seed: string): string {
  return createHash('sha256').update(seed, 'utf8').digest('hex');
}
