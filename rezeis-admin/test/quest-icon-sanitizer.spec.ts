import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { QuestIconService } from '../src/modules/quests/services/quest-icon.service';

const VALID = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z" fill="#7c3aed"/></svg>';

describe('QuestIconService.sanitizeSvg', () => {
  it('accepts a plain shape/path icon and returns it unchanged', () => {
    assert.equal(QuestIconService.sanitizeSvg(VALID), VALID);
  });

  it('strips a leading XML declaration', () => {
    const out = QuestIconService.sanitizeSvg(`<?xml version="1.0"?>\n${VALID}`);
    assert.equal(out, VALID);
  });

  it('accepts an internal gradient reference (url(#id))', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><rect fill="url(#g)" width="10" height="10"/></svg>';
    assert.equal(QuestIconService.sanitizeSvg(svg), svg);
  });

  const attacks: Array<[string, string]> = [
    ['<script>', '<svg><script>alert(1)</script></svg>'],
    ['event handler', '<svg onload="alert(1)"><path d="M0 0"/></svg>'],
    ['foreignObject', '<svg><foreignObject><body/></foreignObject></svg>'],
    ['<image> external', '<svg><image href="https://evil.test/x.png"/></svg>'],
    ['<use> external', '<svg><use href="https://evil.test/x.svg#i"/></svg>'],
    ['external href', '<svg><a href="https://evil.test"><path d="M0 0"/></a></svg>'],
    ['javascript: href', '<svg><a xlink:href="javascript:alert(1)"><path d="M0 0"/></a></svg>'],
    ['data: uri', '<svg><image href="data:image/png;base64,AAAA"/></svg>'],
    ['css url() external', '<svg><rect style="fill:url(https://evil.test/x)"/></svg>'],
    ['DOCTYPE/ENTITY (XXE)', '<!DOCTYPE svg [<!ENTITY x "y">]><svg><path d="M0 0"/></svg>'],
    ['<style>', '<svg><style>*{fill:red}</style><path d="M0 0"/></svg>'],
    ['<animate>', '<svg><animate attributeName="x"/></svg>'],
    // Regression: handler NOT preceded by whitespace (attr/slash-adjacent).
    ['slash-adjacent onload', '<svg xmlns="http://www.w3.org/2000/svg"><a><rect/onload="alert(1)"/></a></svg>'],
    ['quote-adjacent onclick', '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0"onclick="x()"/></svg>'],
    // Regression: <set> without a trailing space (<set/>, <set\n>).
    ['<set/> self-closing', '<svg><set/></svg>'],
    ['not an svg', '<div>hi</div>'],
  ];

  for (const [name, payload] of attacks) {
    it(`rejects: ${name}`, () => {
      assert.throws(() => QuestIconService.sanitizeSvg(payload), { name: 'BadRequestException' });
    });
  }

  it('rejects an oversized SVG', () => {
    const big = `<svg>${'<path d="M0 0"/>'.repeat(20000)}</svg>`;
    assert.throws(() => QuestIconService.sanitizeSvg(big), { name: 'BadRequestException' });
  });
});
