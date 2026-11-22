import 'reflect-metadata';

import assert from 'node:assert/strict';
import test from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdateBrandingSettingsDto } from '../src/modules/settings/dto/update-branding-settings.dto';
import { DEFAULT_BRANDING } from '../src/modules/settings/interfaces/branding-settings.interface';
import {
  mergeBrandingSettings,
  readBrandingSettings,
} from '../src/modules/settings/utils/branding-settings.util';

/**
 * `authBackground` — the WEB cabinet's entry-screen background (sign in, sign
 * up, "forgot password").
 *
 * The block is served to the cabinet through
 * `/api/internal/branding/public-config`, whose guard refuses the WHOLE
 * branding snapshot when one value is malformed. Every rejection below is
 * therefore required to land on `{ kind: 'none', url: null }` rather than on an
 * exception or a partially applied block: a bad wallpaper must never cost the
 * operator their colours, logo and font.
 */

const NONE = { kind: 'none', url: null } as const;

function readAuthBackground(value: unknown) {
  return readBrandingSettings({ authBackground: value }).authBackground;
}

async function failedAuthBackgroundPaths(
  authBackground: Record<string, unknown>,
): Promise<readonly string[]> {
  const dto = plainToInstance(UpdateBrandingSettingsDto, { authBackground });
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const block = errors.find((error) => error.property === 'authBackground');
  if (!block) return [];
  return (block.children ?? []).map(
    (child) => `authBackground.${child.property}`,
  );
}

test('readBrandingSettings defaults authBackground to none when absent', () => {
  const branding = readBrandingSettings(null);
  assert.deepEqual(branding.authBackground, NONE);
  assert.deepEqual(branding.authBackground, DEFAULT_BRANDING.authBackground);
});

test('readBrandingSettings reads an image auth background', () => {
  const https = readAuthBackground({
    kind: 'image',
    url: 'https://cdn.example.com/login.jpg',
  });
  assert.deepEqual(https, {
    kind: 'image',
    url: 'https://cdn.example.com/login.jpg',
  });

  const upload = readAuthBackground({
    kind: 'image',
    url: '/uploads/branding/login-abc123.png',
  });
  assert.deepEqual(upload, {
    kind: 'image',
    url: '/uploads/branding/login-abc123.png',
  });
});

test('readBrandingSettings trims surrounding whitespace from the url', () => {
  assert.deepEqual(
    readAuthBackground({ kind: 'image', url: '  https://cdn.example.com/a.png  ' }),
    { kind: 'image', url: 'https://cdn.example.com/a.png' },
  );
});

test('readBrandingSettings reads a video auth background — https or an uploaded clip', () => {
  const branding = readAuthBackground({
    kind: 'video',
    url: 'https://cdn.example.com/login.mp4',
  });
  assert.deepEqual(branding, {
    kind: 'video',
    url: 'https://cdn.example.com/login.mp4',
  });

  // The operator's own upload: same bucket as the logo, video extension only.
  for (const url of ['/uploads/branding/abc123.mp4', '/uploads/branding/abc123.webm']) {
    assert.deepEqual(
      readAuthBackground({ kind: 'video', url }),
      { kind: 'video', url },
      `expected the upload path to be kept: ${url}`,
    );
  }
});

test('readBrandingSettings reads "none" as the default pair, dropping any url', () => {
  assert.deepEqual(
    readAuthBackground({ kind: 'none', url: 'https://cdn.example.com/a.jpg' }),
    NONE,
  );
});

test('readBrandingSettings rolls the whole block back for an unknown kind', () => {
  assert.deepEqual(
    readAuthBackground({ kind: 'gallery', url: 'https://cdn.example.com/a.jpg' }),
    NONE,
  );
  assert.deepEqual(readAuthBackground({ url: 'https://cdn.example.com/a.jpg' }), NONE);
});

test('readBrandingSettings rolls the whole block back for a non-object value', () => {
  for (const value of [null, 'oops', 42, ['image'], { kind: 'video' }]) {
    assert.deepEqual(readAuthBackground(value), NONE, `value: ${JSON.stringify(value)}`);
  }
});

test('readBrandingSettings rolls the whole block back for an unusable image url', () => {
  const rejected = [
    '', // empty
    'http://cdn.example.com/login.jpg', // mixed content, no https
    '//cdn.example.com/login.jpg', // protocol-relative
    '/login.jpg', // relative path outside the upload bucket
    '/uploads/branding/../secret.png', // traversal
    'javascript:alert(1)',
    'data:text/html;base64,aGVsbG8=', // not an image
    // The cabinet's `resolveAuthBackground` refuses inline data URLs, so the
    // panel must not read one back either — the operator would see a wallpaper
    // in the preview and nothing on the entry screen.
    'data:image/png;base64,aGVsbG8=',
    'https://user:pass@cdn.example.com/login.jpg', // credentials in the URL
    'https://cdn.example.com/a b.jpg', // whitespace
    `https://cdn.example.com/${'a'.repeat(2048)}.jpg`, // over the length cap
  ];
  for (const url of rejected) {
    assert.deepEqual(
      readAuthBackground({ kind: 'image', url }),
      NONE,
      `expected fallback for image url: ${url.slice(0, 60)}`,
    );
  }
});

test('readBrandingSettings rolls the whole block back for an unusable video url', () => {
  const rejected = [
    'data:image/png;base64,aGVsbG8=',
    // An upload path must END in a video extension: pointing the video slot at
    // a still would give the cabinet a `<video>` it can never decode.
    '/uploads/branding/login.png',
    '/uploads/branding/login.mp4.txt',
    '/uploads/branding/../login.mp4',
    'http://cdn.example.com/login.mp4',
    'https://user:pass@cdn.example.com/login.mp4',
    'https://cdn.example.com/a b.mp4',
    '',
    42,
  ];
  for (const url of rejected) {
    assert.deepEqual(
      readAuthBackground({ kind: 'video', url }),
      NONE,
      `expected fallback for video url: ${String(url).slice(0, 60)}`,
    );
  }
});

test('mergeBrandingSettings preserves an unrelated existing authBackground', () => {
  const existing = {
    authBackground: { kind: 'video', url: 'https://cdn.example.com/login.mp4' },
  };
  const merged = mergeBrandingSettings({ existing, patch: { brandName: 'Acme' } });
  const reread = readBrandingSettings(merged);
  assert.deepEqual(reread.authBackground, {
    kind: 'video',
    url: 'https://cdn.example.com/login.mp4',
  });
  assert.equal(reread.brandName, 'Acme');
});

test('mergeBrandingSettings replaces the block whole when patched', () => {
  const existing = {
    authBackground: { kind: 'video', url: 'https://cdn.example.com/login.mp4' },
  };
  const merged = mergeBrandingSettings({
    existing,
    patch: { authBackground: { kind: 'image', url: 'https://cdn.example.com/a.png' } },
  });
  assert.deepEqual(readBrandingSettings(merged).authBackground, {
    kind: 'image',
    url: 'https://cdn.example.com/a.png',
  });

  // `none` carries no URL: the patch clears the stored block rather than
  // keeping the previously selected address.
  const cleared = mergeBrandingSettings({
    existing,
    patch: { authBackground: { kind: 'none', url: null } },
  });
  assert.deepEqual(readBrandingSettings(cleared).authBackground, NONE);
});

test('mergeBrandingSettings never triggers the theme-variant synchronisation', () => {
  // Root-only field: a variant snapshot must not gain an `authBackground` key.
  const merged = mergeBrandingSettings({
    existing: {
      themeVariants: {
        light: variantSnapshot(),
        dark: variantSnapshot(),
      },
    },
    patch: { authBackground: { kind: 'image', url: 'https://cdn.example.com/a.png' } },
  });
  const variants = merged.themeVariants as {
    light: Record<string, unknown>;
    dark: Record<string, unknown>;
  };
  assert.equal(Object.prototype.hasOwnProperty.call(variants.light, 'authBackground'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(variants.dark, 'authBackground'), false);
});

test('UpdateBrandingSettingsDto accepts every well-formed block', async () => {
  for (const authBackground of [
    { kind: 'none', url: null },
    { kind: 'image', url: 'https://cdn.example.com/a.png' },
    { kind: 'image', url: '/uploads/branding/a.png' },
    { kind: 'video', url: 'https://cdn.example.com/a.mp4' },
    { kind: 'video', url: '/uploads/branding/a.mp4' },
    { kind: 'video', url: '/uploads/branding/a.webm' },
  ]) {
    assert.deepEqual(
      await failedAuthBackgroundPaths(authBackground),
      [],
      `expected acceptance for ${JSON.stringify(authBackground)}`,
    );
  }
});

test('UpdateBrandingSettingsDto refuses a kind/url disagreement', async () => {
  const rejected = [
    { kind: 'gallery', url: 'https://cdn.example.com/a.png' }, // unknown kind
    { kind: 'image' }, // image without a url
    { kind: 'video', url: 'data:image/png;base64,aGVsbG8=' }, // video needs https or a video upload
    { kind: 'video', url: '/uploads/branding/a.png' }, // the video slot cannot name a still
    { kind: 'image', url: 'data:image/png;base64,aGVsbG8=' }, // no inline data for an entry screen
    { kind: 'image', url: 'http://cdn.example.com/a.png' }, // mixed content
    { kind: 'none', url: 'https://cdn.example.com/a.png' }, // none must be null
    { kind: 'image', url: 42 }, // not a string
  ];
  for (const authBackground of rejected) {
    const paths = await failedAuthBackgroundPaths(authBackground);
    assert.ok(
      paths.length > 0,
      `expected a 400 for ${JSON.stringify(authBackground)}`,
    );
    assert.ok(
      paths.includes('authBackground.kind'),
      `expected the kind/url disagreement to be reported, got ${paths.join(', ')}`,
    );
  }
});

/** Minimal complete brightness snapshot the reader accepts. */
function variantSnapshot(): Record<string, unknown> {
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
    appBackground: { ...DEFAULT_BRANDING.appBackground },
    borderRadius: DEFAULT_BRANDING.borderRadius,
    cornerRadii: { ...DEFAULT_BRANDING.cornerRadii },
    fontFamily: DEFAULT_BRANDING.fontFamily,
    surfaceTheme: { ...DEFAULT_BRANDING.surfaceTheme },
  };
}
