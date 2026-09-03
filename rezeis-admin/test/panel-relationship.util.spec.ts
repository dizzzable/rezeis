import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PANEL_VERDICT_MIN_EVIDENCE,
  decidePanelRelationship,
  type PanelIdentitySample,
} from '../src/modules/imports/utils/panel-relationship.util';
import type { PanelLookup } from '../src/modules/imports/utils/remnawave-overlay.util';

/**
 * Telling "this profile was deleted" from "this is not our panel".
 *
 * Both look identical on one row, and getting it wrong is not symmetric: read a
 * panel move as a thousand deletions and the import writes EXPIRED across a
 * whole paying customer base; read a thousand deletions as a panel move and it
 * provisions some profiles nobody needed. Every rule below exists to keep the
 * verdict on the evidence rather than on whichever mistake is cheaper.
 */

function lookup(overrides: Partial<PanelLookup> = {}): PanelLookup {
  return {
    map: new Map(),
    reachable: true,
    complete: true,
    keyKind: 'id',
    ...overrides,
  };
}

function samples(count: number, from = 1): PanelIdentitySample[] {
  return Array.from({ length: count }, (_, i) => ({
    anchor: String(from + i),
    telegramId: 100 + from + i,
  }));
}

/** A resolver that answers the same thing for every identifier. */
const always = (answer: { panel: { telegramId?: number | null } | null; known: boolean }) => {
  return () => Promise.resolve(answer);
};

const ABSENT = always({ panel: null, known: true });
const UNCONFIRMED = always({ panel: null, known: false });

describe('when the verdict refuses to be taken', () => {
  it('says nothing at all about an unreachable panel', async () => {
    // Silence is not evidence of a move. Read as one, the next panel outage
    // would orphan every subscription in the file and provision a duplicate
    // profile for every customer who already had a working one.
    const verdict = await decidePanelRelationship({
      samples: samples(50),
      lookup: lookup({ reachable: false }),
      resolve: ABSENT,
    });

    assert.equal(verdict.relationship, 'unknown');
    assert.equal(verdict.sampled, 0);
  });

  it('will not read a handful of deletions as a migration', async () => {
    // An operator who deleted four profiles last week is not an operator who
    // changed panels, and on a base this small either branch is undone by hand.
    const verdict = await decidePanelRelationship({
      samples: samples(PANEL_VERDICT_MIN_EVIDENCE - 1),
      lookup: lookup(),
      resolve: ABSENT,
    });

    assert.equal(verdict.relationship, 'unknown');
  });

  it('keeps quiet when the panel could not confirm anything', async () => {
    // A truncated list whose per-profile confirmations all came back as
    // timeouts and 502s knows exactly as much as it did before it asked.
    const verdict = await decidePanelRelationship({
      samples: samples(20),
      lookup: lookup({ complete: false }),
      resolve: UNCONFIRMED,
    });

    assert.equal(verdict.relationship, 'unknown');
    assert.equal(verdict.unconfirmed, 20);
    assert.equal(verdict.absent, 0);
  });

  it('counts one identifier once, however many rows carry it', async () => {
    // Single-tariff Bedolaga puts the panel id on the USER, so every one of a
    // person's subscriptions repeats it. Ten rows from one customer are one
    // fact about the panel, and letting them vote ten times is how five
    // customers become "enough evidence".
    const repeated: PanelIdentitySample[] = Array.from({ length: 40 }, () => ({
      anchor: '7',
      telegramId: 700,
    }));

    const verdict = await decidePanelRelationship({
      samples: repeated,
      lookup: lookup(),
      resolve: ABSENT,
    });

    assert.equal(verdict.sampled, 1);
    assert.equal(verdict.relationship, 'unknown');
  });
});

describe('when the panel is the one these customers were on', () => {
  it('accepts a single identifier that resolves to the right person', async () => {
    const verdict = await decidePanelRelationship({
      samples: samples(10),
      lookup: lookup(),
      resolve: (anchor) =>
        Promise.resolve(
          anchor === '3'
            ? { panel: { telegramId: 103 }, known: true }
            : { panel: null, known: true },
        ),
    });

    assert.equal(verdict.relationship, 'same');
    assert.equal(verdict.matchedOwners, 1);
  });

  it('does not need an owner on both sides to keep working as before', async () => {
    // Web accounts carry no telegram id, and neither does a profile the
    // operator made by hand. Nobody can vote, so the verdict stays `unknown`
    // and the importer behaves exactly as it did before this file existed.
    const anonymous = samples(10).map((s) => ({ ...s, telegramId: null }));

    const verdict = await decidePanelRelationship({
      samples: anonymous,
      lookup: lookup(),
      resolve: always({ panel: { telegramId: null }, known: true }),
    });

    assert.equal(verdict.relationship, 'unknown');
    assert.equal(verdict.matchedOwners, 0);
    assert.equal(verdict.mismatchedOwners, 0);
  });
});

describe('when the panel is somebody else entirely', () => {
  it('reads a complete list that has none of them as a different install', async () => {
    const verdict = await decidePanelRelationship({
      samples: samples(30),
      lookup: lookup(),
      resolve: ABSENT,
    });

    assert.equal(verdict.relationship, 'different');
    assert.equal(verdict.absent, 25, 'the sample is bounded — it does not walk the whole dump');
  });

  it('reads ids that resolve to STRANGERS as a different install', async () => {
    // THE CASE A MISS WOULD NEVER CATCH. Remnawave 3.x numbers users from one,
    // so a fresh panel already has an id 5 — belonging to somebody else. Most
    // identifiers HIT; every hit is the wrong person.
    const verdict = await decidePanelRelationship({
      samples: samples(20),
      lookup: lookup(),
      resolve: always({ panel: { telegramId: 999_999 }, known: true }),
    });

    assert.equal(verdict.relationship, 'different');
    assert.equal(verdict.mismatchedOwners, 20);
  });

  it('settles a uuid-keyed panel without asking it anything', async () => {
    // A panel still on 2.x keys profiles by uuid; the backup carries the
    // numeric ids a 3.x Bedolaga wrote. Not one of them could ever resolve
    // there, and that is a fact about the two schemas — no call needed.
    let asked = 0;
    const verdict = await decidePanelRelationship({
      samples: samples(20),
      lookup: lookup({ keyKind: 'uuid' }),
      resolve: () => {
        asked += 1;
        return Promise.resolve({ panel: null, known: false });
      },
    });

    assert.equal(verdict.relationship, 'different');
    assert.equal(asked, 0);
  });

  it('refuses to decide when the panel answers both ways', async () => {
    // Some resolve to the right person and some to strangers: a half-migrated
    // panel, or a dump taken across one. Guessing either way moves somebody's
    // subscription, so the per-row owner check gets to refuse them one by one.
    const verdict = await decidePanelRelationship({
      samples: samples(20),
      lookup: lookup(),
      resolve: (anchor) =>
        Promise.resolve({
          panel: { telegramId: Number(anchor) % 2 === 0 ? 100 + Number(anchor) : 999_999 },
          known: true,
        }),
    });

    assert.equal(verdict.relationship, 'unknown');
    assert.ok(verdict.matchedOwners > 0 && verdict.mismatchedOwners > 0);
  });
});
