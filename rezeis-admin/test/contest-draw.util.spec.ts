import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { drawWinners } from '../src/modules/contests/contest-draw.util';

/** A random source that hands back exactly the rolls it was given. */
function rolls(...values: readonly number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

describe('the draw', () => {
  it('picks as many winners as there are places, never more than entrants', () => {
    const three = drawWinners({ entrants: ['a', 'b', 'c', 'd', 'e'], count: 3, random: rolls(0.5) });
    assert.equal(three.length, 3);

    const short = drawWinners({ entrants: ['a', 'b'], count: 5, random: rolls(0.5) });
    assert.equal(short.length, 2, 'two entrants cannot fill five places');
  });

  it('never picks the same person twice', () => {
    const winners = drawWinners({
      entrants: ['a', 'b', 'c', 'd'],
      count: 4,
      random: rolls(0, 0, 0, 0),
    });

    assert.equal(new Set(winners).size, 4);
  });

  it('does not depend on the order the entrants arrived in', () => {
    // The result depends only on WHO entered and the random source, so a
    // database that returned the rows in a different order draws the same
    // winners. That is what makes the draw auditable after the fact.
    const source = () => rolls(0.7, 0.2, 0.9);

    const one = drawWinners({ entrants: ['c', 'a', 'b', 'd'], count: 2, random: source() });
    const two = drawWinners({ entrants: ['d', 'b', 'a', 'c'], count: 2, random: source() });

    assert.deepEqual(one, two);
  });

  it('is uniform: every entrant is picked the same share of the time', () => {
    // Not a test of randomness — a test that no position in the list is
    // favoured. 1,000 draws of one winner from four with a counter source
    // that walks [0, 1) evenly must land 250 times on each.
    const counts = new Map<string, number>();
    for (let step = 0; step < 1000; step += 1) {
      const [winner] = drawWinners({
        entrants: ['a', 'b', 'c', 'd'],
        count: 1,
        random: () => step / 1000,
      });
      counts.set(winner as string, (counts.get(winner as string) ?? 0) + 1);
    }

    assert.deepEqual([...counts.values()], [250, 250, 250, 250]);
  });

  it('orders the winners by the order they came out: first out is first prize', () => {
    // With a source that always rolls zero, the first pick is the first
    // remaining entrant, and so on — so the places follow the sorted ids.
    const winners = drawWinners({ entrants: ['b', 'a', 'c'], count: 3, random: rolls(0) });

    assert.deepEqual(winners, ['a', 'b', 'c']);
  });

  it('ignores a duplicate entrant id', () => {
    const winners = drawWinners({ entrants: ['a', 'a', 'a', 'b'], count: 3, random: rolls(0) });

    assert.deepEqual(winners, ['a', 'b']);
  });

  it('survives a source that misbehaves', () => {
    for (const bad of [1, 2, -1, Number.NaN]) {
      const winners = drawWinners({ entrants: ['a', 'b', 'c'], count: 2, random: rolls(bad) });
      assert.equal(winners.length, 2, String(bad));
      assert.equal(new Set(winners).size, 2, String(bad));
    }
  });

  it('draws nobody from nobody', () => {
    assert.deepEqual(drawWinners({ entrants: [], count: 3, random: rolls(0.5) }), []);
    assert.deepEqual(drawWinners({ entrants: ['a'], count: 0, random: rolls(0.5) }), []);
  });
});
