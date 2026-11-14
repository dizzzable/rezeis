import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canFaceMergedLink,
  orderBundleMembers,
  resolveVisibleMember,
  resolveVisiblePlanId,
} from '../src/modules/merge-links/utils/visible-plan.util';

type Member = {
  readonly planId: string;
  readonly isVisibleInApp: boolean;
  readonly plan: { readonly orderIndex: number; readonly trafficLimit: number | null };
};

function member(
  planId: string,
  orderIndex: number,
  trafficLimit: number | null,
  isVisibleInApp = false,
): Member {
  return { planId, isVisibleInApp, plan: { orderIndex, trafficLimit } };
}

/**
 * The owner's rule (14.11.2026), pinned where all three readers take it from:
 * the admin dialog, the merge service and the plan a bundle is issued as.
 * An app that reads «unlimited» hides the limit the other half of the bundle
 * still has to show, so an unlimited plan may never be the face.
 */
describe('bundle visible plan', () => {
  it('keeps the bundle in its display order', () => {
    const ordered = orderBundleMembers([member('second', 2, 50), member('first', 1, null)]);

    assert.deepStrictEqual(
      ordered.map((entry) => entry.planId),
      ['first', 'second'],
    );
  });

  it('uses the operator’s explicit choice while it still has a traffic limit', () => {
    const members = [member('unlimited', 1, null), member('limited-50', 2, 50, true)];

    assert.equal(resolveVisiblePlanId(members), 'limited-50');
    assert.equal(resolveVisibleMember(members)?.planId, 'limited-50');
  });

  it('ignores an explicit flag left on an unlimited plan and falls back to the limited one', () => {
    // The member was limited when the operator chose it and was later flipped
    // to unlimited. Keeping the flag would make the merged link report
    // «unlimited» while the other plan's limit went unwatched.
    const members = [member('unlimited', 1, null, true), member('limited-50', 2, 50)];

    assert.equal(resolveVisiblePlanId(members), 'limited-50');
  });

  it('defaults to the first limited plan when the operator chose none', () => {
    const members = [member('unlimited', 1, null), member('limited-30', 2, 30), member('limited-50', 3, 50)];

    assert.equal(resolveVisiblePlanId(members), 'limited-30');
  });

  it('falls back to the first plan when every member is unlimited', () => {
    // Nothing limited exists to watch, and leaving the app without a name would
    // be worse than naming one of them.
    const members = [member('unlimited-a', 1, null), member('unlimited-b', 2, null)];

    assert.equal(resolveVisiblePlanId(members), 'unlimited-a');
    assert.equal(resolveVisiblePlanId([]), null);
  });

  it('refuses the face to an unlimited plan', () => {
    assert.equal(canFaceMergedLink({ trafficLimit: null }), false);
    assert.equal(canFaceMergedLink({ trafficLimit: 0 }), true);
    assert.equal(canFaceMergedLink({ trafficLimit: 50 }), true);
  });
});
