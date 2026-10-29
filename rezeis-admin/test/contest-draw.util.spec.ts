import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  drawWeightedWinners,
  drawWinners,
  hashDrawSeed,
  newDrawSeed,
  seededRandom,
} from '../src/modules/contests/contest-draw.util';

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

describe('the source of chance behind a draw', () => {
  it('gives the same winners every time it is built from the same contest', () => {
    // THE POINT OF SEEDING. A draw that throws part way through rolls back to
    // ACTIVE and the sweep tries again a minute later. With a fresh source
    // each time, every retry picks a DIFFERENT field — so a contest whose
    // second prize cannot be paid would re-roll until it found a set that
    // could be. That is not a draw, it is a search for a payable outcome.
    const entrants = Array.from({ length: 40 }, (_, index) => `user-${index}`);

    const first = drawWinners({ entrants, count: 3, random: seededRandom('contest-a') });
    const again = drawWinners({ entrants, count: 3, random: seededRandom('contest-a') });

    assert.deepEqual(first, again);
  });

  it('gives different contests different winners', () => {
    // Seeded is not fixed: two giveaways running side by side must not hand
    // their prizes to the same people.
    const entrants = Array.from({ length: 40 }, (_, index) => `user-${index}`);

    const a = drawWinners({ entrants, count: 3, random: seededRandom('contest-a') });
    const b = drawWinners({ entrants, count: 3, random: seededRandom('contest-b') });

    assert.notDeepEqual(a, b);
  });

  it('stays inside [0, 1)', () => {
    const next = seededRandom('anything');
    for (let index = 0; index < 5000; index += 1) {
      const value = next();
      assert.ok(value >= 0 && value < 1, `out of range: ${value}`);
    }
  });
});

describe('the draw with tickets', () => {
  it('is roll for roll the old draw when everybody holds one ticket', () => {
    // Contests published before tickets existed must draw exactly as before.
    const random = seededRandom('contest-1');
    const again = seededRandom('contest-1');
    const people = ['e', 'b', 'd', 'a', 'c'];

    assert.deepEqual(
      drawWeightedWinners({ entrants: people.map((id) => ({ id, tickets: 1 })), count: 3, random }),
      drawWinners({ entrants: people, count: 3, random: again }),
    );
  });

  it('lands a roll inside the holder of the tickets it falls on', () => {
    // a holds 4 of 5 tickets: rolls below 0.8 are a's, the rest b's.
    const entrants = [
      { id: 'a', tickets: 4 },
      { id: 'b', tickets: 1 },
    ];
    assert.deepEqual(drawWeightedWinners({ entrants, count: 1, random: rolls(0.79) }), ['a']);
    assert.deepEqual(drawWeightedWinners({ entrants, count: 1, random: rolls(0.8) }), ['b']);
  });

  it('takes a person out once drawn: more tickets, never a second place', () => {
    const winners = drawWeightedWinners({
      entrants: [
        { id: 'whale', tickets: 1000 },
        { id: 'minnow', tickets: 1 },
      ],
      count: 2,
      // Sorted by id, the minnow's one ticket comes first: 0.5 of 1001 lands
      // in the whale's, and the second roll has only the minnow left.
      random: rolls(0.5, 0.5),
    });

    assert.deepEqual(winners, ['whale', 'minnow']);
  });

  it('favours the holder of more tickets in proportion, over many draws', () => {
    let wins = 0;
    const draws = 4000;
    for (let index = 0; index < draws; index += 1) {
      const [first] = drawWeightedWinners({
        entrants: [
          { id: 'three', tickets: 3 },
          { id: 'one', tickets: 1 },
        ],
        count: 1,
        random: seededRandom(`seed-${index}`),
      });
      if (first === 'three') wins += 1;
    }
    // Expected 75 %; four thousand draws put three standard deviations near 2 %.
    assert.ok(Math.abs(wins / draws - 0.75) < 0.03, `three tickets won ${wins} of ${draws}`);
  });

  it('treats a nonsense ticket count as the one ticket for entering', () => {
    const winners = drawWeightedWinners({
      entrants: [
        { id: 'a', tickets: 0 },
        { id: 'b', tickets: Number.NaN },
      ],
      count: 2,
      random: rolls(0.6, 0),
    });
    assert.deepEqual(winners, ['b', 'a']);
  });
});

describe('the draw key', () => {
  it('is a fresh 64-character hex seed whose hash is SHA-256', () => {
    const seed = newDrawSeed();
    assert.match(seed, /^[0-9a-f]{64}$/);
    assert.notEqual(seed, newDrawSeed(), 'two publications, two seeds');
    assert.equal(
      hashDrawSeed('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      'the published SHA-256 test vector, so anybody can check it with any tool',
    );
  });
});
