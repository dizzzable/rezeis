/**
 * Who wins, and in which order.
 *
 * ── Uniform over people ───────────────────────────────────────────────────
 *
 * Every entrant has exactly one entry — the database says so — and the draw
 * picks `count` of them without replacement, each remaining entrant equally
 * likely at each step. That is a partial Fisher–Yates shuffle, and it is the
 * whole of the fairness argument: nobody can buy a better chance, and the
 * order the winners come out in IS the order of the places, so first prize is
 * as random as last.
 *
 * ── Order does not matter ─────────────────────────────────────────────────
 *
 * The entrants are sorted by id before the draw, so the result depends only
 * on WHO entered and the random source — never on the order the database
 * happened to return rows in. With a fixed source the same field gives the
 * same winners, which is what makes the draw testable and, if it ever came
 * to it, auditable.
 *
 * `random` must return a number in [0, 1). `Math.random` in production; a
 * fixed sequence in the tests, for the same reason the wheel's draw takes one.
 */
export function drawWinners(input: {
  readonly entrants: readonly string[];
  readonly count: number;
  readonly random: () => number;
}): readonly string[] {
  const pool = [...new Set(input.entrants)].sort();
  const wanted = Math.max(0, Math.min(Math.trunc(input.count), pool.length));

  for (let index = 0; index < wanted; index += 1) {
    const roll = input.random();
    const bounded = Number.isFinite(roll) ? Math.min(Math.max(roll, 0), 0.999999999999) : 0;
    // Pick from what is left, then swap it into the taken prefix.
    const pick = index + Math.floor(bounded * (pool.length - index));
    const chosen = pool[pick] as string;
    pool[pick] = pool[index] as string;
    pool[index] = chosen;
  }

  return pool.slice(0, wanted);
}

/**
 * A repeatable source of chance, derived from the contest id.
 *
 * FNV-1a into mulberry32: small, uniform enough for a shuffle, and — the
 * whole point — the SAME sequence every time it is built from the same
 * contest. See the note in `draw` for why that matters.
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

