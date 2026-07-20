import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clampExportLimit,
  mapRegistrationRow,
  parseStrictIsoDate,
  REGISTRATION_EXPORT_DEFAULT_LIMIT,
  REGISTRATION_EXPORT_MAX_LIMIT,
  renderRegistrationCsv,
} from '../src/modules/users/utils/registration-export.util';

describe('registration-export.util', () => {
  it('clamps limit into bounds', () => {
    assert.equal(clampExportLimit(undefined), REGISTRATION_EXPORT_DEFAULT_LIMIT);
    assert.equal(clampExportLimit(0), 1);
    assert.equal(clampExportLimit(50), 50);
    assert.equal(clampExportLimit(REGISTRATION_EXPORT_MAX_LIMIT + 100), REGISTRATION_EXPORT_MAX_LIMIT);
    assert.equal(clampExportLimit(Number.NaN), REGISTRATION_EXPORT_DEFAULT_LIMIT);
  });

  it('maps a row including raw IP and UTM JSON', () => {
    const cells = mapRegistrationRow({
      id: 'u1',
      telegramId: 123n,
      username: 'alice',
      createdAt: new Date('2026-07-01T12:00:00.000Z'),
      registrationIp: '176.119.1.2',
      registrationUserAgent: 'Mozilla/5.0',
      registrationReferer: 'https://t.me/channel',
      registrationUtm: { source: 'tg_channel_1', medium: 'social' },
      registrationChannel: 'web',
      acquisitionPlacementId: 'p1',
      acquisitionAt: new Date('2026-06-30T10:00:00.000Z'),
    });
    assert.equal(cells[0], 'u1');
    assert.equal(cells[1], '123');
    assert.equal(cells[4], '176.119.1.2');
    assert.equal(cells[7], JSON.stringify({ source: 'tg_channel_1', medium: 'social' }));
    assert.equal(cells[9], 'p1');
  });

  it('renders CSV with BOM and formula-injection guard', () => {
    const csv = renderRegistrationCsv([
      {
        id: 'u2',
        telegramId: null,
        username: '=cmd',
        createdAt: '2026-07-01T00:00:00.000Z',
        registrationIp: null,
        registrationUserAgent: null,
        registrationReferer: null,
        registrationUtm: null,
        registrationChannel: null,
        acquisitionPlacementId: null,
        acquisitionAt: null,
      },
    ]);
    assert.ok(csv.startsWith('\ufeff'));
    assert.ok(csv.includes('user_id'));
    assert.ok(csv.includes("'=cmd"));
  });

  it('parseStrictIsoDate rejects overflow calendars and non-ISO strings', () => {
    assert.equal(parseStrictIsoDate('2026-02-31'), null);
    assert.equal(parseStrictIsoDate('2026-13-01'), null);
    assert.equal(parseStrictIsoDate('July 1, 2026'), null);
    assert.equal(parseStrictIsoDate('not-a-date'), null);
    assert.ok(parseStrictIsoDate('2026-07-01') instanceof Date);
    assert.equal(parseStrictIsoDate('2026-07-01')!.toISOString(), '2026-07-01T00:00:00.000Z');
    assert.ok(parseStrictIsoDate('2026-07-01T12:30:00.000Z') instanceof Date);
  });

  it('defangs formula injection after leading tab/control characters', () => {
    const csv = renderRegistrationCsv([
      {
        id: 'u3',
        telegramId: null,
        username: null,
        createdAt: '2026-07-01T00:00:00.000Z',
        registrationIp: null,
        registrationUserAgent: '\t=HYPERLINK("http://evil")',
        registrationReferer: '  +cmd',
        registrationUtm: null,
        registrationChannel: null,
        acquisitionPlacementId: null,
        acquisitionAt: null,
      },
    ]);
    assert.ok(csv.includes("'\t=HYPERLINK"));
    assert.ok(csv.includes("'  +cmd"));
  });
});
