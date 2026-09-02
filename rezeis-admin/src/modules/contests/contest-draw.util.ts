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
