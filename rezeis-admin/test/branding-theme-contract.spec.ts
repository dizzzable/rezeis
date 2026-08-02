import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdateBrandingSettingsDto } from '../src/modules/settings/dto/update-branding-settings.dto';
import { DEFAULT_BRANDING } from '../src/modules/settings/interfaces/branding-settings.interface';
import { SettingsService } from '../src/modules/settings/services/settings.service';
import {
  mergeBrandingSettings,
  readBrandingSettings,
} from '../src/modules/settings/utils/branding-settings.util';

describe('WEB Reiwa preset and surface theme contract', () => {
  it('keeps the pre-configurable Reiwa dark surface as the backwards-compatible default', () => {
    const branding = readBrandingSettings(null);

    assert.equal(branding.themePresetId, null);
    assert.equal(branding.themePresetVersion, null);
    assert.deepEqual(branding.surfaceTheme, {
      foreground: '#fafafa',
      mutedForeground: '#a1a1a1',
      surface: '#18181b',
      surfaceHigh: '#27272a',
      borderSoft: '#ffffff',
      borderStrong: '#ffffff',
      surfaceOpacity: 0.7,
      surfaceHighOpacity: 0.8,
      borderSoftOpacity: 0.06,
      borderStrongOpacity: 0.12,
      glassBlurPx: 16,
    });
    assert.deepEqual(branding.surfaceTheme, DEFAULT_BRANDING.surfaceTheme);
  });

  it('normalizes preset metadata and defensively repairs persisted surface tokens', () => {
    const branding = readBrandingSettings({
      themePresetId: ' concept-CZ ',
      themePresetVersion: 3,
      surfaceTheme: {
        foreground: '#fefefe',
        mutedForeground: 'rgb(1, 2, 3)',
        surface: '#1234',
        surfaceHigh: '#010203',
        borderSoft: '#abc',
        borderStrong: '#ABCDEF88',
        surfaceOpacity: 4,
        surfaceHighOpacity: -1,
        borderSoftOpacity: Number.NaN,
        borderStrongOpacity: 0.4,
        glassBlurPx: 99,
        ignoredToken: '#ffffff',
      },
    });

    assert.equal(branding.themePresetId, 'concept-CZ');
    assert.equal(branding.themePresetVersion, 3);
    assert.deepEqual(branding.surfaceTheme, {
      foreground: '#fefefe',
      mutedForeground: DEFAULT_BRANDING.surfaceTheme.mutedForeground,
      surface: '#1234',
      surfaceHigh: '#010203',
      borderSoft: '#abc',
      borderStrong: '#ABCDEF88',
      surfaceOpacity: 1,
      surfaceHighOpacity: 0,
      borderSoftOpacity: DEFAULT_BRANDING.surfaceTheme.borderSoftOpacity,
      borderStrongOpacity: 0.4,
      glassBlurPx: 40,
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        branding.surfaceTheme as unknown as Record<string, unknown>,
        'ignoredToken',
      ),
      false,
    );
  });

  it('falls back to no preset identity for malformed persisted metadata', () => {
    assert.equal(readBrandingSettings({ themePresetId: '../unsafe' }).themePresetId, null);
    assert.equal(readBrandingSettings({ themePresetVersion: 1.5 }).themePresetVersion, null);
    assert.equal(readBrandingSettings({ themePresetVersion: 0 }).themePresetVersion, null);
    assert.equal(
      readBrandingSettings({ themePresetVersion: Number.MAX_SAFE_INTEGER }).themePresetVersion,
      null,
    );
  });

  it('keeps two complete brightness variants for one operator-selected concept only', () => {
    const light = {
      ...DEFAULT_BRANDING,
      primary: '#165eff',
      bgPrimary: '#f5f8ff',
      bgSecondary: '#eef3ff',
      cardGradient: 'linear-gradient(135deg, #f5f8ff 0%, #b8d0ff 100%)',
      appBackground: { ...DEFAULT_BRANDING.appBackground },
      cornerRadii: { ...DEFAULT_BRANDING.cornerRadii },
      surfaceTheme: { ...DEFAULT_BRANDING.surfaceTheme },
      cardEffectsByIndex: [],
    };
    const dark = {
      ...light,
      primary: '#8cb4ff',
      bgPrimary: '#0c1324',
      bgSecondary: '#121d36',
      cardGradient: 'linear-gradient(135deg, #0c1324 0%, #293f70 100%)',
    };
    const branding = readBrandingSettings({
      themePresetId: 'concept-cu',
      themePresetVersion: 2,
      themeModePolicy: 'user-selectable',
      themeDefaultMode: 'light',
      themeVariants: { light, dark },
    });

    assert.equal(branding.themePresetId, 'concept-cu');
    assert.equal(branding.themeModePolicy, 'user-selectable');
    assert.equal(branding.themeDefaultMode, 'light');
    assert.equal(branding.themeVariants?.light.bgPrimary, '#f5f8ff');
    assert.equal(branding.themeVariants?.dark.bgPrimary, '#0c1324');

    const invalid = readBrandingSettings({
      themeModePolicy: 'user-selectable',
      themeVariants: { light, dark: { primary: '#ffffff' } },
    });
    assert.equal(invalid.themeVariants, null);
  });

  it('keeps legacy variant pairs on the root card-text policy through unrelated and direct patches', () => {
    const legacyVariantBase: Record<string, unknown> = { ...DEFAULT_BRANDING };
    delete legacyVariantBase.subscriptionCardText;
    const light = {
      ...legacyVariantBase,
      primary: '#165eff',
      bgPrimary: '#f5f8ff',
      bgSecondary: '#eef3ff',
      cardGradient: 'linear-gradient(135deg, #f5f8ff 0%, #b8d0ff 100%)',
      appBackground: { ...DEFAULT_BRANDING.appBackground },
      cornerRadii: { ...DEFAULT_BRANDING.cornerRadii },
      surfaceTheme: { ...DEFAULT_BRANDING.surfaceTheme },
      cardEffectsByIndex: [],
    };
    const dark = {
      ...light,
      primary: '#8cb4ff',
      bgPrimary: '#0c1324',
      bgSecondary: '#121d36',
      cardGradient: 'linear-gradient(135deg, #0c1324 0%, #293f70 100%)',
    };

    const merged = mergeBrandingSettings({
      existing: {
        themePresetId: 'concept-cu',
        themePresetVersion: 2,
        subscriptionCardText: { mode: 'custom', color: '#F8FAFC' },
        themeVariants: { light, dark },
      },
      patch: { brandName: 'Preserved concept' },
    });
    const reread = readBrandingSettings(merged);

    assert.equal(reread.brandName, 'Preserved concept');
    assert.equal(reread.themeVariants?.light.bgPrimary, '#f5f8ff');
    assert.equal(reread.themeVariants?.dark.bgPrimary, '#0c1324');
    assert.deepEqual(reread.subscriptionCardText, {
      mode: 'custom',
      color: '#F8FAFC',
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        reread.themeVariants?.light ?? {},
        'subscriptionCardText',
      ),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        reread.themeVariants?.dark ?? {},
        'subscriptionCardText',
      ),
      false,
    );

    const directlyPatched = readBrandingSettings(
      mergeBrandingSettings({
        existing: merged,
        patch: { subscriptionCardText: { mode: 'dark', color: null } },
      }),
    );

    assert.deepEqual(directlyPatched.subscriptionCardText, {
      mode: 'dark',
      color: null,
    });
    assert.deepEqual(directlyPatched.themeVariants?.light.subscriptionCardText, {
      mode: 'dark',
      color: null,
    });
    assert.deepEqual(directlyPatched.themeVariants?.dark.subscriptionCardText, {
      mode: 'dark',
      color: null,
    });

    const variantOnlyPatched = readBrandingSettings(
      mergeBrandingSettings({
        existing: {
          ...directlyPatched,
          subscriptionCardText: { mode: 'custom', color: '#F8FAFC' },
        },
        patch: {
          themeVariants: {
            light: {
              ...directlyPatched.themeVariants!.light,
              subscriptionCardText: { mode: 'light', color: null },
            },
            dark: {
              ...directlyPatched.themeVariants!.dark,
              subscriptionCardText: { mode: 'dark', color: null },
            },
          },
        },
      }),
    );

    // Variant snapshots are transport copies, not independent controls. A
    // direct API client cannot make text change when a user switches theme.
    assert.deepEqual(variantOnlyPatched.subscriptionCardText, {
      mode: 'custom',
      color: '#F8FAFC',
    });
    assert.deepEqual(variantOnlyPatched.themeVariants?.light.subscriptionCardText, {
      mode: 'custom',
      color: '#F8FAFC',
    });
    assert.deepEqual(variantOnlyPatched.themeVariants?.dark.subscriptionCardText, {
      mode: 'custom',
      color: '#F8FAFC',
    });
  });

  it('drops legacy relative branding assets that Reiwa cannot mirror durably', () => {
    const branding = readBrandingSettings({
      logoUrl: '/uploads/icons/legacy-logo.svg',
      pwaIconUrl: '/uploads/branding/operator-icon.png',
      adminPwaIconUrl: '/uploads/branding/a..png',
      cardLogoUrl: '/uploads/branding/.hidden.svg',
    });

    assert.equal(branding.logoUrl, null);
    assert.equal(branding.pwaIconUrl, '/uploads/branding/operator-icon.png');
    assert.equal(branding.adminPwaIconUrl, null);
    assert.equal(branding.cardLogoUrl, null);
  });

  it('keeps a stored legacy HTTP asset readable until the operator migrates it', () => {
    const branding = readBrandingSettings({
      logoUrl: 'http://legacy-cdn.example.com/operator-logo.png',
    });

    assert.equal(
      branding.logoUrl,
      'http://legacy-cdn.example.com/operator-logo.png',
    );
  });

  it('deep-merges a partial surface patch and strips unknown nested tokens', () => {
    const existing = {
      themePresetId: 'concept-a',
      themePresetVersion: 1,
      surfaceTheme: {
        ...DEFAULT_BRANDING.surfaceTheme,
        foreground: '#eeeeee',
        surface: '#101010',
        glassBlurPx: 24,
      },
    };

    const merged = mergeBrandingSettings({
      existing,
      patch: {
        surfaceTheme: {
          surfaceOpacity: 0.45,
          glassBlurPx: 6,
          unknown: 'not persisted',
        },
      },
    });
    const reread = readBrandingSettings(merged);

    assert.equal(reread.themePresetId, 'concept-a');
    assert.equal(reread.surfaceTheme.foreground, '#eeeeee');
    assert.equal(reread.surfaceTheme.surface, '#101010');
    assert.equal(reread.surfaceTheme.surfaceOpacity, 0.45);
    assert.equal(reread.surfaceTheme.glassBlurPx, 6);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        merged.surfaceTheme as Record<string, unknown>,
        'unknown',
      ),
      false,
    );
  });

  it('supports explicitly clearing preset identity without resetting resolved visual tokens', () => {
    const merged = mergeBrandingSettings({
      existing: {
        themePresetId: 'concept-a',
        themePresetVersion: 1,
        surfaceTheme: { ...DEFAULT_BRANDING.surfaceTheme, surface: '#121212' },
      },
      patch: {
        themePresetId: null,
        themePresetVersion: null,
      },
    });
    const reread = readBrandingSettings(merged);

    assert.equal(reread.themePresetId, null);
    assert.equal(reread.themePresetVersion, null);
    assert.equal(reread.surfaceTheme.surface, '#121212');
  });

  it('deep-merges partial app-background patches before canonical persistence', () => {
    const merged = mergeBrandingSettings({
      existing: {
        appBackground: {
          ...DEFAULT_BRANDING.appBackground,
          gradient: 'linear-gradient(90deg, #111111, #222222)',
          texture: {
            ...DEFAULT_BRANDING.appBackground.texture,
            pattern: 'grid',
            scale: 48,
          },
        },
      },
      patch: {
        appBackground: {
          kind: 'effect',
          effect: 'aurora',
          props: { speed: 0.4 },
          texture: { opacity: 0.25 },
        },
      },
    });
    const reread = readBrandingSettings(merged);

    assert.equal(reread.appBackground.kind, 'effect');
    assert.equal(reread.appBackground.effect, 'aurora');
    assert.equal(
      reread.appBackground.gradient,
      'linear-gradient(90deg, #111111, #222222)',
    );
    assert.equal(reread.appBackground.texture.pattern, 'grid');
    assert.equal(reread.appBackground.texture.scale, 48);
    assert.equal(reread.appBackground.texture.opacity, 0.25);
  });

  it('keeps a direct operator card artwork patch ahead of both theme variants and stale slots', () => {
    const variant = {
      primary: DEFAULT_BRANDING.primary,
      primaryFg: DEFAULT_BRANDING.primaryFg,
      bgPrimary: DEFAULT_BRANDING.bgPrimary,
      bgSecondary: DEFAULT_BRANDING.bgSecondary,
      cardGradient: 'linear-gradient(135deg, #111111, #222222)',
      cardPattern: 'linear-gradient(90deg, #ffffff22 1px, transparent 1px)',
      cardEffect: 'paperWarp',
      cardEffectProps: { shape: 'stripes' },
      cardEffectOpacity: 0.7,
      cardEffectsByIndex: [
        {
          mode: 'override',
          cardEffect: 'aurora',
          cardEffectProps: { speed: 2 },
          cardEffectOpacity: 0.4,
          cardGradient: 'linear-gradient(135deg, #450a0a, #ef4444)',
        },
      ],
      bgEffect: DEFAULT_BRANDING.bgEffect,
      appBackground: DEFAULT_BRANDING.appBackground,
      borderRadius: DEFAULT_BRANDING.borderRadius,
      cornerRadii: DEFAULT_BRANDING.cornerRadii,
      fontFamily: DEFAULT_BRANDING.fontFamily,
      surfaceTheme: DEFAULT_BRANDING.surfaceTheme,
    };
    const merged = readBrandingSettings(
      mergeBrandingSettings({
        existing: { themeVariants: { light: variant, dark: variant } },
        patch: {
          cardGradient: 'linear-gradient(135deg, #001122, #334455)',
          cardPattern: 'linear-gradient(#22d3ee22 1px, transparent 1px)',
        },
      }),
    );

    assert.equal(merged.cardGradient, 'linear-gradient(135deg, #001122, #334455)');
    assert.equal(merged.cardPattern, 'linear-gradient(#22d3ee22 1px, transparent 1px)');
    for (const mode of ['light', 'dark'] as const) {
      const resolved = merged.themeVariants?.[mode];
      assert.equal(resolved?.cardGradient, merged.cardGradient);
      assert.equal(resolved?.cardPattern, merged.cardPattern);
      assert.equal(resolved?.cardEffectsByIndex[0]?.cardGradient, null);
      assert.equal(resolved?.cardEffectsByIndex[0]?.mode, 'override');
      assert.equal(resolved?.cardEffectsByIndex[0]?.cardEffect, 'aurora');
    }
  });

  it('bounds nested branding collections and effect props before persistence', () => {
    const iconColors = Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => [`icon-${index}`, '#abcdef']),
    );
    const props = Object.fromEntries(
      Array.from({ length: 90 }, (_, index) => [`prop-${index}`, index]),
    );
    const slots = Array.from({ length: 24 }, () => ({
      cardEffect: 'aurora',
      cardEffectProps: props,
      cardEffectOpacity: 1,
    }));
    const merged = mergeBrandingSettings({
      existing: null,
      patch: {
        iconColors,
        cardEffectProps: props,
        cardEffectsByIndex: slots,
      },
    });

    assert.equal(Object.keys(merged.iconColors as Record<string, unknown>).length, 100);
    assert.equal(Object.keys(merged.cardEffectProps as Record<string, unknown>).length, 64);
    assert.equal((merged.cardEffectsByIndex as unknown[]).length, 20);
  });

  it('repairs persisted CSS image values that are not pure gradients', () => {
    const branding = readBrandingSettings({
      cardGradient: 'url("https://attacker.invalid/card.png")',
      cardPattern:
        'linear-gradient(#fff, #000), url("https://attacker.invalid/pattern.png")',
      cardEffectsByIndex: [
        {
          cardEffect: 'aurora',
          cardGradient: 'image-set(url("https://attacker.invalid/a.png") 1x)',
        },
      ],
      appBackground: {
        ...DEFAULT_BRANDING.appBackground,
        kind: 'gradient',
        gradient: 'paint(attacker)',
      },
      planCardStyles: {
        starter: {
          gradient: 'linear-gradient(#fff, #000); color: red',
          accent: '#abcdef',
        },
      },
    });

    assert.equal(branding.cardGradient, DEFAULT_BRANDING.cardGradient);
    assert.equal(branding.cardPattern, null);
    assert.equal(branding.cardEffectsByIndex[0]?.cardGradient, null);
    assert.equal(
      branding.appBackground.gradient,
      DEFAULT_BRANDING.appBackground.gradient,
    );
    assert.equal(branding.planCardStyles.starter?.gradient, undefined);
    assert.equal(branding.planCardStyles.starter?.accent, '#abcdef');
  });
});

describe('UpdateBrandingSettingsDto — preset and surface tokens', () => {
  it('transforms a valid nested patch before strict validation', async () => {
    const dto = plainToInstance(UpdateBrandingSettingsDto, {
      themePresetId: ' concept-ba ',
      themePresetVersion: '2',
      surfaceTheme: {
        foreground: ' #fefefe ',
        surfaceOpacity: '0.55',
        glassBlurPx: '20',
      },
      cornerRadii: {
        cardPx: '2',
        itemPx: '1',
        pillPx: '0',
      },
    });

    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    assert.deepEqual(errors, []);
    assert.equal(dto.themePresetId, 'concept-ba');
    assert.equal(dto.themePresetVersion, 2);
    assert.equal(dto.surfaceTheme?.foreground, '#fefefe');
    assert.equal(dto.surfaceTheme?.surfaceOpacity, 0.55);
    assert.equal(dto.surfaceTheme?.glassBlurPx, 20);
    assert.equal(dto.cornerRadii?.cardPx, 2);
    assert.equal(dto.cornerRadii?.itemPx, 1);
    assert.equal(dto.cornerRadii?.pillPx, 0);
  });

  it('rejects unsafe ids, invalid ranges, malformed colours and unknown nested fields', async () => {
    const dto = plainToInstance(UpdateBrandingSettingsDto, {
      themePresetId: '../concept',
      themePresetVersion: 0,
      surfaceTheme: {
        foreground: 'rgb(1, 2, 3)',
        surfaceOpacity: 1.01,
        glassBlurPx: 41,
        unknownToken: '#ffffff',
      },
      cornerRadii: {
        cardPx: 49,
        itemPx: -1,
        pillPx: 10_000,
      },
    });

    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    assert.equal(
      errors.some((error) => error.property === 'themePresetId'),
      true,
    );
    assert.equal(
      errors.some((error) => error.property === 'themePresetVersion'),
      true,
    );
    assert.equal(
      errors.some((error) => error.property === 'surfaceTheme'),
      true,
    );
    assert.equal(
      errors.some((error) => error.property === 'cornerRadii'),
      true,
    );
  });

  it('rejects CSS image loaders and property breakouts in gradient fields', async () => {
    const dto = plainToInstance(UpdateBrandingSettingsDto, {
      cardGradient: 'url("https://attacker.invalid/card.png")',
      cardPattern:
        'linear-gradient(#fff, #000), url("https://attacker.invalid/pattern.png")',
      cardEffectsByIndex: [
        {
          cardEffect: 'aurora',
          cardGradient: 'image-set(url("https://attacker.invalid/a.png") 1x)',
        },
      ],
      appBackground: {
        ...DEFAULT_BRANDING.appBackground,
        gradient: 'paint(attacker)',
      },
      planCardStyles: {
        starter: {
          gradient: 'linear-gradient(#fff, #000); color: red',
        },
      },
    });

    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    for (const property of [
      'cardGradient',
      'cardPattern',
      'cardEffectsByIndex',
      'appBackground',
      'planCardStyles',
    ]) {
      assert.equal(
        errors.some((error) => error.property === property),
        true,
        `expected ${property} to be rejected`,
      );
    }
  });

  it('accepts null only for the two nullable preset metadata fields', async () => {
    const nullableDto = plainToInstance(UpdateBrandingSettingsDto, {
      themePresetId: null,
      themePresetVersion: null,
    });
    const invalidSurfaceDto = plainToInstance(UpdateBrandingSettingsDto, {
      surfaceTheme: null,
    });

    assert.deepEqual(
      await validate(nullableDto, { whitelist: true, forbidNonWhitelisted: true }),
      [],
    );
    assert.equal(
      (
        await validate(invalidSurfaceDto, {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).some((error) => error.property === 'surfaceTheme'),
      true,
    );
  });

  it('rejects more than twenty per-position card effect slots', async () => {
    const dto = plainToInstance(UpdateBrandingSettingsDto, {
      cardEffectsByIndex: Array.from({ length: 21 }, () => ({
        cardEffect: 'aurora',
        cardEffectProps: {},
        cardEffectOpacity: 1,
      })),
    });

    assert.equal(
      (
        await validate(dto, {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).some((error) => error.property === 'cardEffectsByIndex'),
      true,
    );
  });

  it('accepts an explicit custom card-text policy and rejects a missing custom colour', async () => {
    const accepted = plainToInstance(UpdateBrandingSettingsDto, {
      subscriptionCardText: { mode: 'custom', color: '#F8FAFC' },
    });
    const rejected = plainToInstance(UpdateBrandingSettingsDto, {
      subscriptionCardText: { mode: 'custom', color: null },
    });
    const translucent = plainToInstance(UpdateBrandingSettingsDto, {
      subscriptionCardText: { mode: 'custom', color: '#f8fafc80' },
    });
    const nullPolicy = plainToInstance(UpdateBrandingSettingsDto, {
      subscriptionCardText: null,
    });

    assert.deepEqual(
      await validate(accepted, { whitelist: true, forbidNonWhitelisted: true }),
      [],
    );
    assert.equal(
      (
        await validate(rejected, {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).some((error) => error.property === 'subscriptionCardText'),
      true,
    );
    assert.equal(
      (
        await validate(nullPolicy, {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).some((error) => error.property === 'subscriptionCardText'),
      true,
    );
    assert.equal(
      (
        await validate(translucent, {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).some((error) => error.property === 'subscriptionCardText'),
      true,
    );
  });

  it('repairs malformed custom card text and clears stale colours from non-custom modes', async () => {
    assert.deepEqual(
      readBrandingSettings({
        subscriptionCardText: { mode: 'custom', color: 'rgb(1, 2, 3)' },
      }).subscriptionCardText,
      { mode: 'auto', color: null },
    );
    assert.deepEqual(
      readBrandingSettings({
        subscriptionCardText: { mode: 'custom', color: '#1234' },
      }).subscriptionCardText,
      { mode: 'auto', color: null },
    );
    assert.deepEqual(
      readBrandingSettings({
        subscriptionCardText: { mode: 'light', color: '#123456' },
      }).subscriptionCardText,
      { mode: 'light', color: null },
    );

    const staleNonCustom = plainToInstance(UpdateBrandingSettingsDto, {
      subscriptionCardText: { mode: 'dark', color: 'legacy-value' },
    });
    assert.deepEqual(
      await validate(staleNonCustom, {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
      [],
    );
  });

  it('persists card glass globally, clamps stale storage, and validates its patch', async () => {
    const persisted = readBrandingSettings({
      subscriptionCardGlass: {
        enabled: true,
        tint: '#e2e8f0',
        opacity: 0.2,
        blurPx: 12,
        borderOpacity: 0.3,
      },
    });
    assert.deepEqual(persisted.subscriptionCardGlass, {
      enabled: true,
      tint: '#e2e8f0',
      opacity: 0.2,
      blurPx: 12,
      borderOpacity: 0.3,
    });

    const merged = readBrandingSettings(
      mergeBrandingSettings({
        existing: persisted,
        patch: { subscriptionCardGlass: { opacity: 0.42 } },
      }),
    );
    assert.deepEqual(merged.subscriptionCardGlass, {
      ...persisted.subscriptionCardGlass,
      opacity: 0.42,
    });
    assert.deepEqual(
      readBrandingSettings({
        subscriptionCardGlass: {
          enabled: 'yes',
          tint: '#ffffff80',
          opacity: 5,
          blurPx: -2,
          borderOpacity: Number.NaN,
        },
      }).subscriptionCardGlass,
      {
        enabled: false,
        tint: '#ffffff',
        opacity: 1,
        blurPx: 0,
        borderOpacity: DEFAULT_BRANDING.subscriptionCardGlass.borderOpacity,
      },
    );

    const accepted = plainToInstance(UpdateBrandingSettingsDto, {
      subscriptionCardGlass: {
        enabled: true,
        tint: '#e2e8f0',
        opacity: 0.2,
        blurPx: 12,
        borderOpacity: 0.3,
      },
    });
    const rejected = plainToInstance(UpdateBrandingSettingsDto, {
      subscriptionCardGlass: {
        enabled: true,
        tint: '#e2e8f080',
        opacity: 1.1,
        blurPx: 41,
        borderOpacity: -0.1,
      },
    });
    assert.deepEqual(
      await validate(accepted, { whitelist: true, forbidNonWhitelisted: true }),
      [],
    );
    assert.equal(
      (
        await validate(rejected, {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).some((error) => error.property === 'subscriptionCardGlass'),
      true,
    );
  });

  it('accepts an old complete theme-variant payload without a card-text field', async () => {
    const legacyVariant = {
      primary: DEFAULT_BRANDING.primary,
      primaryFg: DEFAULT_BRANDING.primaryFg,
      bgPrimary: DEFAULT_BRANDING.bgPrimary,
      bgSecondary: DEFAULT_BRANDING.bgSecondary,
      cardGradient: DEFAULT_BRANDING.cardGradient,
      cardPattern: DEFAULT_BRANDING.cardPattern,
      cardEffect: DEFAULT_BRANDING.cardEffect,
      cardEffectProps: DEFAULT_BRANDING.cardEffectProps,
      cardEffectOpacity: DEFAULT_BRANDING.cardEffectOpacity,
      cardEffectsByIndex: DEFAULT_BRANDING.cardEffectsByIndex,
      bgEffect: DEFAULT_BRANDING.bgEffect,
      appBackground: DEFAULT_BRANDING.appBackground,
      borderRadius: DEFAULT_BRANDING.borderRadius,
      cornerRadii: DEFAULT_BRANDING.cornerRadii,
      fontFamily: DEFAULT_BRANDING.fontFamily,
      surfaceTheme: DEFAULT_BRANDING.surfaceTheme,
    };
    const dto = plainToInstance(UpdateBrandingSettingsDto, {
      themeVariants: {
        light: legacyVariant,
        dark: legacyVariant,
      },
    });

    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    const variantError = errors.find((error) => error.property === 'themeVariants');
    assert.equal(variantError, undefined);
  });

  it('accepts only safe relative assets from the bucket mirrored by Reiwa', async () => {
    const accepted = plainToInstance(UpdateBrandingSettingsDto, {
      logoUrl: ' /uploads/branding/operator_logo-1.2.png ',
    });

    assert.deepEqual(
      await validate(accepted, { whitelist: true, forbidNonWhitelisted: true }),
      [],
    );
    assert.equal(accepted.logoUrl, '/uploads/branding/operator_logo-1.2.png');

    for (const logoUrl of [
      '/uploads/icons/operator-logo.png',
      '/uploads/branding/.hidden.svg',
      '/uploads/branding/a..png',
      '/uploads/branding/nested/logo.png',
      '/uploads/branding/logo.png?version=2',
    ]) {
      const rejected = plainToInstance(UpdateBrandingSettingsDto, { logoUrl });
      assert.equal(
        (
          await validate(rejected, {
            whitelist: true,
            forbidNonWhitelisted: true,
          })
        ).some((error) => error.property === 'logoUrl'),
        true,
        `expected ${logoUrl} to be rejected`,
      );
    }
  });

  it('accepts HTTPS/data assets but rejects new HTTP and credentialed URLs', async () => {
    const accepted = plainToInstance(UpdateBrandingSettingsDto, {
      logoUrl: 'https://cdn.example.com/operator-logo.png',
      pwaIconUrl: 'data:image/png;base64,AA==',
      cardLogoUrl: 'https://assets.example.com/card.svg?version=2',
    });
    const rejected = plainToInstance(UpdateBrandingSettingsDto, {
      logoUrl: 'http://legacy-cdn.example.com/operator-logo.png',
      pwaIconUrl: 'https://user:password@cdn.example.com/icon.png',
    });

    assert.deepEqual(
      await validate(accepted, { whitelist: true, forbidNonWhitelisted: true }),
      [],
    );
    const errors = await validate(rejected, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    assert.equal(errors.some((error) => error.property === 'logoUrl'), true);
    assert.equal(errors.some((error) => error.property === 'pwaIconUrl'), true);
  });

  it('applies the durable asset contract to plan-card texture URLs', async () => {
    const accepted = plainToInstance(UpdateBrandingSettingsDto, {
      planCardStyles: {
        local: { textureUrl: '/uploads/branding/texture.webp' },
        remote: { textureUrl: 'https://cdn.example.com/texture.webp' },
        inline: { textureUrl: 'data:image/webp;base64,AA==' },
      },
    });
    const rejected = plainToInstance(UpdateBrandingSettingsDto, {
      planCardStyles: {
        http: { textureUrl: 'http://cdn.example.com/texture.webp' },
        traversalLike: { textureUrl: '/uploads/branding/a..webp' },
      },
    });

    assert.deepEqual(
      await validate(accepted, { whitelist: true, forbidNonWhitelisted: true }),
      [],
    );
    assert.equal(
      (
        await validate(rejected, {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).some((error) => error.property === 'planCardStyles'),
      true,
    );
  });
});

describe('SettingsService WEB Reiwa audit metadata', () => {
  it('tracks preset metadata and surfaceTheme as updated branding fields', async () => {
    const auditEntries: Array<Record<string, unknown>> = [];
    const updateCalls: Array<Record<string, unknown>> = [];
    const existing = {
      id: 'settings-1',
      brandingSettings: null,
      updatedAt: new Date('2026-07-30T12:00:00.000Z'),
    };
    const transactionClient = {
      settings: {
        findFirst: async () => existing,
        create: async () => {
          throw new Error('settings row already exists');
        },
        update: async (args: Record<string, unknown>) => {
          updateCalls.push(args);
          const data = args['data'] as Record<string, unknown>;
          return {
            ...existing,
            brandingSettings: data['brandingSettings'],
          };
        },
      },
      adminAuditLog: {
        create: async (args: { readonly data: Record<string, unknown> }) => {
          auditEntries.push(args.data);
        },
      },
    };
    const prismaService = {
      settings: transactionClient.settings,
      $transaction: async <T>(
        callback: (client: typeof transactionClient) => Promise<T>,
      ): Promise<T> => callback(transactionClient),
    };
    const service = new SettingsService(
      prismaService as never,
      {} as never,
      { cryptKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } as never,
    );

    const result = await service.updateBrandingSettings({
      currentAdmin: { id: 'admin-1' } as never,
      requestMetadata: {
        requestId: 'request-theme-1',
        remoteAddress: '203.0.113.8',
        userAgent: 'theme-contract-spec',
      },
      updateBrandingSettingsDto: {
        themePresetId: 'concept-cz',
        themePresetVersion: 1,
        surfaceTheme: { glassBlurPx: 8 },
      },
    });

    assert.equal(updateCalls.length, 1);
    assert.equal(result.themePresetId, 'concept-cz');
    assert.equal(result.themePresetVersion, 1);
    assert.equal(result.surfaceTheme.glassBlurPx, 8);
    assert.deepEqual(
      (auditEntries[0]?.['metadata'] as Record<string, unknown>)?.['updatedFields'],
      ['themePresetId', 'themePresetVersion', 'surfaceTheme'],
    );
  });
});
