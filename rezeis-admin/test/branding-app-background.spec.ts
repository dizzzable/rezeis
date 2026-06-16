import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readBrandingSettings,
  mergeBrandingSettings,
} from '../src/modules/settings/utils/branding-settings.util';
import { DEFAULT_BRANDING } from '../src/modules/settings/interfaces/branding-settings.interface';

test('readBrandingSettings defaults appBackground to none when absent', () => {
  const branding = readBrandingSettings(null);
  assert.equal(branding.appBackground.kind, 'none');
  assert.equal(branding.appBackground.effect, 'NONE');
  assert.deepEqual(branding.appBackground, DEFAULT_BRANDING.appBackground);
});

test('readBrandingSettings infers kind=effect for a legacy effect-only payload', () => {
  const branding = readBrandingSettings({
    appBackground: { effect: 'aurora', props: { speed: 2 }, opacity: 0.5 },
  });
  assert.equal(branding.appBackground.kind, 'effect');
  assert.equal(branding.appBackground.effect, 'aurora');
  assert.deepEqual(branding.appBackground.props, { speed: 2 });
  assert.equal(branding.appBackground.opacity, 0.5);
});

test('readBrandingSettings round-trips a gradient app background', () => {
  const branding = readBrandingSettings({
    appBackground: { kind: 'gradient', gradient: 'linear-gradient(90deg, #111, #222)' },
  });
  assert.equal(branding.appBackground.kind, 'gradient');
  assert.equal(branding.appBackground.gradient, 'linear-gradient(90deg, #111, #222)');
});

test('readBrandingSettings round-trips a texture app background and clamps/validates it', () => {
  const branding = readBrandingSettings({
    appBackground: {
      kind: 'texture',
      texture: { pattern: 'grid', color: '#ff0000', background: '#000000', scale: 999, opacity: 5 },
    },
  });
  assert.equal(branding.appBackground.kind, 'texture');
  assert.equal(branding.appBackground.texture.pattern, 'grid');
  assert.equal(branding.appBackground.texture.color, '#ff0000');
  assert.equal(branding.appBackground.texture.scale, 256); // clamped
  assert.equal(branding.appBackground.texture.opacity, 1); // clamped
});

test('readBrandingSettings falls back unknown texture pattern to default', () => {
  const branding = readBrandingSettings({
    appBackground: { kind: 'texture', texture: { pattern: 'nope' } },
  });
  assert.equal(branding.appBackground.texture.pattern, DEFAULT_BRANDING.appBackground.texture.pattern);
});

test('readBrandingSettings rejects an unknown effect id (→ NONE)', () => {
  const branding = readBrandingSettings({
    appBackground: { kind: 'effect', effect: 'not-a-real-effect', props: {}, opacity: 1 },
  });
  assert.equal(branding.appBackground.effect, 'NONE');
});

test('readBrandingSettings ignores a non-object appBackground (→ default)', () => {
  const branding = readBrandingSettings({ appBackground: 'oops' });
  assert.deepEqual(branding.appBackground, DEFAULT_BRANDING.appBackground);
});

test('mergeBrandingSettings preserves an unrelated existing appBackground', () => {
  const existing = {
    appBackground: { kind: 'effect', effect: 'galaxy', props: {}, opacity: 0.8 },
  };
  const merged = mergeBrandingSettings({ existing, patch: { brandName: 'Acme' } });
  const reread = readBrandingSettings(merged);
  assert.equal(reread.appBackground.effect, 'galaxy');
  assert.equal(reread.appBackground.kind, 'effect');
  assert.equal(reread.brandName, 'Acme');
});

test('mergeBrandingSettings overwrites appBackground when patched', () => {
  const existing = {
    appBackground: { kind: 'effect', effect: 'galaxy', props: {}, opacity: 0.8 },
  };
  const merged = mergeBrandingSettings({
    existing,
    patch: { appBackground: { kind: 'none', effect: 'NONE', props: {}, opacity: 1 } },
  });
  const reread = readBrandingSettings(merged);
  assert.equal(reread.appBackground.kind, 'none');
});
