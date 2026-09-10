import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COINCIDENT_EVENT_GROUPS } from '../src/modules/automations/automations.constants';
import { EVENT_TYPES } from '../src/common/services/system-events.service';
import { POPUP_CAPABLE_EVENTS } from '../src/modules/automations/popup-capable-events';

/**
 * WHICH EVENTS ARRIVE TOGETHER — the list the collision warning is built from.
 *
 * A pop-up bound to each of two events that fire for one act is two pop-ups for
 * one act, and the editor's job is to say so before the operator saves. It can
 * only say it about pairs that are in this list, so a gap here is not a missing
 * warning in the abstract: it is a specific pair of ready-made templates that
 * can both be enabled in silence.
 *
 * The list is hand-written and cannot be derived — whether two events arrive
 * together is a fact about the flows this product runs, not about the
 * catalogue. What CAN be checked is that every name in it is real, that no pair
 * is one the product never actually produces, and that the retention half of
 * the template library is covered at all.
 */

const NAMES = new Set<string>(COINCIDENT_EVENT_GROUPS.flat());

describe('the coincident event groups', () => {
  it('has groups at all', () => {
    // Anti-emptiness anchor: `findHintCollisions` returns early when a trigger
    // is in no group, so an empty list silences every warning in the panel
    // while every case about the warning still passes.
    assert.ok(COINCIDENT_EVENT_GROUPS.length >= 5);
  });

  it('names only events the panel declares', () => {
    const declared = new Set<string>(Object.values(EVENT_TYPES));
    const unknown = [...NAMES].filter((name) => !declared.has(name));

    assert.deepEqual(unknown, [], 'a group names an event that does not exist');
  });

  it('never pairs an event with itself', () => {
    for (const group of COINCIDENT_EVENT_GROUPS) {
      assert.equal(new Set(group).size, group.length, group.join(' + '));
    }
  });

  it('covers the retention half of the pop-up library', () => {
    // THE GAP THAT MADE THE WARNING USELESS WHERE IT MATTERED. There was no
    // group containing any `remnawave.user.*` type or `user.first_traffic`, so
    // eleven of the twenty-one templates — the whole retention, limits and
    // security half — were outside the warning's reach entirely.
    const uncovered = [
      'remnawave.user.expired',
      'remnawave.user.limited',
      'remnawave.user.first_connected',
      'user.first_traffic',
      'fraud.signal_opened',
    ].filter((type) => !NAMES.has(type));

    assert.deepEqual(uncovered, [], 'these can collide with something and nothing says so');
  });

  it('does not pair two events that never fire for one person', () => {
    // `user.registered` and `user.web_registered` were grouped, with a comment
    // saying which one fires "depends on the door the customer came through" —
    // i.e. never both. Applying the library's first two cards then produced a
    // mutual warning for two rules that cannot collide, which is the first
    // warning a new operator sees and teaches them to dismiss the real ones.
    for (const group of COINCIDENT_EVENT_GROUPS) {
      assert.equal(
        group.includes('user.registered') && group.includes('user.web_registered'),
        false,
        'two doors into the product are grouped as if a customer used both',
      );
    }
  });

  it('groups only events a pop-up could actually be bound to', () => {
    // A group is only useful to the collision warning if a `show_hint` rule can
    // exist on both sides of it. A name here that cannot carry a pop-up is dead
    // weight that reads as coverage.
    const capable = new Set(POPUP_CAPABLE_EVENTS.map((event) => event.type));
    const inert = [...NAMES].filter((name) => !capable.has(name));

    // `subscription.renewed` and `subscription.upgraded` are declared, emitted
    // from nowhere, and grouped for the day they are emitted. Named here so
    // that a NEW inert entry has to be added deliberately.
    assert.deepEqual(inert.sort(), ['subscription.renewed', 'subscription.upgraded']);
  });
});
