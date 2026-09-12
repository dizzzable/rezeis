import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

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

const NAVY_DOTS = { modules: 'dots', eyes: 'rounded', dark: '#1e3a8a' } as const;

function readStyle(qrStyle: unknown) {
  return readBrandingSettings({ qrStyle }).qrStyle;
}

describe('qrStyle — the reader', () => {
  it('reads an absent block as the plain code every installation draws today', () => {
    assert.deepEqual(DEFAULT_BRANDING.qrStyle, {
      modules: 'square',
      eyes: 'square',
      dark: '#000000',
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
    });
    assert.deepEqual(readStyle({ modules: 'diamonds', eyes: 'rounded', dark: '#1e3a8a' }), {
      modules: 'square',
      eyes: 'rounded',
      dark: '#1e3a8a',
    });
    assert.deepEqual(readStyle({ modules: 'dots', eyes: 'blob', dark: 7 }), {
      modules: 'dots',
      eyes: 'square',
      dark: '#000000',
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
      { modules: 'rounded', eyes: 'rounded', dark: '#595959' },
      { modules: 'square', eyes: 'rounded', dark: '#000' },
      { modules: 'rounded', eyes: 'square', dark: '#1E3A8A' },
      QR_STYLE_PLAIN,
    ]) {
      assert.deepEqual(readStyle(style), style);
    }
    // Trimmed, exactly as the DTO trims on the way in.
    assert.equal(readStyle({ ...NAVY_DOTS, dark: '  #1e3a8a  ' }).dark, '#1e3a8a');
  });

  it('keeps the three members and nothing else, so nothing rides along to the cabinet', () => {
    const stored = JSON.parse(
      '{"modules":"dots","eyes":"rounded","dark":"#1e3a8a","logo":"https://x.example/l.png","constructor":{}}',
    ) as unknown;
    assert.deepEqual(Object.keys(readStyle(stored)).sort(), ['dark', 'eyes', 'modules']);
  });
});

describe('qrStyle — the merge', () => {
  it('replaces the stored block whole', () => {
    const merged = mergeBrandingSettings({
      existing: { qrStyle: NAVY_DOTS },
      patch: { qrStyle: { modules: 'rounded', eyes: 'square', dark: '#000000' } },
    });
    assert.deepEqual(readBrandingSettings(merged).qrStyle, {
      modules: 'rounded',
      eyes: 'square',
      dark: '#000000',
    });
  });

  it('never completes a partial block from the stored style', () => {
    // No DTO-validated request carries a partial block; this pins what the
    // merge does if some other writer ever hands it one. A spread over the
    // stored block would quietly keep its eyes and its colour — a style nobody
    // chose as a whole.
    const merged = mergeBrandingSettings({
      existing: { qrStyle: NAVY_DOTS },
      patch: { qrStyle: { modules: 'rounded' } },
    });
    assert.deepEqual(readBrandingSettings(merged).qrStyle, {
      modules: 'rounded',
      eyes: 'square',
      dark: '#000000',
    });
  });

  it('leaves the stored style alone when a save is about something else', () => {
    const merged = mergeBrandingSettings({
      existing: { qrStyle: NAVY_DOTS },
      patch: { brandName: 'Acme' },
    });
    assert.deepEqual(readBrandingSettings(merged).qrStyle, NAVY_DOTS);
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
