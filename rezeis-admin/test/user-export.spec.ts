import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  USER_EXPORT_COLUMNS,
  elevatedAmong,
  needsPanelDevices,
  needsSubscription,
  resolveExportColumns,
} from '../src/modules/users/utils/user-export.catalog';
import {
  projectCell,
  renderUserExportCsv,
  type UserExportRow,
} from '../src/modules/users/utils/user-export.util';

/**
 * THE COLUMNS AN OPERATOR TICKS, AND WHAT ACTUALLY COMES OUT.
 *
 * Every failure in an export of this shape looks the same from the outside — an
 * empty cell — and an empty cell is the one value an operator will read as a
 * fact about the customer. "No devices", "never installed the app", "no plan".
 * So the cases below are mostly about telling three different empties apart:
 * a column that exists and is genuinely blank, a column nobody asked for, and a
 * column whose data could not be fetched.
 */

const ROW: UserExportRow = {
  id: 'user-1',
  telegramId: BigInt('813364774'),
  username: 'dizzable',
  name: 'DIZZABLE',
  email: null,
  language: 'RU',
  role: 'USER',
  referralCode: 'ref-1',
  isBlocked: false,
  isBotBlocked: false,
  createdAt: new Date('2026-06-01T10:00:00.000Z'),
  lastSeenAt: new Date('2026-09-09T08:00:00.000Z'),
  points: 120,
  personalDiscount: 0,
  pwaInstalledAt: new Date('2026-06-02T10:00:00.000Z'),
  lastSurface: 'pwa',
  lastFormFactor: 'mobile',
  lastOs: 'android',
  onboardingCompletedAt: null,
  firstTrafficAt: new Date('2026-06-01T12:00:00.000Z'),
  registrationChannel: 'tma',
  acquisitionPlacementId: null,
  acquisitionAt: null,
  registrationIp: '203.0.113.7',
  registrationUserAgent: 'Mozilla/5.0',
  registrationReferer: null,
  registrationUtm: { source: 'tg', campaign: 'autumn' },
  subscription: {
    status: 'ACTIVE',
    planName: 'Год',
    expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    isTrial: false,
    trafficLimit: 0,
    deviceLimit: 3,
  },
  subscriptionCount: 2,
  devices: [
    {
      hwid: '5FE93005A13',
      platform: 'Windows',
      userAgent: 'FlClash X/v0.3.2 Platform/windows',
      deviceName: 'Windows 11 Pro (25H2)',
      lastSeenAt: '2026-08-27T21:05:44.000Z',
    },
    {
      hwid: '7CE4FFB4-F5',
      platform: 'Android',
      userAgent: 'INCY/3.6.2/android Dalvik/2.1.0',
      deviceName: 'vivo V2403A (16)',
      lastSeenAt: '2026-09-09T21:08:38.000Z',
    },
  ],
};

/**
 * The same user with nothing missing.
 *
 * Only the drift check uses it, and only because that check has to be able to
 * tell "no value" from "no projection" — which it cannot do against a fixture
 * that carries nulls on purpose.
 */
const FULL: UserExportRow = {
  ...ROW,
  email: 'someone@example.com',
  onboardingCompletedAt: new Date('2026-06-03T10:00:00.000Z'),
  acquisitionPlacementId: 'placement-1',
  acquisitionAt: new Date('2026-06-01T09:00:00.000Z'),
  registrationReferer: 'https://t.me/2getshop',
};

/** One cell, by column id. */
function cell(id: string, row: UserExportRow = ROW): string {
  const column = USER_EXPORT_COLUMNS.find((candidate) => candidate.id === id);
  assert.ok(column, `${id} is not in the catalogue`);
  return projectCell(column, row);
}

describe('the column catalogue', () => {
  it('has columns at all', () => {
    // Anti-emptiness anchor: an empty catalogue makes every loop below pass by
    // iterating nothing, and makes the export an empty file with no header.
    assert.ok(USER_EXPORT_COLUMNS.length >= 30);
  });

  it('names every column exactly once', () => {
    // A duplicate id would write the same header twice and the panel would draw
    // two checkboxes that toggle each other.
    const ids = USER_EXPORT_COLUMNS.map((column) => column.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('projects every column it declares', () => {
    // THE DRIFT THIS FILE EXISTS FOR. `projectCell` falls through to an empty
    // string for an id it does not know, so a column added to the catalogue and
    // forgotten in the projection ships as a checkbox that exports a blank
    // column — which reads as "we hold no such data about these people".
    //
    // Against FULL, where every field carries a value, so the only way a column
    // can come back empty is that nothing projects it. `ROW` cannot be used:
    // it has deliberate nulls, which the "leaves a missing value empty" case
    // depends on, and they would read here as five unprojected columns.
    const unprojected = USER_EXPORT_COLUMNS.filter(
      (column) => projectCell(column, FULL).length === 0,
    ).map((column) => column.id);

    assert.deepEqual(unprojected, [], 'these columns are in the catalogue and project nothing');
  });
});

describe('what a cell says', () => {
  it('writes dates as ISO, not as the server locale', () => {
    assert.equal(cell('created_at'), '2026-06-01T10:00:00.000Z');
  });

  it('writes a big Telegram id without going through a float', () => {
    // `telegramId` is a BigInt. Any arithmetic on the way out would round it,
    // and a rounded Telegram id is a wrong one that still looks right.
    assert.equal(cell('telegram_id'), '813364774');
  });

  it('says yes and no rather than true and false', () => {
    // Excel turns TRUE/FALSE into its own boolean type and 1/0 into numbers;
    // both then sort and filter as something other than what the column holds.
    assert.equal(cell('is_blocked'), 'no');
    assert.equal(cell('pwa_installed'), 'yes');
  });

  it('leaves a missing value empty rather than writing the word null', () => {
    assert.equal(cell('email'), '');
    assert.equal(cell('onboarding_completed_at'), '');
  });
});

describe('the client the customer actually uses', () => {
  it('is the name out of the user agent, which is where Remnawave puts it', () => {
    // The panel's HWID table has a User-Agent column and no other field naming
    // the client. The leading product token is the name — `FlClash X/v0.3.2 …`
    // → `FlClash`, `INCY/3.6.2/android …` → `INCY` — and it comes from
    // `deriveClientType`, which already answers this for the admin request log.
    // Sharing it is why the two never disagree about one customer, and it is
    // also why the answer stops at the first space rather than keeping the "X".
    assert.equal(cell('device_apps'), 'FlClash | INCY');
  });

  it('keeps the raw agent beside it, for the version', () => {
    assert.match(cell('device_user_agents'), /FlClash X\/v0\.3\.2/);
    assert.match(cell('device_user_agents'), /INCY\/3\.6\.2/);
  });

  it('does not blank an unknown client', () => {
    // A lookup table of known clients would export a new one as empty — the one
    // failure mode that reads as "this person uses nothing".
    const row: UserExportRow = {
      ...ROW,
      devices: [{ ...ROW.devices![0], userAgent: 'SomeNewClient/9.9' }],
    };

    assert.equal(cell('device_apps', row), 'SomeNewClient');
  });

  it('survives an agent with no slash in it at all', () => {
    const row: UserExportRow = {
      ...ROW,
      devices: [{ ...ROW.devices![0], userAgent: 'happ' }],
    };

    assert.equal(cell('device_apps', row), 'happ');
  });

  it('collapses two devices running the same client to one name', () => {
    const row: UserExportRow = {
      ...ROW,
      devices: [
        { ...ROW.devices![0], userAgent: 'Happ/1.0/ios' },
        { ...ROW.devices![1], userAgent: 'Happ/1.1/ios' },
      ],
    };

    assert.equal(cell('device_apps', row), 'Happ');
  });

  it('reports the most recent device as last seen', () => {
    assert.equal(cell('device_last_seen_at'), '2026-09-09T21:08:38.000Z');
  });
});

describe('a device count nobody can stand behind', () => {
  it('is empty when the panel was never asked', () => {
    // NOT ZERO. A `0` here is a finding — "this person has connected nothing" —
    // and inventing it out of an export that did not ask the panel is the file
    // telling the operator something untrue.
    const row: UserExportRow = { ...ROW, devices: null };

    assert.equal(cell('device_count', row), '');
    assert.equal(cell('device_hwids', row), '');
    assert.equal(cell('device_apps', row), '');
  });

  it('is zero when the panel answered and held nothing', () => {
    const row: UserExportRow = { ...ROW, devices: [] };

    assert.equal(cell('device_count', row), '0');
  });
});

describe('choosing the columns', () => {
  it('gives everything when the operator changed nothing', () => {
    const columns = resolveExportColumns(undefined, { allowElevated: true });

    assert.equal(columns.length, USER_EXPORT_COLUMNS.length);
  });

  it('drops the registration snapshot from a caller without the permission', () => {
    const columns = resolveExportColumns(undefined, { allowElevated: false });

    assert.ok(columns.length < USER_EXPORT_COLUMNS.length);
    assert.equal(
      columns.some((column) => column.elevated === true),
      false,
    );
  });

  it('keeps the catalogue order whatever order they were asked for', () => {
    // Two exports a week apart are read side by side, and columns that move
    // between them cannot be diffed.
    const columns = resolveExportColumns(['username', 'reiwa_id', 'created_at'], {
      allowElevated: true,
    });

    assert.deepEqual(
      columns.map((column) => column.id),
      ['reiwa_id', 'username', 'created_at'],
    );
  });

  it('ignores an id this build does not know', () => {
    // A stale tab or a hand-written URL. Refusing would lose the whole export
    // over one column nobody can see any more.
    const columns = resolveExportColumns(['username', 'from_the_future'], {
      allowElevated: true,
    });

    assert.deepEqual(
      columns.map((column) => column.id),
      ['username'],
    );
  });

  it('names the elevated ids in a request, so the caller can refuse', () => {
    // Refused, not dropped: a silently missing column is indistinguishable from
    // an empty one, and this one holds the customer's IP.
    assert.deepEqual(elevatedAmong(['username', 'registration_ip']), ['registration_ip']);
    assert.deepEqual(elevatedAmong(['username']), []);
  });
});

describe('what the chosen columns cost', () => {
  it('asks the panel only when a device column was picked', () => {
    // The device sweep is a paged walk of the operator's production panel. An
    // export of names and emails must not pay for it.
    assert.equal(
      needsPanelDevices(resolveExportColumns(['username', 'email'], { allowElevated: true })),
      false,
    );
    assert.equal(
      needsPanelDevices(resolveExportColumns(['device_apps'], { allowElevated: true })),
      true,
    );
  });

  it('joins the subscription only when a subscription column was picked', () => {
    assert.equal(
      needsSubscription(resolveExportColumns(['username'], { allowElevated: true })),
      false,
    );
    assert.equal(
      needsSubscription(
        resolveExportColumns(['subscription_expires_at'], { allowElevated: true }),
      ),
      true,
    );
  });
});

describe('the file itself', () => {
  it('starts with the BOM Excel needs and the chosen headers', () => {
    const columns = resolveExportColumns(['reiwa_id', 'username'], { allowElevated: true });
    const csv = renderUserExportCsv(columns, [ROW]);

    assert.ok(csv.startsWith('﻿'), 'no BOM — Excel will mis-read the Cyrillic');
    // Bare, not quoted: the writer only quotes a value that needs it, so a
    // header that grew quotes would mean a column id had gained a comma.
    // Line 1 is Excel's separator hint; the header is line 2. See below.
    assert.equal(csv.split('\r\n')[1], 'reiwa_id,username');
  });

  it('defangs a username that Excel would run as a formula', () => {
    // The customer chose the username. `=cmd|...` in a cell executes on open.
    const columns = resolveExportColumns(['username'], { allowElevated: true });
    const csv = renderUserExportCsv(columns, [{ ...ROW, username: '=1+1' }]);

    assert.ok(!csv.includes('"=1+1"'), 'a formula reached the file unescaped');
    assert.ok(csv.includes("'=1+1"));
  });

  it('writes one line per user, plus the header and the separator hint', () => {
    const columns = resolveExportColumns(['reiwa_id'], { allowElevated: true });
    const csv = renderUserExportCsv(columns, [ROW, { ...ROW, id: 'user-2' }]);

    assert.equal(csv.split('\r\n').length, 4);
  });
});

describe('the file an operator opens in Excel', () => {
  /**
   * Two ways the file was unreadable on the machine it is downloaded to, both
   * of them silent: nothing fails, nothing warns, and the spreadsheet opens.
   */

  it('tells a Russian Excel where the columns are', () => {
    // Excel splits on the WINDOWS LIST SEPARATOR, which is `;` on a ru-RU
    // install — so a comma-delimited file arrives as ONE COLUMN with every
    // row's whole text in cell A. `sep=,` is Excel's own override for that.
    const columns = resolveExportColumns(['reiwa_id', 'username'], { allowElevated: true });
    const csv = renderUserExportCsv(columns, [ROW]);

    const [first, second] = csv.split('\r\n');
    // ORDER, and both halves of it. The BOM has to be the first thing in the
    // file or Excel mis-decodes the Cyrillic; `sep=,` has to be the first LINE
    // or Excel reads it as the header row instead of as an instruction.
    assert.equal(first, '﻿sep=,', 'the separator hint is not the first line, after the BOM');
    assert.equal(second, 'reiwa_id,username', 'the header is not the second line');
  });

  it('keeps a nineteen-digit id as text rather than letting Excel round it', () => {
    // Excel holds numbers as doubles and rounds past 15 significant digits, so
    // a long Telegram id does not merely DISPLAY as `4.5E+18` — the digits are
    // gone from the cell and no reformatting brings them back.
    const columns = resolveExportColumns(['telegram_id'], { allowElevated: true });
    const csv = renderUserExportCsv(columns, [{ ...ROW, telegramId: BigInt('4593017384019283746') }]);

    // The cell text is `="4593017384019283746"`, and because that text contains
    // quotes the writer has to quote the field and double them — so the file
    // stays well-formed CSV rather than gaining a stray quote.
    assert.equal(
      csv.split('\r\n')[2],
      '"=""4593017384019283746"""',
      'a 19-digit id reached the file as a bare number — Excel will round it',
    );
  });

  it('leaves a short id alone, because Excel holds that one exactly', () => {
    // 15 digits is the last length Excel keeps. Decorating anything shorter
    // would put `="…"` in front of far more cells than the defect warrants,
    // and every one of those is a cell a script then has to strip.
    const columns = resolveExportColumns(['telegram_id'], { allowElevated: true });
    const fifteen = renderUserExportCsv(columns, [
      { ...ROW, telegramId: BigInt('123456789012345') },
    ]);

    assert.equal(
      fifteen.split('\r\n')[2],
      '123456789012345',
      'a 15-digit id was decorated for no reason',
    );
  });
});

describe('a value an operator would act on', () => {
  /**
   * Four separate ways this export said something untrue, all of them shaped
   * like data rather than like an error. None was caught by the cases above,
   * because each one tested the projection against a fixture built to match it.
   */

  it('reports the last connection, which the panel sends as a Date', () => {
    // The contract schema declares `createdAt`/`updatedAt` as transform pipes
    // to `Date` and declares no `lastSeenAt` at all. A reader that accepted
    // only a string wrote an EMPTY cell on every healthy panel and populated
    // only when the panel's answer FAILED the schema — it worked exactly when
    // the panel was wrong.
    const row: UserExportRow = {
      ...ROW,
      devices: [
        { ...ROW.devices![0], lastSeenAt: new Date('2026-08-27T21:05:44.000Z') },
        { ...ROW.devices![1], lastSeenAt: new Date('2026-09-09T21:08:38.000Z') },
      ],
    };

    assert.equal(cell('device_last_seen_at', row), '2026-09-09T21:08:38.000Z');
  });

  it('counts a device once when two subscriptions share one panel profile', () => {
    // Donor imports produce duplicate panel ids — the index is deliberately not
    // unique and a merge service exists for them — so the device lists were
    // concatenated and the count came out double the hwid list beside it.
    const row: UserExportRow = {
      ...ROW,
      devices: [...ROW.devices!, ...ROW.devices!],
    };

    assert.equal(cell('device_count', row), '2');
    assert.equal(cell('device_hwids', row), cell('device_hwids'));
  });

  it('says unlimited rather than zero, because zero is a different claim', () => {
    // `0` means unlimited throughout this product. Exported as a number it
    // sorts every unlimited customer to the top of an ascending sort as "may
    // connect no devices" — the same false zero the device count refuses.
    const row: UserExportRow = {
      ...ROW,
      subscription: { ...ROW.subscription!, trafficLimit: 0, deviceLimit: 0 },
    };

    assert.equal(cell('subscription_traffic_limit_gb', row), 'unlimited');
    assert.equal(cell('subscription_device_limit', row), 'unlimited');
  });

  it('names the traffic column after the unit it actually holds', () => {
    // `Subscription.trafficLimit` is GIGABYTES — the sync processor multiplies
    // by 1024³ on the way to the panel. A column called `…_bytes` understated
    // every figure by a factor of a billion under a header an operator filters
    // on.
    assert.ok(
      USER_EXPORT_COLUMNS.some((column) => column.id === 'subscription_traffic_limit_gb'),
    );
    assert.equal(
      USER_EXPORT_COLUMNS.some((column) => column.id.endsWith('_bytes')),
      false,
      'a column claims bytes for a value stored in gigabytes',
    );
    // The fixture's own plan is unlimited, so a real limit is needed to see
    // the number pass through untouched.
    const limited: UserExportRow = {
      ...ROW,
      subscription: { ...ROW.subscription!, trafficLimit: 200 },
    };
    assert.equal(cell('subscription_traffic_limit_gb', limited), '200');
  });
});
