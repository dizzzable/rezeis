/**
 * The brand-mark presentation settings, from a PATCH body to what the cabinet
 * reads back.
 *
 * Every test crosses the real storage boundary — merge, JSON round-trip, read —
 * the same three steps `SettingsService` performs, and asserts the STORED
 * result. A reader that clamps correctly and a merge that discards the object
 * are each green in isolation; the seam is where this project's defects live.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BrandingSettingsInterface,
  DEFAULT_BRANDING,
} from '../src/modules/settings/interfaces/branding-settings.interface';
import {
  mergeBrandingSettings,
  readBrandingSettings,
} from '../src/modules/settings/utils/branding-settings.util';

function save(
  existing: unknown,
  patch: Partial<Record<keyof BrandingSettingsInterface, unknown>>,
): BrandingSettingsInterface {
  return readBrandingSettings(
    JSON.parse(JSON.stringify(mergeBrandingSettings({ existing, patch }))),
  );
}

describe('brandLogo', () => {
  it('reproduces the pre-setting rendering for a row that predates it', () => {
    // Every existing installation is this row. The tile drew an 80 px plate
    // holding a 44 px mark, and its corners came from the THEME
    // (`rounded-3xl` = `calc(var(--radius) * 2.2)`) — which is why the radius
    // default is `null` and not a percentage: a number here would have
    // restyled the first screen of every deployment whose theme is not at the
    // stock item radius.
    assert.deepEqual(readBrandingSettings({}).brandLogo, {
      size: 1,
      fill: 0.58,
      frame: 'glass',
      radius: null,
      glow: 1,
    });
  });

  it('keeps an explicit radius and returns to the theme on null', () => {
    assert.equal(save({}, { brandLogo: { radius: 18 } }).brandLogo.radius, 18);
    const explicit = mergeBrandingSettings({
      existing: {},
      patch: { brandLogo: { radius: 18 } },
    });
    // `null` is how the operator switches the control back off, so it has to
    // survive the merge as a value rather than be treated as "field absent".
    assert.equal(save(explicit, { brandLogo: { radius: null } }).brandLogo.radius, null);
  });

  it('stores what the operator sent', () => {
    const stored = save({}, {
      brandLogo: { size: 1.4, fill: 0.92, frame: 'none', radius: 12, glow: 0 },
    });
    assert.deepEqual(stored.brandLogo, {
      size: 1.4,
      fill: 0.92,
      frame: 'none',
      radius: 12,
      glow: 0,
    });
  });

  it('merges one moved knob over the stored object instead of replacing it', () => {
    // The panel sends the whole object today, but the DTO makes every member
    // optional and the merge is what makes that safe. Without the special case
    // this field takes, `{ brandLogo: { fill: 1 } }` would reset the other four
    // to defaults — the same shape of defect that once carried one card
    // effect's tuning onto its replacement.
    const existing = mergeBrandingSettings({
      existing: {},
      patch: { brandLogo: { size: 1.5, fill: 0.7, frame: 'outline', radius: 8, glow: 0.2 } },
    });
    const stored = save(existing, { brandLogo: { fill: 1 } });
    assert.deepEqual(stored.brandLogo, {
      size: 1.5,
      fill: 1,
      frame: 'outline',
      radius: 8,
      glow: 0.2,
    });
  });

  it('clamps an out-of-range number rather than discarding the object', () => {
    const stored = save({}, {
      brandLogo: { size: 99, fill: -1, frame: 'solid', radius: 4000, glow: 12 },
    });
    assert.deepEqual(stored.brandLogo, {
      size: 1.75,
      fill: 0.4,
      frame: 'solid',
      radius: 50,
      glow: 1,
    });
    assert.equal(save({}, { brandLogo: { radius: -80 } }).brandLogo.radius, 0);
  });

  it('keeps the familiar plate for a frame name it does not recognise', () => {
    const stored = save({}, { brandLogo: { frame: 'etched-neon' } });
    assert.equal(stored.brandLogo.frame, 'glass');
  });

  it('keeps the readable members when a sibling is the wrong type', () => {
    const stored = save({}, { brandLogo: { fill: 0.85, size: 'large', glow: null } });
    assert.equal(stored.brandLogo.fill, 0.85);
    // An unreadable radius lands on "follow the theme" — the same place a
    // legacy row lands, and the only safe reading of a value nobody can parse.
    assert.equal(save({}, { brandLogo: { radius: 'round' } }).brandLogo.radius, null);
    assert.equal(stored.brandLogo.size, DEFAULT_BRANDING.brandLogo.size);
    assert.equal(stored.brandLogo.glow, DEFAULT_BRANDING.brandLogo.glow);
  });

  it('falls back whole when the field is not an object at all', () => {
    assert.deepEqual(readBrandingSettings({ brandLogo: 'glass' }).brandLogo, DEFAULT_BRANDING.brandLogo);
    assert.deepEqual(readBrandingSettings({ brandLogo: null }).brandLogo, DEFAULT_BRANDING.brandLogo);
    assert.deepEqual(readBrandingSettings({ brandLogo: [] }).brandLogo, DEFAULT_BRANDING.brandLogo);
  });

  it('survives an unrelated later patch', () => {
    // The regression an operator would actually hit: configure the logo, then
    // change a colour, and find the logo reset.
    const withLogo = mergeBrandingSettings({
      existing: {},
      patch: { brandLogo: { size: 1.3, frame: 'none' } },
    });
    const stored = save(withLogo, { primary: '#ff0000' });
    assert.equal(stored.brandLogo.size, 1.3);
    assert.equal(stored.brandLogo.frame, 'none');
    assert.equal(stored.primary, '#ff0000');
  });
});

describe('cardLogoStyle', () => {
  it('reproduces the weight every card drew before the setting', () => {
    assert.deepEqual(readBrandingSettings({}).cardLogoStyle, { scale: 1, opacity: 0.1 });
  });

  it('stores and merges the same way the brand mark does', () => {
    const existing = mergeBrandingSettings({
      existing: {},
      patch: { cardLogoStyle: { scale: 1.8, opacity: 0.35 } },
    });
    assert.deepEqual(save(existing, { cardLogoStyle: { opacity: 0.05 } }).cardLogoStyle, {
      scale: 1.8,
      opacity: 0.05,
    });
  });

  it('refuses to make the mark invisible through the opacity control', () => {
    // `cardLogo: 'NONE'` is how a mark is removed, and it says so in the
    // picker. An opacity of zero would be a second, unlabelled way to reach the
    // same result — and the operator who found it would have no way to tell
    // "hidden" from "broken".
    assert.equal(save({}, { cardLogoStyle: { opacity: 0 } }).cardLogoStyle.opacity, 0.02);
    assert.equal(save({}, { cardLogoStyle: { opacity: -5 } }).cardLogoStyle.opacity, 0.02);
  });

  it('caps the size at twice the card default', () => {
    assert.equal(save({}, { cardLogoStyle: { scale: 40 } }).cardLogoStyle.scale, 2);
    assert.equal(save({}, { cardLogoStyle: { scale: 0.01 } }).cardLogoStyle.scale, 0.5);
  });

  it('is independent of which mark is selected', () => {
    // Size and weight apply to the built-in glyphs and to a custom upload
    // alike; the cabinet had three call sites that disagreed about the second.
    const stored = save({}, {
      cardLogo: 'SHIELD',
      cardLogoUrl: null,
      cardLogoStyle: { scale: 1.25, opacity: 0.2 },
    });
    assert.equal(stored.cardLogo, 'SHIELD');
    assert.deepEqual(stored.cardLogoStyle, { scale: 1.25, opacity: 0.2 });
  });
});
