import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  GATEWAY_ICON_SVG_MAX_BYTES,
  normalizeGatewayDisplayDescription,
  normalizeGatewayDisplayName,
  normalizeGatewayIconSvg,
} from '../src/modules/payments/utils/gateway-presentation.util';

/**
 * How a gateway looks to the customer in the cabinet: the operator's name, the
 * line under it and an SVG icon (operators, 22.10.2026 — customers were afraid
 * to press «Platega» and «Wata» with «RUB» under them).
 *
 * The icon is shown only as an image, which runs nothing; these specs hold the
 * second wall — a stored icon carries no script, handler, external reference or
 * entity — and the editor noise every real export brings, which must not be a
 * reason to refuse a file.
 */

function refusedWith(code: string) {
  return (error: unknown): boolean => (error as { response?: { code?: string } }).response?.code === code;
}

describe('the name a customer sees', () => {
  it('is one trimmed line, its inner white space one space', () => {
    assert.equal(normalizeGatewayDisplayName('  Карта \n или\tСБП  '), 'Карта или СБП');
  });

  it('is the provider\'s own when null or empty', () => {
    assert.equal(normalizeGatewayDisplayName(null), null);
    assert.equal(normalizeGatewayDisplayName('   '), null);
  });

  it('counts code points: forty emoji fit, forty-one do not', () => {
    assert.equal(normalizeGatewayDisplayName('💳'.repeat(40)), '💳'.repeat(40));
    assert.throws(() => normalizeGatewayDisplayName('💳'.repeat(41)), refusedWith('PAYMENT_GATEWAY_DISPLAY_NAME_INVALID'));
  });

  it('refuses invisible marks that make it read other than typed', () => {
    const rightToLeftOverride = String.fromCodePoint(0x202e);
    assert.throws(
      () => normalizeGatewayDisplayName(`Карта${rightToLeftOverride}ПБС`),
      refusedWith('PAYMENT_GATEWAY_DISPLAY_NAME_INVALID'),
    );
  });

  it('refuses what is not text', () => {
    assert.throws(() => normalizeGatewayDisplayName(42), refusedWith('PAYMENT_GATEWAY_DISPLAY_NAME_INVALID'));
  });
});

describe('the line under the name', () => {
  it('keeps up to three lines, each trimmed, blank ones dropped', () => {
    assert.equal(
      normalizeGatewayDisplayDescription(' Любая карта РФ \r\n\r\n  или QR-код   СБП '),
      'Любая карта РФ\nили QR-код СБП',
    );
  });

  it('is the currency code when null or empty', () => {
    assert.equal(normalizeGatewayDisplayDescription(null), null);
    assert.equal(normalizeGatewayDisplayDescription('\n \n'), null);
  });

  it('refuses a fourth line and a text past 160 code points', () => {
    assert.throws(() => normalizeGatewayDisplayDescription('a\nb\nc\nd'), refusedWith('PAYMENT_GATEWAY_DISPLAY_DESCRIPTION_INVALID'));
    assert.throws(
      () => normalizeGatewayDisplayDescription('я'.repeat(161)),
      refusedWith('PAYMENT_GATEWAY_DISPLAY_DESCRIPTION_INVALID'),
    );
    assert.equal(normalizeGatewayDisplayDescription('я'.repeat(160)), 'я'.repeat(160));
  });

  it('keeps its line breaks, and refuses an invisible mark on any line', () => {
    assert.equal(normalizeGatewayDisplayDescription('Карта\tРФ\nСБП'), 'Карта РФ\nСБП');
    assert.throws(
      () => normalizeGatewayDisplayDescription(`Карта\nСБП${String.fromCodePoint(0x2066)}`),
      refusedWith('PAYMENT_GATEWAY_DISPLAY_DESCRIPTION_INVALID'),
    );
    assert.throws(
      () => normalizeGatewayDisplayDescription(`Карта${String.fromCodePoint(0x7)}`),
      refusedWith('PAYMENT_GATEWAY_DISPLAY_DESCRIPTION_INVALID'),
    );
  });
});

describe('the icon', () => {
  const PLAIN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';

  it('keeps a clean SVG as it is', () => {
    assert.equal(normalizeGatewayIconSvg(PLAIN), PLAIN);
  });

  it('is the provider\'s logo when null or empty', () => {
    assert.equal(normalizeGatewayIconSvg(null), null);
    assert.equal(normalizeGatewayIconSvg('  '), null);
  });

  it('takes an editor\'s export: BOM, XML declaration, comments, a plain DOCTYPE, gradients, CDATA styles', () => {
    const exported = [
      String.fromCodePoint(0xfeff) + '<?xml version="1.0" encoding="UTF-8"?>',
      '<!-- Generator: Adobe Illustrator 27.0.0 -->',
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
      '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 48 48">',
      '<style type="text/css"><![CDATA[ .a{fill:url(#g)} ]]></style>',
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#1d4ed8"/></linearGradient></defs>',
      '<use xlink:href="#shape"/><rect class="a" width="48" height="48"/>',
      '</svg>',
    ].join('\n');
    const stored = normalizeGatewayIconSvg(exported);
    assert.ok(stored?.startsWith('<svg version="1.1"'), stored ?? 'null');
    assert.ok(stored?.endsWith('</svg>'));
    assert.doesNotMatch(stored!, /<\?xml|<!--|<!DOCTYPE/);
  });

  it('adds the SVG namespace, without which a browser shows no image at all', () => {
    assert.equal(
      normalizeGatewayIconSvg('<svg viewBox="0 0 24 24"><circle r="4"/></svg>'),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle r="4"/></svg>',
    );
  });

  it('derives a viewBox from width and height, so the icon scales to its box instead of being cut', () => {
    assert.equal(
      normalizeGatewayIconSvg('<svg xmlns="http://www.w3.org/2000/svg" width="64px" height="32"><circle r="4"/></svg>'),
      '<svg viewBox="0 0 64 32" xmlns="http://www.w3.org/2000/svg" width="64px" height="32"><circle r="4"/></svg>',
    );
  });

  it('keeps an embedded raster image', () => {
    const embedded =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><image href="data:image/png;base64,iVBORw0KGgo=" width="8" height="8"/></svg>';
    assert.equal(normalizeGatewayIconSvg(embedded), embedded);
  });

  for (const [what, svg] of [
    ['a script', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['a script split by a comment', '<svg xmlns="http://www.w3.org/2000/svg"><scr<!-- x -->ipt>alert(1)</script></svg>'],
    ['an event handler', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'],
    ['an event handler on an inner element', '<svg xmlns="http://www.w3.org/2000/svg"><rect/onclick="alert(1)"/></svg>'],
    ['a javascript: link', '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>'],
    ['a foreignObject', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>'],
    ['an external image', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://tracker.example/p.png"/></svg>'],
    ['an external use', '<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="https://evil.example/s.svg#a"/></svg>'],
    ['an external CSS url', '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://evil.example/x)"/></svg>'],
    ['a CSS import', '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://evil.example/x.css";</style></svg>'],
    ['an embedded HTML document', '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:text/html,<script>alert(1)</script>"/></svg>'],
    ['an entity declaration', '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>'],
    ['a stylesheet instruction', '<svg xmlns="http://www.w3.org/2000/svg"><?xml-stylesheet href="https://evil.example/x.css"?></svg>'],
    ['an animation that rewrites a link', '<svg xmlns="http://www.w3.org/2000/svg"><a><set attributeName="href" to="https://evil.example"/></a></svg>'],
  ] as const) {
    it(`refuses ${what}`, () => {
      assert.throws(() => normalizeGatewayIconSvg(svg), refusedWith('PAYMENT_GATEWAY_ICON_UNSAFE'));
    });
  }

  it('refuses what is not an SVG', () => {
    for (const notSvg of ['<html><body/></html>', 'iVBORw0KGgo=', '<svg xmlns="http://www.w3.org/2000/svg">', '<div><svg></svg></div>']) {
      assert.throws(() => normalizeGatewayIconSvg(notSvg), refusedWith('PAYMENT_GATEWAY_ICON_INVALID'), notSvg);
    }
  });

  it('refuses an icon over 32 KB', () => {
    const big = `<svg xmlns="http://www.w3.org/2000/svg"><desc>${'x'.repeat(GATEWAY_ICON_SVG_MAX_BYTES)}</desc></svg>`;
    assert.throws(() => normalizeGatewayIconSvg(big), refusedWith('PAYMENT_GATEWAY_ICON_TOO_LARGE'));
  });
});

describe('the presentation migration', () => {
  const migrationName = '20261022120000_payment_gateway_presentation';
  const sql = readFileSync(join(process.cwd(), 'prisma', 'migrations', migrationName, 'migration.sql'), 'utf8');
  const entrypoint = readFileSync(join(process.cwd(), 'docker-entrypoint.sh'), 'utf8');
  const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');

  it('adds three nullable columns, each guarded so a replay changes nothing', () => {
    assert.match(sql, /SET lock_timeout = '5s';/);
    assert.match(sql, /RESET lock_timeout;/);
    for (const column of ['display_name', 'display_description', 'display_icon_svg']) {
      assert.match(sql, new RegExp(`ALTER TABLE "payment_gateways" ADD COLUMN IF NOT EXISTS "${column}" TEXT;`));
    }
    const executable = sql.replace(/^\s*--.*$/gm, '');
    assert.doesNotMatch(executable, /NOT NULL|DEFAULT|DROP|UPDATE|INSERT|CREATE INDEX/);
    for (const statement of executable.match(/ALTER TABLE[^;]+;/g) ?? []) {
      assert.match(statement, /ADD COLUMN IF NOT EXISTS/, statement);
    }
  });

  it('is what the schema says', () => {
    assert.match(schema, /displayName\s+String\?\s+@map\("display_name"\)/);
    assert.match(schema, /displayDescription\s+String\?\s+@map\("display_description"\)/);
    assert.match(schema, /displayIconSvg\s+String\?\s+@map\("display_icon_svg"\)/);
  });

  it('is listed as auto-recoverable in the entrypoint', () => {
    assert.ok(entrypoint.includes(migrationName), `${migrationName} must be listed in is_auto_recoverable_migration`);
  });
});
