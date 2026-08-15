import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';

import { UpdateBrandingSettingsDto } from '../src/modules/settings/dto/update-branding-settings.dto';
import {
  BORDER_RADIUS_CLASSES,
  DEFAULT_BRANDING,
} from '../src/modules/settings/interfaces/branding-settings.interface';
import { readBrandingSettings } from '../src/modules/settings/utils/branding-settings.util';

/**
 * The radius vocabulary the Reiwa cabinet guard accepts, pinned here on
 * purpose. The cabinet copy lives in
 * `reiwa/src/application/ports/public-config-persistence.port.ts`
 * (`BORDER_RADII`), a different repository that this build cannot import. A
 * value this panel writes but the cabinet refuses does not surface as an
 * error: the cabinet keeps serving its previous snapshot and its appearance
 * freezes there indefinitely. If this list ever needs a seventh member, the
 * cabinet has to learn it FIRST.
 */
const CABINET_BORDER_RADII = [
  'rounded-none',
  'rounded-lg',
  'rounded-xl',
  'rounded-2xl',
  'rounded-3xl',
  'rounded-full',
] as const;

/**
 * Every hex spelling the panel form and the settings reader already accept
 * (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`). Tightening the DTO must not cost
 * the operator any of them.
 */
const ACCEPTED_HEX_FORMS = ['#abc', '#abcd', '#a1b2c3', '#a1b2c3d4'] as const;

/**
 * What `@IsHexColor()` alone lets through and the reader then silently
 * replaces with a default: no leading `#`.
 */
const HASHLESS_HEX_FORMS = ['ff4081', 'abc', 'a1b2c3d4'] as const;

/** Minimal complete `BrandingThemeVariantDto` payload. */
function themeVariant(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    primary: '#22c55e',
    primaryFg: '#0a0a0a',
    bgPrimary: '#0a0a0a',
    bgSecondary: '#171717',
    cardGradient: 'linear-gradient(135deg, #064e3b 0%, #22c55e 100%)',
    cardPattern: null,
    cardEffect: 'aurora',
    cardEffectProps: {},
    cardEffectOpacity: 1,
    cardEffectsByIndex: [],
    bgEffect: 'NONE',
    appBackground: { kind: 'none' },
    borderRadius: 'rounded-2xl',
    cornerRadii: { cardPx: 24, itemPx: 14, pillPx: 9999 },
    fontFamily: 'Geist Variable, system-ui, sans-serif',
    surfaceTheme: { foreground: '#fafafa' },
    ...overrides,
  };
}

async function validatePatch(
  payload: Record<string, unknown>,
): Promise<readonly ValidationError[]> {
  const dto = plainToInstance(UpdateBrandingSettingsDto, payload);
  return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
}

/** Dotted paths of every failing property, nested errors included. */
function failedPaths(
  errors: readonly ValidationError[],
  prefix = '',
): readonly string[] {
  return errors.flatMap((error) => {
    const path = prefix === '' ? error.property : `${prefix}.${error.property}`;
    const own =
      error.constraints === undefined
        ? []
        : [path];
    return [...own, ...failedPaths(error.children ?? [], path)];
  });
}

/** Every message produced anywhere in the tree, for readability assertions. */
function allMessages(errors: readonly ValidationError[]): readonly string[] {
  return errors.flatMap((error) => [
    ...Object.values(error.constraints ?? {}),
    ...allMessages(error.children ?? []),
  ]);
}

describe('branding PATCH — borderRadius must stay inside the cabinet vocabulary', () => {
  it('writes exactly the vocabulary the cabinet reads', () => {
    assert.deepEqual([...BORDER_RADIUS_CLASSES], [...CABINET_BORDER_RADII]);
  });

  it('accepts every radius class the cabinet accepts', async () => {
    for (const borderRadius of CABINET_BORDER_RADII) {
      assert.deepEqual(
        failedPaths(await validatePatch({ borderRadius })),
        [],
        `expected ${borderRadius} to be accepted`,
      );
      assert.deepEqual(
        failedPaths(
          await validatePatch({
            themeVariants: {
              light: themeVariant({ borderRadius }),
              dark: themeVariant({ borderRadius }),
            },
          }),
        ),
        [],
        `expected themeVariants ${borderRadius} to be accepted`,
      );
    }
  });

  it('trims a padded radius instead of refusing it, exactly like the reader', async () => {
    // `readString` in `branding-settings.util.ts` trims before persisting, and
    // the panel form schema trims before submitting. Refusing the padded form
    // here would break a working API client for no gain.
    const dto = plainToInstance(UpdateBrandingSettingsDto, {
      borderRadius: '  rounded-3xl  ',
    });
    assert.deepEqual(
      failedPaths(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })),
      [],
    );
    assert.equal(dto.borderRadius, 'rounded-3xl');
  });

  it('refuses a radius the cabinet would reject, and says which values are allowed', async () => {
    for (const borderRadius of [
      'squircle',
      'rounded-4xl',
      'Rounded-2xl',
      'rounded-2 xl',
      'rounded',
    ]) {
      const errors = await validatePatch({ borderRadius });
      assert.deepEqual(
        failedPaths(errors),
        ['borderRadius'],
        `expected ${JSON.stringify(borderRadius)} to be refused`,
      );
      const message = allMessages(errors).join(' | ');
      for (const allowed of CABINET_BORDER_RADII) {
        assert.equal(
          message.includes(allowed),
          true,
          `message must list ${allowed}: ${message}`,
        );
      }
      assert.equal(
        message.includes(borderRadius.trim()),
        true,
        `message must name the rejected value: ${message}`,
      );
    }
  });

  it('refuses the same radius inside a brightness variant', async () => {
    const errors = await validatePatch({
      themeVariants: {
        light: themeVariant({ borderRadius: 'squircle' }),
        dark: themeVariant(),
      },
    });
    assert.deepEqual(failedPaths(errors), ['themeVariants.light.borderRadius']);
  });

  it('does not echo an oversized rejected radius back to the caller', async () => {
    const errors = await validatePatch({ borderRadius: 'r'.repeat(5_000) });
    assert.equal(failedPaths(errors).includes('borderRadius'), true);
    for (const message of allMessages(errors)) {
      assert.equal(
        message.length < 500,
        true,
        `message must stay bounded, got ${message.length} chars`,
      );
    }
  });
});

/**
 * The write guard above only covers values that arrive through the admin API.
 * These cover the other way in — a legacy row, a restored backup, a seed, a
 * direct DB edit, a migration — because the cabinet does not distinguish them:
 * `public-config-persistence.port.ts` refuses the WHOLE public config for an
 * unknown `borderRadius`, at the branding root and inside each brightness
 * snapshot, and then goes on serving its previous snapshot with no error
 * anywhere. `readBorderRadius` substitutes the documented default instead of
 * propagating the rejection, so a bad radius costs one corner, not all branding.
 */
describe('branding read — a persisted borderRadius the cabinet cannot render', () => {
  /** Non-empty strings the DTO refuses but a non-API writer could persist. */
  const UNRENDERABLE_STRINGS: readonly string[] = [
    'rounded-md',
    'squircle',
    'rounded-4xl',
    'Rounded-2xl',
    'rounded',
    'r'.repeat(10 * 1024),
  ];

  /** Values that are not usable strings at all. */
  const NON_STRINGS: readonly unknown[] = [
    '',
    '   ',
    42,
    null,
    true,
    { rounded: '2xl' },
    ['rounded-2xl'],
  ];

  it('substitutes the default rather than passing an unknown root value through', () => {
    for (const borderRadius of [...UNRENDERABLE_STRINGS, ...NON_STRINGS]) {
      const settings = readBrandingSettings({ borderRadius });
      assert.equal(
        settings.borderRadius,
        'rounded-2xl',
        `expected ${JSON.stringify(borderRadius).slice(0, 40)} to read as the default`,
      );
      assert.equal(
        CABINET_BORDER_RADII.includes(
          settings.borderRadius as (typeof CABINET_BORDER_RADII)[number],
        ),
        true,
        'the reader must never emit a radius the cabinet refuses',
      );
    }
  });

  it('substitutes the default inside each brightness snapshot', () => {
    for (const borderRadius of UNRENDERABLE_STRINGS) {
      const settings = readBrandingSettings({
        themeVariants: {
          light: themeVariant({ borderRadius }),
          dark: themeVariant({ borderRadius }),
        },
      });
      assert.notEqual(
        settings.themeVariants,
        null,
        'an unknown radius must not cost the operator the whole variant pair',
      );
      for (const mode of ['light', 'dark'] as const) {
        const variant = settings.themeVariants?.[mode];
        assert.equal(
          variant?.borderRadius,
          'rounded-2xl',
          `expected themeVariants.${mode} to read as the default`,
        );
      }
    }
  });

  it('substitutes per snapshot, leaving a valid sibling snapshot alone', () => {
    const settings = readBrandingSettings({
      themeVariants: {
        light: themeVariant({ borderRadius: 'rounded-md' }),
        dark: themeVariant({ borderRadius: 'rounded-full' }),
      },
    });
    assert.equal(settings.themeVariants?.light.borderRadius, 'rounded-2xl');
    assert.equal(settings.themeVariants?.dark.borderRadius, 'rounded-full');
  });

  it('keeps the rest of the branding alive when the radius is unusable', () => {
    // The point of substituting instead of propagating: the cabinet renders a
    // wrong corner radius, not a stale snapshot with none of these values.
    const settings = readBrandingSettings({
      borderRadius: 'rounded-md',
      brandName: 'Acme',
      primary: '#ff4081',
      fontFamily: 'Inter, sans-serif',
      cardLogo: 'SHIELD',
    });
    assert.equal(settings.brandName, 'Acme');
    assert.equal(settings.primary, '#ff4081');
    assert.equal(settings.fontFamily, 'Inter, sans-serif');
    assert.equal(settings.cardLogo, 'SHIELD');
  });

  it('does not change what a valid persisted value does, at either level', () => {
    for (const borderRadius of CABINET_BORDER_RADII) {
      assert.equal(
        readBrandingSettings({ borderRadius }).borderRadius,
        borderRadius,
      );
      const settings = readBrandingSettings({
        themeVariants: {
          light: themeVariant({ borderRadius }),
          dark: themeVariant({ borderRadius }),
        },
      });
      assert.equal(settings.themeVariants?.light.borderRadius, borderRadius);
      assert.equal(settings.themeVariants?.dark.borderRadius, borderRadius);
    }
    // Padding is still trimmed, exactly as `readString` always did and exactly
    // what the DTO's own `@Transform` produces on the write path.
    assert.equal(
      readBrandingSettings({ borderRadius: '  rounded-3xl  ' }).borderRadius,
      'rounded-3xl',
    );
  });

  it('leaves the variant completeness gate alone for a blank/non-string radius', () => {
    // Pre-existing, deliberately unchanged behaviour: a snapshot missing this
    // field is an INCOMPLETE snapshot, and `readThemeVariant` drops the pair
    // rather than half-filling it. `null` is a value the cabinet accepts
    // (`hasOptionalThemeVariants`), so the cabinet falls back to root branding
    // instead of refusing the config.
    for (const borderRadius of NON_STRINGS) {
      const settings = readBrandingSettings({
        themeVariants: {
          light: themeVariant({ borderRadius }),
          dark: themeVariant(),
        },
      });
      assert.equal(
        settings.themeVariants,
        null,
        `expected ${JSON.stringify(borderRadius)} to drop the pair, not half-fill it`,
      );
    }
  });

  it('keeps the default itself inside the vocabulary', () => {
    // `readBorderRadius` substitutes this value; if it ever left the list the
    // reader would emit exactly what the cabinet refuses.
    assert.equal(
      CABINET_BORDER_RADII.includes(
        DEFAULT_BRANDING.borderRadius as (typeof CABINET_BORDER_RADII)[number],
      ),
      true,
    );
  });
});

describe('branding PATCH — a colour without a leading # is a silent default swap', () => {
  const HEX_FIELDS: readonly {
    readonly path: string;
    readonly build: (colour: string) => Record<string, unknown>;
  }[] = [
    { path: 'primary', build: (c) => ({ primary: c }) },
    { path: 'primaryFg', build: (c) => ({ primaryFg: c }) },
    { path: 'bgPrimary', build: (c) => ({ bgPrimary: c }) },
    { path: 'bgSecondary', build: (c) => ({ bgSecondary: c }) },
    {
      path: 'surfaceTheme.foreground',
      build: (c) => ({ surfaceTheme: { foreground: c } }),
    },
    {
      path: 'surfaceTheme.mutedForeground',
      build: (c) => ({ surfaceTheme: { mutedForeground: c } }),
    },
    {
      path: 'surfaceTheme.surface',
      build: (c) => ({ surfaceTheme: { surface: c } }),
    },
    {
      path: 'surfaceTheme.surfaceHigh',
      build: (c) => ({ surfaceTheme: { surfaceHigh: c } }),
    },
    {
      path: 'surfaceTheme.borderSoft',
      build: (c) => ({ surfaceTheme: { borderSoft: c } }),
    },
    {
      path: 'surfaceTheme.borderStrong',
      build: (c) => ({ surfaceTheme: { borderStrong: c } }),
    },
    {
      path: 'appBackground.texture.color',
      build: (c) => ({
        appBackground: { kind: 'texture', texture: { pattern: 'dots', color: c } },
      }),
    },
    {
      path: 'appBackground.texture.background',
      build: (c) => ({
        appBackground: {
          kind: 'texture',
          texture: { pattern: 'dots', background: c },
        },
      }),
    },
    {
      path: 'themeVariants.light.primary',
      build: (c) => ({
        themeVariants: { light: themeVariant({ primary: c }), dark: themeVariant() },
      }),
    },
    {
      path: 'themeVariants.light.primaryFg',
      build: (c) => ({
        themeVariants: { light: themeVariant({ primaryFg: c }), dark: themeVariant() },
      }),
    },
    {
      path: 'themeVariants.light.bgPrimary',
      build: (c) => ({
        themeVariants: { light: themeVariant({ bgPrimary: c }), dark: themeVariant() },
      }),
    },
    {
      path: 'themeVariants.light.bgSecondary',
      build: (c) => ({
        themeVariants: { light: themeVariant({ bgSecondary: c }), dark: themeVariant() },
      }),
    },
    {
      path: 'themeVariants.light.surfaceTheme.surface',
      build: (c) => ({
        themeVariants: {
          light: themeVariant({ surfaceTheme: { surface: c } }),
          dark: themeVariant(),
        },
      }),
    },
  ];

  it('refuses a hash-less colour on every hex field', async () => {
    for (const field of HEX_FIELDS) {
      for (const colour of HASHLESS_HEX_FORMS) {
        const errors = await validatePatch(field.build(colour));
        assert.equal(
          failedPaths(errors).includes(field.path),
          true,
          `expected ${field.path} = ${colour} to be refused, got ${JSON.stringify(failedPaths(errors))}`,
        );
      }
    }
  });

  it('still accepts every hex spelling the panel form can produce', async () => {
    for (const field of HEX_FIELDS) {
      for (const colour of ACCEPTED_HEX_FORMS) {
        assert.deepEqual(
          failedPaths(await validatePatch(field.build(colour))),
          [],
          `expected ${field.path} = ${colour} to be accepted`,
        );
      }
    }
  });

  it('keeps the subscription-card opaque colours opaque', async () => {
    assert.deepEqual(
      failedPaths(
        await validatePatch({
          subscriptionCardGlass: { tint: '#ffffff' },
          subscriptionCardText: { mode: 'custom', color: '#000000' },
        }),
      ),
      [],
    );
    assert.equal(
      failedPaths(
        await validatePatch({ subscriptionCardGlass: { tint: '#ffffff80' } }),
      ).includes('subscriptionCardGlass.tint'),
      true,
    );
  });
});

describe('branding PATCH — dictionary payloads', () => {
  it('accepts a well-formed iconColors map', async () => {
    assert.deepEqual(
      failedPaths(
        await validatePatch({ iconColors: { support: '#22c55e', faq: '#abcd' } }),
      ),
      [],
    );
    assert.deepEqual(failedPaths(await validatePatch({ iconColors: {} })), []);
  });

  it('refuses an iconColors entry the reader would silently drop', async () => {
    for (const iconColors of [
      { support: 'ff4081' },
      { support: 'red' },
      { support: 42 },
      { support: null },
      { '': '#22c55e' },
      { ['k'.repeat(65)]: '#22c55e' },
    ] as readonly Record<string, unknown>[]) {
      const errors = await validatePatch({ iconColors });
      assert.equal(
        failedPaths(errors).includes('iconColors'),
        true,
        `expected ${JSON.stringify(iconColors)} to be refused`,
      );
    }
  });

  it('accepts a well-formed planCardStyles entry', async () => {
    assert.deepEqual(
      failedPaths(
        await validatePatch({
          planCardStyles: {
            starter: {
              gradient: 'linear-gradient(135deg, #064e3b, #22c55e)',
              accent: '#22c55e',
              texturePreset: 'dots',
              textureUrl: '/uploads/branding/tex.png',
            },
          },
        }),
      ),
      [],
    );
  });

  it('refuses a planCardStyles accent or texturePreset the reader would drop', async () => {
    for (const style of [
      { accent: 'red' },
      { accent: '22c55e' },
      { accent: 42 },
      { texturePreset: 'plaid' },
      { texturePreset: 7 },
    ] as readonly Record<string, unknown>[]) {
      const errors = await validatePatch({ planCardStyles: { starter: style } });
      assert.equal(
        failedPaths(errors).includes('planCardStyles'),
        true,
        `expected ${JSON.stringify(style)} to be refused`,
      );
    }
  });

  it('leaves a per-plan text policy unvalidated on purpose', async () => {
    // Documented decision in the DTO: refusing `text` would turn a survivable
    // mistake (the reader drops the policy, the card falls back to the global
    // one) into a 400 for the whole branding submit. The panel schema already
    // refuses it where the operator can see the control.
    assert.deepEqual(
      failedPaths(
        await validatePatch({
          planCardStyles: { starter: { accent: '#22c55e', text: { mode: 'nonsense' } } },
        }),
      ),
      [],
    );
  });
});
