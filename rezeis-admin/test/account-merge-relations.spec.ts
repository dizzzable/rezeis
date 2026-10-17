import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MERGE_DROPS } from '../src/modules/account-merge/services/account-merge.service';

/**
 * Every child table of `User` is the merge's to move — or named, with a reason,
 * as one it leaves behind.
 *
 * The merge re-points the merged-away account's rows onto the survivor and
 * then deletes it, so a table it does not know is decided by the schema: a
 * Cascade relation dies with the account, a SetNull one is orphaned, and only
 * a Restrict one would make the merge fail loudly. Twelve tables grew after the
 * service was written and were lost or orphaned that quietly until 17.10.2026 —
 * among them the wheel spins, and the customer's autopay at the provider,
 * which the orphan sweep then cancelled.
 *
 * This reads `schema.prisma` and the service's source, so a new relation onto
 * `User` fails here until somebody decides what a merge does with it.
 */

const ROOT = join(__dirname, '..');
const schema = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
const service = readFileSync(
  join(ROOT, 'src', 'modules', 'account-merge', 'services', 'account-merge.service.ts'),
  'utf8',
);

interface Relation {
  readonly model: string;
  readonly field: string;
}

/** Every `<field> User[?] @relation(…)` in the schema, by model. */
function relationsOntoUser(): Relation[] {
  const relations: Relation[] = [];
  for (const [, model, body] of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    if (model === 'User') continue;
    for (const line of body.split(/\r?\n/)) {
      const match = line.match(/^\s+(\w+)\s+User\??\s+@relation\(/);
      if (match) relations.push({ model, field: match[1] });
    }
  }
  return relations;
}

/** The Prisma delegate of a model: `PointsLedgerEntry` → `pointsLedgerEntry`. */
const delegateOf = (model: string): string => model[0].toLowerCase() + model.slice(1);

describe('the account merge and the child tables of User', () => {
  const relations = relationsOntoUser();

  it('finds the relations at all', () => {
    // A regex that matched nothing would pass every check below.
    assert.ok(relations.length > 30, `only ${relations.length} relations onto User were found`);
    assert.ok(relations.some((r) => r.model === 'Subscription'));
  });

  it('moves every one of them, or names it as one it leaves behind', () => {
    const forgotten = relations
      .filter((r) => !service.includes(`tx.${delegateOf(r.model)}.`))
      .filter((r) => MERGE_DROPS[r.model] === undefined)
      .map((r) => `${r.model}.${r.field}`);
    assert.deepEqual(
      forgotten,
      [],
      'a merge would let the delete decide for these: move them in AccountMergeService, or add them to MERGE_DROPS with the reason',
    );
  });

  it('names nothing it actually moves, and nothing the schema no longer has', () => {
    for (const model of Object.keys(MERGE_DROPS)) {
      assert.ok(
        relations.some((r) => r.model === model),
        `${model} is in MERGE_DROPS but is no child of User`,
      );
      assert.ok(!service.includes(`tx.${delegateOf(model)}.`), `${model} is in MERGE_DROPS and moved too`);
    }
  });
});
