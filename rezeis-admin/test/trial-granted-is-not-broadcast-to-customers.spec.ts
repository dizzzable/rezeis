import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { USER_EVENT_WHITELIST } from '../src/modules/realtime/interfaces/user-realtime-event.interface';

/**
 * AN OPERATOR'S SENTENCE MUST NOT ARRIVE ON A CUSTOMER'S SCREEN.
 *
 * `UserRealtimeService` forwards `projection.message ?? event.message`, so any
 * event on the whitelist whose projection does not override the message shows
 * the customer whatever the emitter wrote — and emitters write for the operator
 * feed: English, and naming the Remnawave profile, which is the operator's
 * configured prefix and suffix wrapped around the customer's own identifier.
 *
 * `subscription.trial_granted` sat on that list for as long as nothing emitted
 * it, which is exactly why nobody noticed. Giving it an emitter would have put
 * `Trial subscription provisioned: rz_<login>_vpn` on the screen of every
 * customer granted a trial — beside a second toast for `subscription.created`,
 * emitted one line earlier for the same act.
 *
 * This file pins the removal, and pins WHY, so that putting it back is a
 * decision rather than a tidy-up. The second case is the one that generalises:
 * it fails for any future entry that makes the same trade.
 */

const ROOT = join(__dirname, '..');

describe('the trial grant', () => {
  it('is not broadcast to customers', () => {
    assert.equal(
      Object.prototype.hasOwnProperty.call(USER_EVENT_WHITELIST, 'subscription.trial_granted'),
      false,
      'the trial event is customer-broadcast again — check its message names no panel profile ' +
        'and that it does not duplicate subscription.created',
    );
  });

  it('still names the panel profile in the message, which is why', () => {
    // Anti-emptiness anchor, and the reason the case above is not arbitrary.
    // If the emitter ever stops naming the profile, the entry could safely come
    // back — and this case going red is how anybody would find that out.
    const processor = readFileSync(
      join(ROOT, 'src', 'modules', 'profile-sync', 'profile-sync.processor.ts'),
      'utf8',
    );

    assert.match(processor, /message: `Trial subscription provisioned: \$\{panelUsername\}`/);
  });

  it('leaves subscription.created as the one notification for the act', () => {
    // The pair is emitted one line apart. Exactly one of them may be on the
    // customer's channel, or the customer is told twice for one provisioning.
    const onList = ['subscription.created', 'subscription.trial_granted'].filter((type) =>
      Object.prototype.hasOwnProperty.call(USER_EVENT_WHITELIST, type),
    );

    assert.deepEqual(onList, ['subscription.created']);
  });
});
