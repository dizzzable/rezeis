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
