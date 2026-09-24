/**
 * Contract tests for the "extended" Remnawave mappers.
 *
 * WHY THESE FIXTURES LOOK THE WAY THEY DO. The defects these tests pin down
 * survived because the mocks that existed agreed with the CODE instead of with
 * the PANEL: a mapper read `provider.monthlyCost`, a mock supplied
 * `monthlyCost`, the assertion passed, and the operator still saw a blank
 * column because Remnawave has never sent that field.
 *
 * So every fixture below is pinned to the record it stands for. On the
 * spec-quoted blocks that pin is the `required` array quoted verbatim from
 * `Remnawave API v3.3.2.json` / `Remnawave API v3.4.3.json` — the panels rezeis
 * serves — and a guard asserts the fixture's own key set is EXACTLY that
 * array — no more, no less. Padding a fixture with a field the panel does not
 * send now fails loudly instead of quietly vouching for a mapper that reads it.
 *
 * The 3.2.1 block is pinned differently and says so where it starts: there is
 * no `Remnawave API v321.json` to quote, so it is pinned against a payload
 * measured on a live 3.2.1 panel instead.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// The contract panel 3.2.0–3.2.1 ships (backend-contract 3.2.0), per the
// vendor's own table — the release the 3.2.1 captures below were taken from.
import { ExtendedUsersSchema, HwidUserDeviceSchema } from '@remnawave/contract-panel-3.2.1';

import {
  mapHwidTopUser,
  mapInfraProvider,
  mapNodePlugin,
  mapSnippet,
  mapSubpageConfig,
  mapSubscriptionSettings,
  mapUserSummary,
} from '../src/modules/remnawave/services/remnawave-extended-mappers';

/**
 * Asserts a fixture is shaped like the panel record it claims to be.
 *
 * This is the anti-vacuity guard: without it, every assertion below could be
 * satisfied by a fixture invented to match whatever the mapper happens to read
 * today, which is precisely how the current defects shipped.
 */
function assertMatchesSpecRecord(
  fixture: Readonly<Record<string, unknown>>,
  specRequired: readonly string[],
  label: string,
): void {
  assert.deepStrictEqual(
    Object.keys(fixture).sort(),
    [...specRequired].sort(),
    `${label}: fixture keys drifted from the OpenAPI "required" array — the fixture must mirror the panel, not the mapper`,
  );
}

/**
 * The same guard for a record with no OpenAPI file behind it.
 *
 * Identical mechanics, different authority, and the difference is stated
 * rather than blurred: `capturedKeys` is a key set READ OFF A LIVE PANEL, not
 * quoted out of a spec document. See the 3.2.1 section for where that capture
 * came from and why no spec document is cited.
 */
function assertMatchesCapturedRecord(
  fixture: Readonly<Record<string, unknown>>,
  capturedKeys: readonly string[],
  label: string,
): void {
  assert.deepStrictEqual(
    Object.keys(fixture).sort(),
    [...capturedKeys].sort(),
    `${label}: fixture keys drifted from the payload captured off a live panel — the fixture must mirror the panel, not the mapper`,
  );
}

// ── HWID top users ──────────────────────────────────────────────────────────
//
// `GET /api/hwid/devices/top-users` → `response.users[]`, whose `required` is
// identical in 3.3.2 and 3.4.3: ["id","username","devicesCount"]. No uuid of
// any spelling — the `userUuid` 2.x sent beside the id is gone.

const TOP_USER_REQUIRED = ['id', 'username', 'devicesCount'] as const;

const TOP_USER = { id: 4471, username: 'rz_user_4471', devicesCount: 9 };

describe('mapHwidTopUser', () => {
  it('keys a row by its numeric id, in the decimal form remnawaveId holds', () => {
    assertMatchesSpecRecord(TOP_USER, TOP_USER_REQUIRED, 'hwidTopUser');

    // `userUuid` is the SPA's name for the field, not a uuid.
    assert.deepStrictEqual(mapHwidTopUser(TOP_USER), {
      userUuid: '4471',
      username: 'rz_user_4471',
      telegramId: null,
      devicesCount: 9,
      lastSeenAt: null,
    });
  });

  it('reads no uuid spelling — a row that still carries one is keyed by its id', () => {
    for (const legacy of [
      { userUuid: 'b7f1e0c2-1111-4222-8333-444455556666' },
      { userId: 'b7f1e0c2-1111-4222-8333-444455556666' },
      { uuid: 'b7f1e0c2-1111-4222-8333-444455556666' },
      { user: { uuid: 'b7f1e0c2-1111-4222-8333-444455556666', id: 1 } },
    ]) {
      assert.equal(mapHwidTopUser({ ...TOP_USER, ...legacy }).userUuid, '4471', JSON.stringify(legacy));
    }
  });

  it('does not invent an identity from an id that is not an integer', () => {
    assert.equal(mapHwidTopUser({ ...TOP_USER, id: 1.5 }).userUuid, '');
    assert.equal(mapHwidTopUser({ username: 'no-id', devicesCount: 1 }).userUuid, '');
  });
});

// ── Infra providers ─────────────────────────────────────────────────────────
//
// `GET /api/infra-billing/providers` → `response.providers[]`, whose
// `required` is identical in 3.3.2 and 3.4.3:
//   ["uuid","name","faviconLink","loginUrl","createdAt","updatedAt",
//    "billingHistory","billingNodes"]
// and `billingNodes[]`'s is ["name","details"], `details` nullable.

const PROVIDER_REQUIRED = [
  'uuid',
  'name',
  'faviconLink',
  'loginUrl',
  'createdAt',
  'updatedAt',
  'billingHistory',
  'billingNodes',
] as const;

const BILLING_NODE_REQUIRED = ['name', 'details'] as const;

const PROVIDER = {
  uuid: '0e0f0f4a-9f5a-4b1a-9a30-6f9c2f4f7a11',
  name: 'Hetzner',
  faviconLink: 'https://hetzner.com/favicon.ico',
  loginUrl: null,
  createdAt: '2026-01-04T10:00:00.000Z',
  updatedAt: '2026-05-19T08:22:31.000Z',
  billingHistory: { totalAmount: 428.5, totalBills: 7 },
  billingNodes: [
    {
      name: 'de-fsn-1',
      details: { nodeUuid: 'aaaaaaaa-0000-4000-8000-000000000001', countryCode: 'DE' },
    },
    // A billing line whose node is gone. The panel keeps the line and nulls
    // `details` — it does not drop the row.
    { name: 'retired-node', details: null },
  ],
};

describe('mapInfraProvider', () => {
  it('reads the provider record the panel actually sends', () => {
    assertMatchesSpecRecord(PROVIDER, PROVIDER_REQUIRED, 'provider');
    for (const node of PROVIDER.billingNodes) {
      assertMatchesSpecRecord(node, BILLING_NODE_REQUIRED, 'provider.billingNodes[]');
    }

    assert.deepStrictEqual(mapInfraProvider(PROVIDER), {
      uuid: '0e0f0f4a-9f5a-4b1a-9a30-6f9c2f4f7a11',
      name: 'Hetzner',
      faviconLink: 'https://hetzner.com/favicon.ico',
      loginUrl: null,
      billedTotalAmount: 428.5,
      billsCount: 7,
      billingNodes: [
        { nodeUuid: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'de-fsn-1', countryCode: 'DE' },
        // The count is what the Costs tab renders; a `details`-less orphan must
        // still be counted, or the operator reconciles against a short number.
        { nodeUuid: null, name: 'retired-node', countryCode: null },
      ],
      createdAt: '2026-01-04T10:00:00.000Z',
      updatedAt: '2026-05-19T08:22:31.000Z',
    });
  });

  it('reads the node of a billing line out of `details` only', () => {
    // The flat `{ nodeUuid, name, countryCode }` line was 2.7's. No supported
    // panel sends it, and the mapper does not read it.
    const flat = mapInfraProvider({
      ...PROVIDER,
      billingNodes: [{ nodeUuid: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'fi-hel-1', countryCode: 'FI' }],
    });
    assert.deepStrictEqual(flat.billingNodes, [{ nodeUuid: null, name: 'fi-hel-1', countryCode: null }]);
  });

  it('exposes no field the panel does not send', () => {
    // `type`, `currency`, `monthlyCost` and `nodesCount` were read here and
    // appear in no spec. Re-adding one would put a permanent `—`/`0` back on
    // the Costs tab, so the exact surface is pinned.
    assert.deepStrictEqual(Object.keys(mapInfraProvider(PROVIDER)).sort(), [
      'billedTotalAmount',
      'billingNodes',
      'billsCount',
      'createdAt',
      'faviconLink',
      'loginUrl',
      'name',
      'updatedAt',
      'uuid',
    ]);
  });

  it('degrades to zeros and an empty node list, never to a throw', () => {
    assert.deepStrictEqual(mapInfraProvider(null), {
      uuid: '',
      name: '',
      faviconLink: null,
      loginUrl: null,
      billedTotalAmount: 0,
      billsCount: 0,
      billingNodes: [],
      createdAt: '',
      updatedAt: '',
    });
  });
});

// ── Node plugins ────────────────────────────────────────────────────────────
//
// `GET /api/node-plugins` → `response.nodePlugins[]`. `required` in 3.3.2:
// ["uuid","viewPosition","name","pluginConfig"]; 3.4.3 adds "tags", which the
// mapper does not surface.

const NODE_PLUGIN_REQUIRED = ['uuid', 'viewPosition', 'name', 'pluginConfig'] as const;
const NODE_PLUGIN_REQUIRED_343 = ['uuid', 'viewPosition', 'name', 'tags', 'pluginConfig'] as const;

const NODE_PLUGIN_CONFIGURED = {
  uuid: 'bbbbbbbb-0000-4000-8000-000000000001',
  viewPosition: 1,
  name: 'torrent-blocker',
  pluginConfig: { blockDuration: 3600 },
};

const NODE_PLUGIN_BARE = {
  uuid: 'bbbbbbbb-0000-4000-8000-000000000002',
  viewPosition: 2,
  name: 'no-config-plugin',
  pluginConfig: null,
};

describe('mapNodePlugin', () => {
  it('reads the record the panel sends, with or without 3.4 tags', () => {
    assertMatchesSpecRecord(NODE_PLUGIN_CONFIGURED, NODE_PLUGIN_REQUIRED, 'nodePlugin');
    const tagged = { ...NODE_PLUGIN_CONFIGURED, tags: ['EU'] };
    assertMatchesSpecRecord(tagged, NODE_PLUGIN_REQUIRED_343, 'nodePlugin/3.4.3');

    const expected = {
      uuid: 'bbbbbbbb-0000-4000-8000-000000000001',
      name: 'torrent-blocker',
      viewPosition: 1,
      hasConfig: true,
    };
    assert.deepStrictEqual(mapNodePlugin(NODE_PLUGIN_CONFIGURED), expected);
    assert.deepStrictEqual(mapNodePlugin(tagged), expected);
  });

  it('distinguishes a null pluginConfig from a populated one', () => {
    assertMatchesSpecRecord(NODE_PLUGIN_BARE, NODE_PLUGIN_REQUIRED, 'nodePlugin/bare');

    assert.equal(mapNodePlugin(NODE_PLUGIN_BARE).hasConfig, false);
    assert.equal(mapNodePlugin(NODE_PLUGIN_CONFIGURED).hasConfig, true);
  });

  it('exposes no field the panel does not send', () => {
    // `enabled` in particular: it was `Boolean(undefined)` for every row, so
    // the settings tab reported every registered plugin as disabled.
    assert.deepStrictEqual(Object.keys(mapNodePlugin(NODE_PLUGIN_CONFIGURED)).sort(), [
      'hasConfig',
      'name',
      'uuid',
      'viewPosition',
    ]);
  });
});

// ── Snippets ────────────────────────────────────────────────────────────────
//
// `GET /api/snippets` → `response.snippets[]`, `required` identical in 3.3.2
// and 3.4.3: ["name","snippet"]. The write DTO types `snippet` as
// `{"type":"array","items":{"type":"object"}}`.

const SNIPPET_REQUIRED = ['name', 'snippet'] as const;

const SNIPPET_A = { name: 'happ-routing', snippet: [{ tag: 'direct' }, { tag: 'proxy' }] };
const SNIPPET_B = { name: 'happ-announce', snippet: [] };

describe('mapSnippet', () => {
  it('reads the two-field record the panel sends', () => {
    assertMatchesSpecRecord(SNIPPET_A, SNIPPET_REQUIRED, 'snippet');

    assert.deepStrictEqual(mapSnippet(SNIPPET_A), {
      name: 'happ-routing',
      entriesCount: 2,
    });
  });

  it('gives every snippet a distinct identity — `uuid` was `""` for all of them', () => {
    assertMatchesSpecRecord(SNIPPET_B, SNIPPET_REQUIRED, 'snippet/empty');

    // The catalog table keys rows by this value. Two spec-shaped snippets used
    // to produce two empty keys, i.e. a React duplicate-key collision.
    const names = [mapSnippet(SNIPPET_A).name, mapSnippet(SNIPPET_B).name];
    assert.deepStrictEqual(names, ['happ-routing', 'happ-announce']);
    assert.equal(new Set(names).size, 2);
    for (const name of names) assert.notEqual(name, '');
  });

  it('reports an unparseable snippet body as unknown rather than as zero entries', () => {
    assert.equal(mapSnippet({ name: 'weird', snippet: 'not-an-array' }).entriesCount, null);
    assert.equal(mapSnippet(SNIPPET_B).entriesCount, 0);
  });

  it('exposes no field the panel does not send', () => {
    assert.deepStrictEqual(Object.keys(mapSnippet(SNIPPET_A)).sort(), ['entriesCount', 'name']);
  });
});

// ── Subscription page configs ───────────────────────────────────────────────
//
// `GET /api/subscription-page-configs` → `response.configs[]`. `required` in
// 3.3.2: ["uuid","viewPosition","name","config"]; 3.4.3 adds "tags", which the
// mapper does not surface.

const SUBPAGE_REQUIRED = ['uuid', 'viewPosition', 'name', 'config'] as const;
const SUBPAGE_REQUIRED_343 = ['uuid', 'viewPosition', 'name', 'tags', 'config'] as const;

const SUBPAGE_CONFIGURED = {
  uuid: 'cccccccc-0000-4000-8000-000000000001',
  viewPosition: 1,
  name: 'default-page',
  config: { theme: 'dark' },
};

const SUBPAGE_BARE = {
  uuid: 'cccccccc-0000-4000-8000-000000000002',
  viewPosition: 2,
  name: 'blank-page',
  config: null,
};

describe('mapSubpageConfig', () => {
  it('reads the record the panel sends, with or without 3.4 tags', () => {
    assertMatchesSpecRecord(SUBPAGE_CONFIGURED, SUBPAGE_REQUIRED, 'subpageConfig');
    const tagged = { ...SUBPAGE_CONFIGURED, tags: ['EU'] };
    assertMatchesSpecRecord(tagged, SUBPAGE_REQUIRED_343, 'subpageConfig/3.4.3');

    const expected = {
      uuid: 'cccccccc-0000-4000-8000-000000000001',
      name: 'default-page',
      viewPosition: 1,
      hasConfig: true,
    };
    assert.deepStrictEqual(mapSubpageConfig(SUBPAGE_CONFIGURED), expected);
    assert.deepStrictEqual(mapSubpageConfig(tagged), expected);
  });

  it('distinguishes a null config from a populated one', () => {
    assertMatchesSpecRecord(SUBPAGE_BARE, SUBPAGE_REQUIRED, 'subpageConfig/bare');

    assert.equal(mapSubpageConfig(SUBPAGE_BARE).hasConfig, false);
    assert.equal(mapSubpageConfig(SUBPAGE_CONFIGURED).hasConfig, true);
  });

  it('exposes no field the panel does not send', () => {
    // `title` drove the catalog card's per-page subtitle and was never sent,
    // so the subtitle never rendered on any panel.
    assert.deepStrictEqual(Object.keys(mapSubpageConfig(SUBPAGE_CONFIGURED)).sort(), [
      'hasConfig',
      'name',
      'uuid',
      'viewPosition',
    ]);
  });
});

// ── Subscription settings ───────────────────────────────────────────────────
//
// `GET /api/subscription-settings` → `response`, whose `required` is identical
// in 3.3.2 and 3.4.3. The six display fields a Settings screen shows are not
// on it any more: they travel in `customResponseHeaders`, a free-form
// `name -> value` map.

const SETTINGS_REQUIRED = [
  'uuid',
  'serveJsonAtBaseSubscription',
  'isShowCustomRemarks',
  'customRemarks',
  'customResponseHeaders',
  'randomizeHosts',
  'responseRules',
  'hwidSettings',
  'createdAt',
  'updatedAt',
] as const;

const SETTINGS = {
  uuid: 'dddddddd-0000-4000-8000-00000000000a',
  serveJsonAtBaseSubscription: false,
  isShowCustomRemarks: true,
  customRemarks: {
    expiredUsers: ['expired'],
    limitedUsers: ['limited'],
    disabledUsers: ['disabled'],
    emptyHosts: ['empty'],
    HWIDMaxDevicesExceeded: ['max'],
    HWIDNotSupported: ['unsupported'],
  },
  customResponseHeaders: {
    // The panel's own marker for a value the client must receive base64'd.
    'profile-title': `rwEncodeBase64:${Buffer.from('Мой VPN', 'utf8').toString('base64')}`,
    'support-url': 'https://t.me/support',
    'profile-update-interval': '12',
    'profile-web-page-url': 'https://sub.example.com',
    announce: '{"token":"raw-announce-secret"}',
    routing: 'happ://routing/raw-route-secret',
  },
  randomizeHosts: false,
  responseRules: null,
  hwidSettings: null,
  createdAt: '2026-04-19T10:00:00.000Z',
  updatedAt: '2026-04-19T10:00:00.000Z',
};

describe('mapSubscriptionSettings', () => {
  it('reads the display fields out of the response headers the panel sends', () => {
    assertMatchesSpecRecord(SETTINGS, SETTINGS_REQUIRED, 'subscriptionSettings');

    const mapped = mapSubscriptionSettings(SETTINGS);
    assert.equal(mapped.profileTitle, 'Мой VPN');
    assert.equal(mapped.supportLink, 'https://t.me/support');
    assert.equal(mapped.profileUpdateInterval, 12);
    assert.equal(mapped.isProfileWebpageUrlEnabled, true);
    assert.equal(mapped.hasHappAnnounce, true);
    assert.equal(mapped.hasHappRouting, true);
    // Presence only: the raw values carry tokens and never leave the server.
    const serialized = JSON.stringify(mapped);
    assert.equal(serialized.includes('raw-announce-secret'), false);
    assert.equal(serialized.includes('raw-route-secret'), false);
  });

  it('reads an empty header map as "not configured", not as a failure', () => {
    const mapped = mapSubscriptionSettings({ ...SETTINGS, customResponseHeaders: null });
    assert.equal(mapped.profileTitle, '');
    assert.equal(mapped.supportLink, null);
    assert.equal(mapped.isProfileWebpageUrlEnabled, false);
    assert.equal(mapped.hasHappAnnounce, false);
  });
});

// ── User summary ────────────────────────────────────────────────────────────
//
// `GET /api/users/by-{short-uuid,username}/…`, whose `response.required` is
// identical in 3.3.2 and 3.4.3 — and identical to the 3.2.1 capture below:
//   ["id","shortUuid","username","status","trafficLimitBytes",
//    "trafficLimitStrategy","expireAt","telegramId","email","description",
//    "tag","hwidDeviceLimit","externalSquadUuid","trojanPassword","vlessUuid",
//    "ssPassword","lastTriggeredThreshold","subRevokedAt","lastTrafficResetAt",
//    "createdAt","updatedAt","subscriptionUrl","activeInternalSquads",
//    "userTraffic"]

const USER_REQUIRED = [
  'id',
  'shortUuid',
  'username',
  'status',
  'trafficLimitBytes',
  'trafficLimitStrategy',
  'expireAt',
  'telegramId',
  'email',
  'description',
  'tag',
  'hwidDeviceLimit',
  'externalSquadUuid',
  'trojanPassword',
  'vlessUuid',
  'ssPassword',
  'lastTriggeredThreshold',
  'subRevokedAt',
  'lastTrafficResetAt',
  'createdAt',
  'updatedAt',
  'subscriptionUrl',
  'activeInternalSquads',
  'userTraffic',
] as const;

const USER_RECORD = {
  id: 4211,
  shortUuid: 'aB3xY9zQ',
  username: 'durov',
  status: 'ACTIVE',
  trafficLimitBytes: 107374182400,
  trafficLimitStrategy: 'MONTH',
  expireAt: '2026-09-01T00:00:00.000Z',
  // `{"type": "number", "nullable": true}` — a NUMBER.
  telegramId: 123456789,
  email: 'durov@example.com',
  description: null,
  tag: 'VIP',
  hwidDeviceLimit: 5,
  externalSquadUuid: null,
  trojanPassword: 'tp',
  vlessUuid: 'eeeeeeee-0000-4000-8000-000000000001',
  ssPassword: 'ss',
  lastTriggeredThreshold: 0,
  subRevokedAt: null,
  lastTrafficResetAt: null,
  createdAt: '2025-11-07T08:13:47.071Z',
  updatedAt: '2026-06-01T12:00:00.000Z',
  subscriptionUrl: 'https://sub.example.com/aB3xY9zQ',
  activeInternalSquads: [{ uuid: 'ffffffff-0000-4000-8000-000000000001', name: 'Default-Squad' }],
  // Consumption lives HERE; there is no row-level `trafficUsedBytes` on the
  // user lookups.
  userTraffic: {
    usedTrafficBytes: 53687091200,
    lifetimeUsedTrafficBytes: 96636764160,
    onlineAt: '2026-06-02T09:41:00.000Z',
    firstConnectedAt: '2025-11-08T10:00:00.000Z',
    lastConnectedNodeUuid: 'aaaaaaaa-0000-4000-8000-000000000001',
  },
};

describe('mapUserSummary', () => {
  it('reads consumption from `userTraffic.usedTrafficBytes`, not from the row', () => {
    assertMatchesSpecRecord(USER_RECORD, USER_REQUIRED, 'user');

    // The "Resolve user" panel renders `formatBytes(trafficUsedBytes ?? 0)`.
    // Reading the row level made that `0 B` for every user on every version.
    const mapped = mapUserSummary(USER_RECORD);
    assert.equal(mapped.trafficUsedBytes, 53687091200);
    assert.notEqual(mapped.trafficUsedBytes, 0);
    assert.equal(mapped.trafficLimitBytes, 107374182400);
    // Guard against the assertion above being satisfied by a coincidence:
    // the number must be the nested one, not the limit and not the lifetime.
    assert.notEqual(mapped.trafficUsedBytes, mapped.trafficLimitBytes);
    assert.notEqual(mapped.trafficUsedBytes, USER_RECORD.userTraffic.lifetimeUsedTrafficBytes);
  });

  it('stringifies the numeric telegramId the panel sends', () => {
    // A string-only read discarded every id that existed.
    assert.equal(mapUserSummary(USER_RECORD).telegramId, '123456789');
    assert.equal(mapUserSummary({ ...USER_RECORD, telegramId: null }).telegramId, null);
    // A transport that already stringified it must survive untouched.
    assert.equal(mapUserSummary({ ...USER_RECORD, telegramId: '987654321' }).telegramId, '987654321');
    // A value that has already lost precision is refused, not printed.
    assert.equal(mapUserSummary({ ...USER_RECORD, telegramId: 1.5 }).telegramId, null);
  });

  it('maps the rest of the record the panel really sends', () => {
    assert.deepStrictEqual(mapUserSummary(USER_RECORD), {
      // No uuid on a 3.x user: the identity is the numeric id as a string.
      uuid: '4211',
      panelId: 4211,
      shortUuid: 'aB3xY9zQ',
      username: 'durov',
      status: 'ACTIVE',
      trafficLimitBytes: 107374182400,
      trafficUsedBytes: 53687091200,
      hwidDeviceLimit: 5,
      expireAt: '2026-09-01T00:00:00.000Z',
      telegramId: '123456789',
      email: 'durov@example.com',
      tag: 'VIP',
      createdAt: '2025-11-07T08:13:47.071Z',
      updatedAt: '2026-06-01T12:00:00.000Z',
      subscriptionUrl: 'https://sub.example.com/aB3xY9zQ',
    });
  });

  it('reports absent consumption as null rather than as zero usage', () => {
    // A record with no `userTraffic` block at all must not read as "0 B used".
    const { userTraffic: _omitted, ...withoutTraffic } = USER_RECORD;
    assert.equal(mapUserSummary(withoutTraffic).trafficUsedBytes, null);
  });
});

// ── User summary on 3.2.1 ───────────────────────────────────────────────────
//
// WHERE THE PIN COMES FROM, SINCE IT IS NOT AN OPENAPI FILE. The blocks above
// quote `required` arrays out of `Remnawave API v3.3.2.json` /
// `Remnawave API v3.4.3.json`. There is no `Remnawave API v321.json` — the
// file does not exist in this repo and is not being invented to make this
// section look like the others. The key set below was MEASURED: it is the
// `user` object of a payload captured off a live Remnawave 3.2.1 panel
// (`GET /api/users/{userId}`), and the two user fixtures under
// `test/fixtures/remnawave/3.2.1/` are that same payload with its credential
// fields replaced by same-shaped placeholders.
//
// A capture pins one panel on one day, so it is corroborated below against the
// vendor's own `ExtendedUsersSchema` from the contract panel 3.2.1 actually
// ships — `@remnawave/contract-panel-3.2.1`, backend-contract 3.2.0, per the
// vendor's table. A second witness from a different source, not the authority:
// they agree exactly, all 24 keys, and if they ever disagree that test fails
// and the disagreement is the finding.

const USER_321_CAPTURED_KEYS = [
  'id',
  'shortUuid',
  'username',
  'status',
  'trafficLimitBytes',
  'trafficLimitStrategy',
  'expireAt',
  'telegramId',
  'email',
  'description',
  'tag',
  'hwidDeviceLimit',
  'externalSquadUuid',
  'trojanPassword',
  'vlessUuid',
  'ssPassword',
  'lastTriggeredThreshold',
  'subRevokedAt',
  'lastTrafficResetAt',
  'createdAt',
  'updatedAt',
  'subscriptionUrl',
  'activeInternalSquads',
  'userTraffic',
] as const;

/** Captured nested consumption block. */
const USER_TRAFFIC_321_CAPTURED_KEYS = [
  'usedTrafficBytes',
  'lifetimeUsedTrafficBytes',
  'onlineAt',
  'lastConnectedNodeUuid',
  'firstConnectedAt',
] as const;

/** `response` of a fixture under `test/fixtures/remnawave/`. */
function fixtureResponse(rel: string): Record<string, unknown> {
  const parsed = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'remnawave', rel), 'utf8'),
  ) as { response: Record<string, unknown> };
  return parsed.response;
}

/** Freshly created, never connected: every optional field is null. */
const USER_321 = fixtureResponse('3.2.1/user.json');
/** The same user after it connected — the only capture with real consumption. */
const USER_321_CONNECTED = fixtureResponse('3.2.1/connected-user.json');

describe('mapUserSummary on Remnawave 3.2.1', () => {
  it('stands for a 3.x row that has NO `uuid` field at all', () => {
    assertMatchesCapturedRecord(USER_321, USER_321_CAPTURED_KEYS, 'user/3.2.1');
    assertMatchesCapturedRecord(
      USER_321_CONNECTED,
      USER_321_CAPTURED_KEYS,
      'user/3.2.1 (connected)',
    );

    // The headline difference, asserted directly so it cannot creep back in
    // via a fixture "helpfully" padded with the field 2.x used to send.
    assert.equal(Object.prototype.hasOwnProperty.call(USER_321, 'uuid'), false);
    assert.equal((USER_321_CAPTURED_KEYS as readonly string[]).includes('uuid'), false);
    // The live 3.2.1 row and the 3.3.2 / 3.4.3 spec describe the same record.
    assert.deepStrictEqual([...USER_321_CAPTURED_KEYS].sort(), [...USER_REQUIRED].sort());

    // What replaced it: a panel-local integer plus the two public handles.
    assert.equal(typeof USER_321['id'], 'number');
    assert.equal(typeof USER_321['shortUuid'], 'string');
    assert.equal(typeof USER_321['vlessUuid'], 'string');
    // `vlessUuid` is the VLESS credential, NOT a replacement row identity —
    // reaching for it because it is the only uuid-shaped field left would put
    // a secret into a React key.
    assert.notEqual(USER_321['vlessUuid'], USER_321['shortUuid']);
  });

  it('agrees with the vendor contract on the whole 3.x user record', () => {
    // Second witness, deliberately from a different source: the contract the
    // captured release ships. Corroboration, not authority — see the section note.
    assert.deepStrictEqual(
      Object.keys(ExtendedUsersSchema.shape).sort(),
      [...USER_321_CAPTURED_KEYS].sort(),
      'the live 3.2.1 capture and the contract panel 3.2.1 ships (3.2.0) no longer describe the same user record',
    );
  });

  it('gives a 3.x row a real identity — the panel\'s numeric id', () => {
    // This was a defect until it was fixed: `mapUserSummary` read `r['uuid']`
    // through a helper that returns '' for anything non-string, and a 3.x row
    // has no `uuid` at all — so EVERY 3.x user mapped to the SAME empty id. In
    // the admin search that is a duplicate-React-key collision and an identifier
    // an operator cannot act on.
    const fresh = mapUserSummary(USER_321);
    const connected = mapUserSummary(USER_321_CONNECTED);

    assert.notEqual(fresh.uuid, '');
    assert.equal(fresh.uuid, String(USER_321['id']));
    // The two fixtures are the SAME user before and after connecting, so they
    // legitimately share an identity — that is the wrong pair to prove the fix
    // with. Two DIFFERENT users are the test that matters: under the old
    // behaviour both came back as '' and collapsed onto one another.
    assert.equal(connected.uuid, String(USER_321_CONNECTED['id']));
    const other = mapUserSummary({ ...USER_321, id: (USER_321['id'] as number) + 1 });
    assert.notEqual(fresh.uuid, other.uuid);

    // The numeric id is also exposed on its own, because it is what every 3.x
    // route addresses by (`/api/users/{userId}`, `/api/hwid/devices/{userId}`).
    assert.equal(fresh.panelId, USER_321['id']);

    assert.equal(fresh.shortUuid, 'PyTr7C5568QuLhup');
  });

  it('reads no uuid — a row that still carries one is keyed by its id', () => {
    // A 2.x row keyed by its uuid; no supported panel sends one. Its id is the
    // identity like every other row's, and a row with no usable id has none.
    const mapped = mapUserSummary({ uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', id: 7 });
    assert.equal(mapped.uuid, '7');
    assert.equal(mapped.panelId, 7);
    assert.equal(mapUserSummary({ uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }).uuid, '');
  });

  it('reads 3.x consumption out of the nested `userTraffic` block', () => {
    assertMatchesCapturedRecord(
      USER_321_CONNECTED['userTraffic'] as Record<string, unknown>,
      USER_TRAFFIC_321_CAPTURED_KEYS,
      'user.userTraffic/3.2.1',
    );

    const mapped = mapUserSummary(USER_321_CONNECTED);
    assert.equal(mapped.trafficUsedBytes, 119);

    // Not satisfied by coincidence: 3.x carries NO row-level usage field under
    // any spelling, so a row-level read has nothing to find, and the number
    // above is neither the limit nor a zero.
    for (const spelling of ['usedTrafficBytes', 'trafficUsedBytes', 'usedTraffic']) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(USER_321_CONNECTED, spelling),
        false,
        `3.x must not carry row-level \`${spelling}\``,
      );
    }
    assert.notEqual(mapped.trafficUsedBytes, mapped.trafficLimitBytes);
    assert.notEqual(mapped.trafficUsedBytes, 0);

    // Strip the block and the read must go null, not 0 — an absent capture is
    // not "used nothing".
    const { userTraffic: _omitted, ...withoutTraffic } = USER_321_CONNECTED;
    assert.equal(mapUserSummary(withoutTraffic).trafficUsedBytes, null);
  });

  it('keeps a null `hwidDeviceLimit` null instead of reading it as "no devices allowed"', () => {
    // 3.2.1 creates users with `hwidDeviceLimit: null` by default — this is
    // the panel's own answer for a user created through its own API, not an
    // edge case someone had to construct.
    assert.equal(USER_321['hwidDeviceLimit'], null);
    assert.equal(mapUserSummary(USER_321).hwidDeviceLimit, null);
    assert.notEqual(mapUserSummary(USER_321).hwidDeviceLimit, 0);
  });

  it('maps the rest of the 3.2.1 row', () => {
    assert.deepStrictEqual(mapUserSummary(USER_321_CONNECTED), {
      // 3.x has no uuid field; the identity is the numeric id as a string.
      uuid: '2',
      panelId: 2,
      shortUuid: 'PyTr7C5568QuLhup',
      username: 'labuser1',
      status: 'ACTIVE',
      trafficLimitBytes: 0,
      trafficUsedBytes: 119,
      hwidDeviceLimit: null,
      expireAt: '2026-09-09T12:34:05.228Z',
      telegramId: null,
      email: null,
      tag: null,
      createdAt: '2026-08-10T12:34:05.233Z',
      updatedAt: '2026-08-10T12:36:17.671Z',
      // 3.2.1 serves subscriptions under `/api/sub/…`.
      subscriptionUrl: 'https://panel.example/api/sub/PyTr7C5568QuLhup',
    });
  });
});

// ── HWID device list on 3.2.1 ───────────────────────────────────────────────
//
// `GET /api/hwid/devices/{userId}` → `{ response: { total, devices[] } }`.
//
// PROVENANCE, AND WHY IT IS WEAKER HERE. The envelope is captured: the live
// 3.2.1 lab user owned no devices and the panel answered
// `{"response":{"total":0,"devices":[]}}`. NO DEVICE ROW WAS EVER OBSERVED, so
// the row keys in `test/fixtures/remnawave/3.2.1/devices.json` come from the
// `HwidUserDeviceSchema` of the contract panel 3.2.1 ships (backend-contract
// 3.2.0) instead, and the assertion below pins the
// fixture against that schema rather than against prose. If the fixture and
// the vendor ever disagree, this fails — which is the whole point, because a
// hand-written row is exactly the kind of thing that quietly rots.

describe('Remnawave 3.2.1 HWID device list fixture', () => {
  it('has an envelope of `{ total, devices }` whose total matches the rows', () => {
    const response = fixtureResponse('3.2.1/devices.json');
    assert.deepStrictEqual(Object.keys(response).sort(), ['devices', 'total']);

    const devices = response['devices'] as ReadonlyArray<Record<string, unknown>>;
    assert.ok(Array.isArray(devices));
    // The adapter refuses a list whose `total` disagrees with the row count,
    // so a fixture that disagrees would be rejected before it tested anything.
    assert.equal(response['total'], devices.length);
    assert.equal(new Set(devices.map((d) => d['hwid'])).size, devices.length);
  });

  it('is keyed by a numeric `userId`, never by a `userUuid` string', () => {
    const devices = fixtureResponse('3.2.1/devices.json')[
      'devices'
    ] as ReadonlyArray<Record<string, unknown>>;

    for (const device of devices) {
      assertMatchesCapturedRecord(
        device,
        Object.keys(HwidUserDeviceSchema.shape),
        `hwidDevice/3.2.1 ${String(device['hwid'])}`,
      );
      assert.equal(typeof device['userId'], 'number');
      assert.equal(Object.prototype.hasOwnProperty.call(device, 'userUuid'), false);
    }

    // 3.x also added `requestIp`, and the row went nullable on everything the
    // client reports about itself — a device seen before the panel learned any
    // of it is a row of nulls, not an absent row.
    assert.ok(Object.keys(HwidUserDeviceSchema.shape).includes('requestIp'));
    const bare = devices[devices.length - 1]!;
    for (const field of ['platform', 'osVersion', 'deviceModel', 'userAgent', 'requestIp']) {
      assert.equal(bare[field], null, `\`${field}\` must be expressible as null on 3.x`);
    }
  });
});
