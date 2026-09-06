import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  mergeSupportSettings,
  toSupportLimits,
  toSupportSettingsView,
  type StoredSupportSettings,
} from '../src/modules/settings/utils/support-settings.util';

/**
 * The support settings round-trip
 * ═══════════════════════════════
 * A patch reaches the stored blob through exactly one function, and every
 * other layer had already learned about `purgeAttachmentsOnClose` — the DTO,
 * the view, the limits, the service that calls the merge — while the merge
 * body itself silently dropped it. The failure that produces is quiet and
 * complete: the operator flips the switch, the request answers 200, the
 * response says `false`, the switch snaps back, and closing a ticket never
 * purges anything. Nothing throws, so nothing is visible in a log.
 *
 * The manual purge button keeps working throughout, which is exactly what
 * makes a smoke test say the feature shipped.
 *
 * So these assert the WHOLE path — patch in, and out the far side through
 * `toSupportLimits`, which is what the ticket-close route actually reads.
 * Asserting the merged blob alone would let the same class of break through
 * one layer later.
 */

const STORED: StoredSupportSettings = {
  enabled: true,
  guestTokenTtlHours: 48,
  attachmentMaxMb: 5,
  attachmentMaxPerMsg: 3,
};

describe('mergeSupportSettings', () => {
  it('carries the purge-on-close switch all the way to the close route', () => {
    const next = mergeSupportSettings(STORED, { purgeAttachmentsOnClose: true });
    assert.equal(next.purgeAttachmentsOnClose, true);
    // `toSupportLimits` is what `close` consults; a value that survives the
    // merge but not this is still a dead switch.
    assert.equal(toSupportLimits(next).purgeAttachmentsOnClose, true);
    assert.equal(toSupportSettingsView(next).purgeAttachmentsOnClose, true);
  });

  it('turns it back off', () => {
    // The dangerous direction is the one that cannot be undone: an operator
    // who switched it on must be able to stop it.
    const on = mergeSupportSettings(STORED, { purgeAttachmentsOnClose: true });
    const off = mergeSupportSettings(on, { purgeAttachmentsOnClose: false });
    assert.equal(off.purgeAttachmentsOnClose, false);
    assert.equal(toSupportLimits(off).purgeAttachmentsOnClose, false);
  });

  it('leaves it alone when the patch does not mention it', () => {
    // The panel sends whole-form patches today, but a partial one must not
    // reset a switch the operator set on another visit.
    const on = mergeSupportSettings(STORED, { purgeAttachmentsOnClose: true });
    const next = mergeSupportSettings(on, { attachmentMaxMb: 6 });
    assert.equal(next.purgeAttachmentsOnClose, true);
    assert.equal(next.attachmentMaxMb, 6);
  });

  it('cannot promise a size the transport will not carry', () => {
    // A file rides as base64 inside a JSON body — 4 bytes per 3 — and the
    // panel's own parser stops at 10 MB. So anything above ~7.5 MiB is refused
    // before any of this code runs, by a component that has never heard of the
    // number the operator typed. A dialog offering 50 was offering a promise
    // the stack cannot keep, and the refusal it produced named the wrong cause.
    assert.equal(mergeSupportSettings(STORED, { attachmentMaxMb: 50 }).attachmentMaxMb, 7);
    assert.equal(mergeSupportSettings(STORED, { attachmentMaxMb: 8 }).attachmentMaxMb, 7);
    assert.equal(mergeSupportSettings(STORED, { attachmentMaxMb: 0 }).attachmentMaxMb, 1);
  });

  it('is off for an install that has never opened the screen', () => {
    // THE upgrade case. Absent means off — deleting a customer's evidence on
    // a schedule is not something an install can be opted into by upgrading.
    assert.equal(toSupportLimits(STORED).purgeAttachmentsOnClose, false);
    assert.equal(toSupportSettingsView(STORED).purgeAttachmentsOnClose, false);
  });

  it('does not disturb the neighbouring fields', () => {
    const next = mergeSupportSettings(STORED, { purgeAttachmentsOnClose: true });
    assert.equal(next.enabled, true);
    assert.equal(next.guestTokenTtlHours, 48);
    assert.equal(next.attachmentMaxMb, 5);
    assert.equal(next.attachmentMaxPerMsg, 3);
  });
});
