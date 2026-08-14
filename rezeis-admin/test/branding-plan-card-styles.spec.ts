import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  mergeBrandingSettings,
  readBrandingSettings,
} from '../src/modules/settings/utils/branding-settings.util';

test('planCardStyles defaults to {} when absent', () => {
  assert.deepEqual(readBrandingSettings(null).planCardStyles, {});
  assert.deepEqual(readBrandingSettings({}).planCardStyles, {});
});

test('planCardStyles round-trips a full valid per-plan style', () => {
  const branding = readBrandingSettings({
    planCardStyles: {
      plan_abc: {
        gradient: 'linear-gradient(135deg, #064e3b, #22c55e)',
        accent: '#22c55e',
        texturePreset: 'dots',
        textureUrl: '/uploads/branding/tex.png',
      },
    },
  });
  assert.deepEqual(branding.planCardStyles['plan_abc'], {
    gradient: 'linear-gradient(135deg, #064e3b, #22c55e)',
    accent: '#22c55e',
    texturePreset: 'dots',
    textureUrl: '/uploads/branding/tex.png',
  });
});

test('planCardStyles drops invalid accent + unknown texture preset', () => {
  const branding = readBrandingSettings({
    planCardStyles: {
      p1: { gradient: 'linear-gradient(90deg,#111,#222)', accent: 'not-a-hex', texturePreset: 'nope' },
    },
  });
  assert.deepEqual(branding.planCardStyles['p1'], {
    gradient: 'linear-gradient(90deg,#111,#222)',
  });
});

test('planCardStyles rejects an unsafe textureUrl', () => {
  const branding = readBrandingSettings({
    planCardStyles: {
      p1: { accent: '#ffffff', textureUrl: 'javascript:alert(1)' },
    },
  });
  assert.deepEqual(branding.planCardStyles['p1'], { accent: '#ffffff' });
});

test('planCardStyles skips entries with no usable styling', () => {
  const branding = readBrandingSettings({
    planCardStyles: {
      empty: { gradient: '   ', accent: 'bad' },
      ok: { accent: '#abcdef' },
    },
  });
  assert.equal(branding.planCardStyles['empty'], undefined);
  assert.deepEqual(branding.planCardStyles['ok'], { accent: '#abcdef' });
});

test('planCardStyles tolerates a non-object map (→ {})', () => {
  assert.deepEqual(readBrandingSettings({ planCardStyles: 'oops' }).planCardStyles, {});
  assert.deepEqual(readBrandingSettings({ planCardStyles: [1, 2] }).planCardStyles, {});
});

test('planCardStyles keeps orphan plan ids (harmless; readers ignore unknowns)', () => {
  const branding = readBrandingSettings({
    planCardStyles: { deleted_plan_id: { accent: '#123456' } },
  });
  assert.deepEqual(branding.planCardStyles['deleted_plan_id'], { accent: '#123456' });
});

/*
 * The per-plan `text` policy.
 *
 * Absence means inherit, so the normalizer's job is mostly deciding what NOT to
 * store: the values below all mean "no per-plan decision" and must leave the
 * entry indistinguishable from one an operator never opened. The panel's Zod
 * schema refuses most of them before they reach an API, so these cases are the
 * only guard on the paths a hand-edited payload, an older client or a future
 * one can still take.
 */
test('planCardStyles keeps a per-plan text policy, including a text-only entry', () => {
  const branding = readBrandingSettings({
    planCardStyles: {
      both: { accent: '#abcdef', text: { mode: 'dark', color: null } },
      // The entry that "no usable field → skip" would silently delete. A plan
      // whose only decision is its text colour is a configured plan.
      textOnly: { text: { mode: 'custom', color: '  #22C55E  ' } },
    },
  });
  assert.deepEqual(branding.planCardStyles['both'], {
    accent: '#abcdef',
    text: { mode: 'dark', color: null },
  });
  assert.deepEqual(branding.planCardStyles['textOnly'], {
    text: { mode: 'custom', color: '#22C55E' },
  });
});

test('planCardStyles stores nothing for a text that carries no decision', () => {
  const branding = readBrandingSettings({
    planCardStyles: {
      // Inherit is what an absent key already does — storing it would make an
      // install that chose inherit differ from one that never opened the
      // control.
      inherit: { accent: '#abcdef', text: { mode: 'inherit', color: null } },
      // `custom` with nothing usable: dropping the whole field returns the card
      // to the global policy rather than to an arbitrary foreground.
      noColour: { accent: '#abcdef', text: { mode: 'custom', color: null } },
      // Alpha is refused for the same reason as on the global control: a
      // translucent foreground renders differently over every gradient.
      alpha: { accent: '#abcdef', text: { mode: 'custom', color: '#22c55eff' } },
      unknownMode: { accent: '#abcdef', text: { mode: 'gradient-aware', color: null } },
      notAnObject: { accent: '#abcdef', text: 'light' },
    },
  });
  for (const planId of ['inherit', 'noColour', 'alpha', 'unknownMode', 'notAnObject']) {
    assert.deepEqual(branding.planCardStyles[planId], { accent: '#abcdef' }, planId);
  }
});

test('planCardStyles skips an entry whose only field is an inherited text', () => {
  // The combination of the two rules above: nothing usable is left, so the
  // whole entry goes, and the plan reads as unconfigured again.
  const branding = readBrandingSettings({
    planCardStyles: { p1: { text: { mode: 'inherit', color: null } } },
  });
  assert.equal(branding.planCardStyles['p1'], undefined);
});

test('planCardStyles survives a merge patch round-trip', () => {
  const existing = { brandName: 'Acme', planCardStyles: { p1: { accent: '#111111' } } };
  const merged = mergeBrandingSettings({
    existing,
    patch: { planCardStyles: { p2: { gradient: 'linear-gradient(0deg,#000,#fff)' } } },
  });
  const reread = readBrandingSettings(merged);
  // Patch replaces the whole map (object-level merge), as with iconColors.
  assert.equal(reread.planCardStyles['p1'], undefined);
  assert.deepEqual(reread.planCardStyles['p2'], {
    gradient: 'linear-gradient(0deg,#000,#fff)',
  });
});
