import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';

import { UpdateBrandingSettingsDto } from '../src/modules/settings/dto/update-branding-settings.dto';
import {
  DEFAULT_BRANDING,
  QR_STYLE_PLAIN,
} from '../src/modules/settings/interfaces/branding-settings.interface';
import {
  mergeBrandingSettings,
  readBrandingSettings,
} from '../src/modules/settings/utils/branding-settings.util';

/**
 * The QR style on its way out of the database, and the promise that the way
 * in and the way out judge a colour alike.
 *
 * The reader is total: garbage, a half-written block, a colour too light to
 * scan — each reads as something the cabinet draws, member by member, as the
 * cabinet's own `resolveQrStyle` does, so what the panel shows after a reload
 * is what subscribers are shown. And it keeps the DTO's rules, no looser and
 * no stricter: a reader stricter than the DTO answers an accepted save with
 * `200 OK` and a style that reverts on the next read — the defect this
 * project keeps shipping — and one looser than it lets a row the DTO would
 * refuse reach the cabinet.
 */

const NAVY_DOTS = { modules: 'dots', eyes: 'rounded', dark: '#1e3a8a', logo: null } as const;

/** A logo the panel's own upload produces: 32 hex digits and the sniffed type's extension. */
const LOGO = {
  src: '/uploads/branding/0123456789abcdef0123456789abcdef.png',
  size: 'large',
  plate: 'dark',
} as const;

function readStyle(qrStyle: unknown) {
  return readBrandingSettings({ qrStyle }).qrStyle;
}

describe('qrStyle — the reader', () => {
  it('reads an absent block as the plain code every installation draws today', () => {
    assert.deepEqual(DEFAULT_BRANDING.qrStyle, {
      modules: 'square',
      eyes: 'square',
      dark: '#000000',
      logo: null,
    });
    assert.deepEqual(readBrandingSettings(null).qrStyle, QR_STYLE_PLAIN);
    assert.deepEqual(readBrandingSettings({}).qrStyle, QR_STYLE_PLAIN);
  });

  it('reads a block that is not an object as the plain code', () => {
    for (const qrStyle of ['dots', 42, true, null, [], [NAVY_DOTS]]) {
      assert.deepEqual(readStyle(qrStyle), QR_STYLE_PLAIN, JSON.stringify(qrStyle));
    }
  });

  it('falls back member by member, keeping whatever is usable', () => {
    assert.deepEqual(readStyle({}), QR_STYLE_PLAIN);
    assert.deepEqual(readStyle({ modules: 'dots' }), {
      modules: 'dots',
      eyes: 'square',
      dark: '#000000',
      logo: null,
    });
    assert.deepEqual(readStyle({ modules: 'diamonds', eyes: 'rounded', dark: '#1e3a8a' }), {
      modules: 'square',
      eyes: 'rounded',
      dark: '#1e3a8a',
      logo: null,
    });
    assert.deepEqual(readStyle({ modules: 'dots', eyes: 'blob', dark: 7 }), {
      modules: 'dots',
      eyes: 'square',
      dark: '#000000',
      logo: null,
    });
  });

  it('draws a colour too light to scan in black, never in the colour', () => {
    // `#767676` is WCAG's 4.5:1 grey — the one the cabinet's camera model
    // failed to read. `#5a5a5a` is the first grey under 7:1.
    for (const dark of ['#767676', '#5a5a5a', '#ffffff', '#fff', '#00000080', '000000', 'black', '']) {
      assert.equal(readStyle({ ...NAVY_DOTS, dark }).dark, '#000000', dark);
    }
  });

  it('returns a stored valid style intact', () => {
    for (const style of [
      NAVY_DOTS,
      // The palest grey that passes, exactly at 7.00:1.
      { modules: 'rounded', eyes: 'rounded', dark: '#595959', logo: null },
      { modules: 'square', eyes: 'rounded', dark: '#000', logo: null },
      { modules: 'rounded', eyes: 'square', dark: '#1E3A8A', logo: null },
      { ...NAVY_DOTS, logo: LOGO },
      QR_STYLE_PLAIN,
    ]) {
      assert.deepEqual(readStyle(style), style);
    }
    // Trimmed, exactly as the DTO trims on the way in.
    assert.equal(readStyle({ ...NAVY_DOTS, dark: '  #1e3a8a  ' }).dark, '#1e3a8a');
  });

  it('keeps its four members and nothing else, so nothing rides along to the cabinet', () => {
    const stored = JSON.parse(
      '{"modules":"dots","eyes":"rounded","dark":"#1e3a8a","logo":{"src":"/uploads/branding/a1.png","size":"large","plate":"dark","href":"data:image/png;base64,AA=="},"constructor":{}}',
    ) as unknown;
    const read = readStyle(stored);
    assert.deepEqual(Object.keys(read).sort(), ['dark', 'eyes', 'logo', 'modules']);
    assert.deepEqual(read.logo, { src: '/uploads/branding/a1.png', size: 'large', plate: 'dark' });
  });
});

describe('qrStyle.logo — the reader', () => {
  it('keeps every logo the cabinet draws', () => {
    for (const logo of [
      LOGO,
      { ...LOGO, size: 'small', plate: 'light' },
      { ...LOGO, src: '/uploads/branding/logo.svg' },
      { ...LOGO, src: '/uploads/branding/Brand_Mark-2.WEBP' },
      { ...LOGO, src: '/uploads/branding/a.jpg' },
      { ...LOGO, src: '/uploads/branding/a.jpeg' },
      // The longest address allowed: 256 characters.
      { ...LOGO, src: `/uploads/branding/${'a'.repeat(256 - '/uploads/branding/.png'.length)}.png` },
    ]) {
      assert.deepEqual(readStyle({ ...NAVY_DOTS, logo }).logo, logo, JSON.stringify(logo));
    }
  });

  it('is total: whatever a stored logo holds, it reads as no logo rather than throwing or guessing', () => {
    const garbage: unknown[] = [
      undefined,
      null,
      0,
      true,
      'https://cdn.example.com/logo.png',
      '/uploads/branding/logo.png',
      [],
      [LOGO],
      {},
      // A member missing: never completed with a size or plate nobody chose.
      { src: LOGO.src, size: LOGO.size },
      { src: LOGO.src, plate: LOGO.plate },
      { size: LOGO.size, plate: LOGO.plate },
      // A member the cabinet does not know.
      { ...LOGO, size: 'huge' },
      { ...LOGO, plate: 'glass' },
      { ...LOGO, size: 1 },
      // An address the cabinet does not relay.
      { ...LOGO, src: 'https://cdn.example.com/logo.png' },
      { ...LOGO, src: '//cdn.example.com/uploads/branding/logo.png' },
      { ...LOGO, src: 'data:image/png;base64,iVBORw0KGgo=' },
      { ...LOGO, src: '/uploads/branding/../icons/logo.png' },
      { ...LOGO, src: '/uploads/branding/a..png' },
      { ...LOGO, src: '/uploads/icons/logo.png' },
      { ...LOGO, src: '/uploads/branding/logo.gif' },
      { ...LOGO, src: '/uploads/branding/logo.png?v=2' },
      { ...LOGO, src: ' /uploads/branding/logo.png' },
      { ...LOGO, src: '/uploads/branding/.hidden.png' },
      { ...LOGO, src: `/uploads/branding/${'a'.repeat(257 - '/uploads/branding/.png'.length)}.png` },
      { ...LOGO, src: 42 },
      // Members that are not the logo's own: JSON's `__proto__` is an own key
      // named so, and what it holds is not the logo.
      JSON.parse(`{"__proto__":${JSON.stringify(LOGO)}}`) as unknown,
      JSON.parse('{"constructor":{"src":"/uploads/branding/a.png"}}') as unknown,
    ];
    for (const logo of garbage) {
      let read: unknown = 'threw';
      assert.doesNotThrow(() => {
        read = readStyle({ ...NAVY_DOTS, logo }).logo;
      }, JSON.stringify(logo));
      assert.equal(read, null, JSON.stringify(logo));
    }
    // And the rest of the block survives a logo it cannot read.
    assert.deepEqual(readStyle({ ...NAVY_DOTS, logo: { ...LOGO, plate: 'glass' } }), NAVY_DOTS);
  });

  it('does not take a member from the prototype chain', () => {
    const inherited = Object.create(LOGO) as object;
    assert.equal(readStyle({ ...NAVY_DOTS, logo: inherited }).logo, null);
  });
});

describe('qrStyle — the merge', () => {
  it('replaces the stored block whole', () => {
    const merged = mergeBrandingSettings({
      existing: { qrStyle: NAVY_DOTS },
      patch: { qrStyle: { modules: 'rounded', eyes: 'square', dark: '#000000', logo: null } },
    });
    assert.deepEqual(readBrandingSettings(merged).qrStyle, {
      modules: 'rounded',
      eyes: 'square',
      dark: '#000000',
      logo: null,
    });
  });

  it('never completes a partial block from the stored style', () => {
    // No DTO-validated request carries a partial block; this pins what the
    // merge does if some other writer ever hands it one. A spread over the
    // stored block would quietly keep its eyes and its colour — a style nobody
    // chose as a whole.
    const merged = mergeBrandingSettings({
      existing: { qrStyle: { ...NAVY_DOTS, logo: LOGO } },
      patch: { qrStyle: { modules: 'rounded' } },
    });
    assert.deepEqual(readBrandingSettings(merged).qrStyle, {
      modules: 'rounded',
      eyes: 'square',
      dark: '#000000',
      logo: null,
    });
  });

  it('stores a logo the operator set, with the style around it', () => {
    const merged = mergeBrandingSettings({
      existing: { qrStyle: NAVY_DOTS },
      patch: { qrStyle: { ...NAVY_DOTS, logo: LOGO } },
    });
    assert.deepEqual(readBrandingSettings(merged).qrStyle, { ...NAVY_DOTS, logo: LOGO });
    // What goes into the column is plain JSON of the four members.
    assert.deepEqual(JSON.parse(JSON.stringify(merged.qrStyle)), { ...NAVY_DOTS, logo: LOGO });
  });

  it('takes a stored logo away on `logo: null`, and on a block that carries no logo at all', () => {
    for (const qrStyle of [
      { ...NAVY_DOTS, logo: null },
      { modules: NAVY_DOTS.modules, eyes: NAVY_DOTS.eyes, dark: NAVY_DOTS.dark },
    ]) {
      const merged = mergeBrandingSettings({ existing: { qrStyle: { ...NAVY_DOTS, logo: LOGO } }, patch: { qrStyle } });
      assert.equal(readBrandingSettings(merged).qrStyle.logo, null, JSON.stringify(qrStyle));
    }
  });

  it('leaves the stored style alone, logo and all, when a save is about something else', () => {
    const merged = mergeBrandingSettings({
      existing: { qrStyle: { ...NAVY_DOTS, logo: LOGO } },
      patch: { brandName: 'Acme' },
    });
    assert.deepEqual(readBrandingSettings(merged).qrStyle, { ...NAVY_DOTS, logo: LOGO });
  });
});

describe('qrStyle.logo — the DTO', () => {
  const STRICT = { whitelist: true, forbidNonWhitelisted: true } as const;
  const refused = async (logo: unknown, block: Record<string, unknown> = NAVY_DOTS): Promise<boolean> =>
    (await validate(plainToInstance(UpdateBrandingSettingsDto, { qrStyle: { ...block, logo } }), STRICT)).length > 0;

  it('accepts a logo, no logo, and a block that says nothing about a logo', async () => {
    assert.equal(await refused(LOGO), false);
    assert.equal(await refused({ ...LOGO, size: 'small', plate: 'light' }), false);
    assert.equal(await refused({ ...LOGO, src: '/uploads/branding/mark.SVG' }), false);
    assert.equal(await refused(null), false);
    const { logo: _none, ...threeMembers } = NAVY_DOTS;
    const errors = await validate(plainToInstance(UpdateBrandingSettingsDto, { qrStyle: threeMembers }), STRICT);
    assert.deepEqual(errors, []);
  });

  it('refuses an address the cabinet does not relay', async () => {
    for (const src of [
      'https://cdn.example.com/qr-logo.png',
      'http://cabinet.example.com/uploads/branding/a.png',
      '//cdn.example.com/uploads/branding/a.png',
      'data:image/png;base64,iVBORw0KGgo=',
      '/uploads/branding/../icons/qr-logo.png',
      '/uploads/branding/a..png',
      '/uploads/icons/a.png',
      '/uploads/branding/a.gif',
      '/uploads/branding/a.png?x=1',
      ` ${LOGO.src}`,
      `/uploads/branding/${'a'.repeat(257 - '/uploads/branding/.png'.length)}.png`,
      '',
      42,
      null,
    ]) {
      assert.equal(await refused({ ...LOGO, src }), true, JSON.stringify(src));
    }
  });

  it('refuses a size or plate it does not know, and a missing member', async () => {
    assert.equal(await refused({ ...LOGO, size: 'huge' }), true);
    assert.equal(await refused({ ...LOGO, plate: 'glass' }), true);
    assert.equal(await refused({ src: LOGO.src, size: LOGO.size }), true);
    assert.equal(await refused({ src: LOGO.src, plate: LOGO.plate }), true);
    assert.equal(await refused({ size: LOGO.size, plate: LOGO.plate }), true);
    assert.equal(await refused({}), true);
  });

  it('refuses an unknown key inside the logo, and a logo that is not an object', async () => {
    assert.equal(await refused({ ...LOGO, extra: 1 }), true);
    assert.equal(await refused({ ...LOGO, href: 'data:image/png;base64,AA==' }), true);
    for (const logo of ['/uploads/branding/a.png', 42, true, [], [LOGO]]) {
      assert.equal(await refused(logo), true, JSON.stringify(logo));
    }
  });

  it('names the address rule in its refusal, without echoing an unbounded value', async () => {
    const errors = await validate(
      plainToInstance(UpdateBrandingSettingsDto, {
        qrStyle: { ...NAVY_DOTS, logo: { ...LOGO, src: `https://cdn.example.com/$value/${'x'.repeat(500)}.png` } },
      }),
      STRICT,
    );
    const constraintMessages = (list: readonly ValidationError[]): string[] =>
      list.flatMap((error) => [...Object.values(error.constraints ?? {}), ...constraintMessages(error.children ?? [])]);
    const messages = constraintMessages(errors).join(' | ');
    assert.match(messages, /\/uploads\/branding\/<file>/, messages);
    assert.match(messages, /\(535 chars\)/, messages);
    assert.doesNotMatch(messages, /x{100}/, messages);
    assert.doesNotMatch(messages, /\$value/, messages);
  });

  it('accepts exactly the addresses the reader keeps', async () => {
    const sources = [
      LOGO.src,
      '/uploads/branding/a.png',
      '/uploads/branding/A.PNG',
      '/uploads/branding/a.svg',
      '/uploads/branding/a.webp',
      '/uploads/branding/a.jpg',
      '/uploads/branding/a.jpeg',
      '/uploads/branding/a-b_c.d.png',
      '/uploads/branding/a.png.svg',
      '/uploads/branding/-a.png',
      '/uploads/branding/_a.png',
      '/uploads/branding/a b.png',
      '/uploads/branding/a/b.png',
      '/uploads/branding/a..png',
      '/uploads/branding/..png',
      '/uploads/branding/a.png ',
      '/uploads/branding/a.tiff',
      '/uploads/branding/a.',
      '/uploads/branding/.png',
      '/UPLOADS/branding/a.png',
      'uploads/branding/a.png',
      `/uploads/branding/${'a'.repeat(256 - '/uploads/branding/.png'.length)}.png`,
      `/uploads/branding/${'a'.repeat(257 - '/uploads/branding/.png'.length)}.png`,
    ];
    const disagreements: string[] = [];
    let kept = 0;
    let dropped = 0;
    for (const src of sources) {
      const dtoAccepts = !(await refused({ ...LOGO, src }));
      const readerKeeps = readStyle({ ...NAVY_DOTS, logo: { ...LOGO, src } }).logo !== null;
      if (readerKeeps) kept += 1;
      else dropped += 1;
      if (dtoAccepts !== readerKeeps) {
        disagreements.push(`${src}: the DTO ${dtoAccepts ? 'accepts' : 'refuses'} it, the reader ${readerKeeps ? 'keeps' : 'drops'} it`);
      }
    }
    // Anchor: agreement over a sweep that only ever went one way proves nothing.
    assert.ok(kept >= 5 && dropped >= 5, `kept ${kept}, dropped ${dropped}`);
    assert.deepEqual(disagreements, []);
  });
});

describe('qrStyle — the DTO and the reader accept exactly the same colours', () => {
  /** Every `#rgb` colour, the 7:1 boundary, and the spellings a side could treat differently. */
  function colours(): readonly string[] {
    const digits = '0123456789abcdef';
    const out: string[] = [];
    for (const r of digits) {
      for (const g of digits) {
        for (const b of digits) out.push(`#${r}${g}${b}`);
      }
    }
    out.push(
      '#595959',
      '#5a5a5a',
      // 6.999258:1 — the closest a colour gets to the floor from below, and the
      // one place two implementations of the same arithmetic would part ways.
      '#0050ca',
      '#767676',
      '#1e3a8a',
      '#1E3A8A',
      '#000000',
      '#ffffff',
      '  #595959  ',
      '#00000080',
      '#0000',
      '000000',
      '#12345',
      'black',
      '',
    );
    return out;
  }

  it('agrees on every one of them', async () => {
    const disagreements: string[] = [];
    let accepted = 0;
    let refused = 0;
    for (const dark of colours()) {
      const dto = plainToInstance(UpdateBrandingSettingsDto, { qrStyle: { ...NAVY_DOTS, dark } });
      const dtoAccepts =
        (await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).length === 0;
      const readerKeeps = readStyle({ ...NAVY_DOTS, dark }).dark === dark.trim();
      if (dtoAccepts) accepted += 1;
      else refused += 1;
      if (dtoAccepts !== readerKeeps) {
        disagreements.push(
          `${JSON.stringify(dark)}: the DTO ${dtoAccepts ? 'accepts' : 'refuses'} it, the reader ${readerKeeps ? 'keeps' : 'drops'} it`,
        );
      }
    }
    // Anchor: agreement over a sweep that only ever went one way proves nothing.
    assert.ok(accepted > 100 && refused > 100, `accepted ${accepted}, refused ${refused}`);
    assert.deepEqual(disagreements, []);
  });
});
