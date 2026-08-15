/**
 * Who owns a visual value when the root and the two brightness snapshots
 * disagree — and what a card effect is allowed to carry over from the effect it
 * replaced.
 *
 * Both defects here are invisible in a request-body assertion: the panel sends
 * exactly the right payload and the value dies one layer lower, inside the
 * merge. Every test therefore goes through the real `mergeBrandingSettings`,
 * across a `JSON.parse(JSON.stringify(...))` storage boundary, and back through
 * the real `readBrandingSettings` — the same three steps `SettingsService`
 * performs — and asserts the STORED result.
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

/** The storage boundary: Prisma stores JSON, so nothing but JSON survives. */
function save(
  existing: unknown,
  patch: Partial<Record<keyof BrandingSettingsInterface, unknown>>,
): BrandingSettingsInterface {
  return readBrandingSettings(
    JSON.parse(JSON.stringify(mergeBrandingSettings({ existing, patch }))),
  );
}

/**
 * A complete brightness snapshot. `readThemeVariant` drops a pair unless BOTH
 * halves carry every field, so the defaults supply the uninteresting ones.
 */
function variant(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    ...DEFAULT_BRANDING,
    appBackground: { ...DEFAULT_BRANDING.appBackground },
    cornerRadii: { ...DEFAULT_BRANDING.cornerRadii },
    surfaceTheme: { ...DEFAULT_BRANDING.surfaceTheme },
    cardEffectsByIndex: [],
    ...overrides,
  };
}

const LIGHT_CARD = 'linear-gradient(135deg, #ffffff 0%, #fde68a 100%)';
const DARK_CARD = 'linear-gradient(135deg, #0a0a0a 0%, #431310 100%)';
const LIGHT_APP_BACKGROUND = {
  ...DEFAULT_BRANDING.appBackground,
  kind: 'gradient' as const,
  gradient: 'linear-gradient(180deg, #fffbeb 0%, #fde68a 100%)',
};
const DARK_APP_BACKGROUND = {
  ...DEFAULT_BRANDING.appBackground,
  kind: 'effect' as const,
  effect: 'aurora' as const,
  props: { colorStops: ['#431310', '#0a0a0a'] },
  opacity: 0.84,
};

/**
 * What the panel sends when an operator applies a concept whose two renderings
 * genuinely differ: both snapshots, plus the DEFAULT brightness one copied onto
 * the root. `applyConceptPreset` writes `themeDefaultMode` in the same request,
 * and `applyConceptVisualPatch` copies that mode's values to the root, so the
 * root here is a COPY of `themeVariants.dark`, not an operator override.
 */
function conceptApplicationPatch(): Partial<
  Record<keyof BrandingSettingsInterface, unknown>
> {
  return {
    themePresetId: 'concept-a',
    themePresetVersion: 2,
    themeModePolicy: 'fixed',
    themeDefaultMode: 'dark',
    cardGradient: DARK_CARD,
    cardEffect: 'threads',
    cardEffectProps: { color: '#431310' },
    cardEffectOpacity: 0.84,
    appBackground: DARK_APP_BACKGROUND,
    bgEffect: 'AURORA',
    bgPrimary: '#0a0a0a',
    themeVariants: {
      light: variant({
        bgPrimary: '#ffffff',
        cardGradient: LIGHT_CARD,
        cardEffect: 'threads',
        cardEffectProps: { color: '#fde68a' },
        cardEffectOpacity: 0.84,
        appBackground: LIGHT_APP_BACKGROUND,
      }),
      dark: variant({
        bgPrimary: '#0a0a0a',
        cardGradient: DARK_CARD,
        cardEffect: 'threads',
        cardEffectProps: { color: '#431310' },
        cardEffectOpacity: 0.84,
        appBackground: DARK_APP_BACKGROUND,
      }),
    },
  };
}

describe('branding visual ownership across the two brightness snapshots', () => {
  it('keeps both renderings of a concept applied in one request', () => {
    const stored = save({ brandName: 'Reiwa' }, conceptApplicationPatch());

    assert.equal(
      stored.themeVariants?.light.cardGradient,
      LIGHT_CARD,
      'the light snapshot was overwritten with the root copy of the DARK ' +
        'rendering — the concept shipped two card gradients and only one ' +
        'reached storage, so the cabinet draws the dark card in light mode',
    );
    assert.equal(stored.themeVariants?.dark.cardGradient, DARK_CARD);
    assert.equal(stored.cardGradient, DARK_CARD);

    assert.deepEqual(
      stored.themeVariants?.light.appBackground,
      readBrandingSettings({ appBackground: LIGHT_APP_BACKGROUND }).appBackground,
      'the light snapshot lost its own app background to the root copy of the ' +
        'dark one: a gradient background became the dark effect',
    );
    assert.equal(stored.themeVariants?.dark.appBackground.kind, 'effect');

    assert.deepEqual(
      stored.themeVariants?.light.cardEffectProps,
      { color: '#fde68a' },
      'the light snapshot lost the effect parameters derived from its own ' +
        'palette',
    );
    assert.deepEqual(stored.themeVariants?.dark.cardEffectProps, {
      color: '#431310',
    });

    // Control: the palette has its own ownership marker and must stay intact.
    assert.notEqual(
      stored.themeVariants?.light.bgPrimary,
      stored.themeVariants?.dark.bgPrimary,
    );
  });

  it('still forces a hand edit into both snapshots when the request carries no snapshots', () => {
    // The branch this fix narrows must keep doing its job: a direct visual
    // PATCH is a deliberate override, and leaving the old value in either
    // snapshot makes the cabinet revive it on the next brightness change.
    const stored = save(
      {
        themeDefaultMode: 'dark',
        cardGradient: DARK_CARD,
        appBackground: DARK_APP_BACKGROUND,
        themeVariants: conceptApplicationPatch().themeVariants,
      },
      {
        cardGradient: 'linear-gradient(135deg, #1e1b4b 0%, #6366f1 100%)',
        appBackground: { kind: 'gradient', gradient: 'linear-gradient(#111, #222)' },
      },
    );

    for (const mode of ['light', 'dark'] as const) {
      assert.equal(
        stored.themeVariants?.[mode].cardGradient,
        'linear-gradient(135deg, #1e1b4b 0%, #6366f1 100%)',
        `the ${mode} snapshot kept its old gradient after a direct operator ` +
          'edit, so switching brightness resurrects it',
      );
      assert.equal(stored.themeVariants?.[mode].appBackground.kind, 'gradient');
      assert.equal(
        stored.themeVariants?.[mode].appBackground.gradient,
        'linear-gradient(#111, #222)',
      );
    }
  });

  it('treats a root value the snapshots do not contain as an override even when snapshots are sent', () => {
    // Apply a concept, then change the animation before saving: ONE request
    // carrying both the concept's snapshots and an operator decision the
    // snapshots know nothing about. The snapshots win for what they supplied,
    // the root wins for what it changed on its own.
    const patch = conceptApplicationPatch();
    const stored = save(
      { brandName: 'Reiwa' },
      {
        ...patch,
        cardEffect: 'waves',
        cardEffectProps: { amplitude: 1.7 },
        cardEffectOpacity: 0.5,
      },
    );

    for (const mode of ['light', 'dark'] as const) {
      assert.equal(
        stored.themeVariants?.[mode].cardEffect,
        'waves',
        `the ${mode} snapshot kept the concept's animation over the one the ` +
          'operator selected in the same request',
      );
      assert.deepEqual(stored.themeVariants?.[mode].cardEffectProps, {
        amplitude: 1.7,
      });
      assert.equal(stored.themeVariants?.[mode].cardEffectOpacity, 0.5);
    }
    // Untouched by that edit: the two card gradients still differ.
    assert.equal(stored.themeVariants?.light.cardGradient, LIGHT_CARD);
    assert.equal(stored.themeVariants?.dark.cardGradient, DARK_CARD);
  });

  it('keeps the second rendering when only the default brightness changes', () => {
    // The panel's brightness selector copies the chosen snapshot onto the root
    // and does NOT resend the snapshots. The root is a copy again, so the pair
    // must survive that too.
    const applied = mergeBrandingSettings({
      existing: { brandName: 'Reiwa' },
      patch: conceptApplicationPatch(),
    });
    const stored = save(JSON.parse(JSON.stringify(applied)), {
      themeDefaultMode: 'light',
      cardGradient: LIGHT_CARD,
      appBackground: LIGHT_APP_BACKGROUND,
      bgPrimary: '#ffffff',
    });

    assert.equal(stored.cardGradient, LIGHT_CARD);
    assert.equal(
      stored.themeVariants?.dark.cardGradient,
      DARK_CARD,
      'selecting the light brightness overwrote the dark snapshot with the ' +
        'light rendering — the concept is now the same picture twice',
    );
    assert.equal(stored.themeVariants?.light.cardGradient, LIGHT_CARD);
    assert.equal(stored.themeVariants?.dark.appBackground.kind, 'effect');
  });
});

describe('card effect parameters when the effect itself changes', () => {
  const AURORA_PROPS = {
    colorStops: ['#3A29FF', '#FF94B4', '#FF3232'],
    amplitude: 1.7,
    blend: 0.9,
    speed: 2,
  };

  it('does not carry the previous effect parameters onto a new effect', () => {
    const off = save(
      { cardEffect: 'aurora', cardEffectProps: AURORA_PROPS },
      { cardEffect: 'NONE' },
    );
    assert.equal(off.cardEffect, 'NONE');
    assert.deepEqual(
      off.cardEffectProps,
      {},
      'switching the card animation off left its parameters in storage, so ' +
        'the next effect renders with settings chosen for aurora',
    );

    const next = save(
      { cardEffect: 'aurora', cardEffectProps: AURORA_PROPS },
      { cardEffect: 'threads' },
    );
    assert.equal(next.cardEffect, 'threads');
    assert.deepEqual(
      next.cardEffectProps,
      {},
      'threads inherited aurora colour stops, amplitude, blend and speed — ' +
        'parameters are per-effect and mean nothing here',
    );
  });

  it('keeps parameters the same request supplies', () => {
    const stored = save(
      { cardEffect: 'aurora', cardEffectProps: AURORA_PROPS },
      { cardEffect: 'threads', cardEffectProps: { color: '#22c55e' } },
    );
    assert.deepEqual(stored.cardEffectProps, { color: '#22c55e' });
  });

  it('keeps the operator tuning when the effect is re-sent unchanged', () => {
    // The panel resends every dirty field, so an unrelated save can repeat the
    // current effect. That must not wipe parameters the operator tuned.
    const stored = save(
      { cardEffect: 'aurora', cardEffectProps: AURORA_PROPS },
      { cardEffect: 'aurora', cardGradient: 'linear-gradient(#111, #222)' },
    );
    assert.deepEqual(stored.cardEffectProps, AURORA_PROPS);
  });

  it('clears the stale parameters in both brightness snapshots too', () => {
    const stale = variant({
      cardEffect: 'aurora',
      cardEffectProps: AURORA_PROPS,
    });
    const stored = save(
      {
        cardEffect: 'aurora',
        cardEffectProps: AURORA_PROPS,
        themeVariants: { light: stale, dark: stale },
      },
      { cardEffect: 'threads' },
    );

    for (const mode of ['light', 'dark'] as const) {
      assert.equal(stored.themeVariants?.[mode].cardEffect, 'threads');
      assert.deepEqual(
        stored.themeVariants?.[mode].cardEffectProps,
        {},
        `the ${mode} snapshot renders threads with aurora parameters, so the ` +
          'defect returns the moment the cabinet switches brightness',
      );
    }
  });
});
