/**
 * Contract tests for the "extended" Remnawave mappers.
 *
 * WHY THESE FIXTURES LOOK THE WAY THEY DO. The defects these tests pin down
 * survived because the mocks that existed agreed with the CODE instead of with
 * the PANEL: a mapper read `provider.monthlyCost`, a mock supplied
 * `monthlyCost`, the assertion passed, and the operator still saw a blank
 * column because Remnawave has never sent that field.
 *
 * So every fixture below is pinned to the OpenAPI record it stands for. Each
 * one is accompanied by the `required` array quoted verbatim from
 * `Remnawave API v274.json` / `Remnawave API v280.json`, and a guard asserts
 * the fixture's own key set is EXACTLY that array — no more, no less. Padding
 * a fixture with a field the panel does not send now fails loudly instead of
 * quietly vouching for a mapper that reads it.
 *
 * Scope is 2.7.4 and 2.8.0. Nothing here is 3.x.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  mapInfraProvider,
  mapNodePlugin,
  mapSnippet,
  mapSubpageConfig,
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

// ── Infra providers ─────────────────────────────────────────────────────────
//
// `GET /api/infra-billing/providers` → `response.providers[]`, whose
// `required` is identical on both builds:
//   ["uuid","name","faviconLink","loginUrl","createdAt","updatedAt",
//    "billingHistory","billingNodes"]

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

/** 2.7.4: `billingNodes[]` required is `["nodeUuid","name","countryCode"]`. */
const PROVIDER_274 = {
  uuid: '0e0f0f4a-9f5a-4b1a-9a30-6f9c2f4f7a11',
  name: 'Hetzner',
  faviconLink: 'https://hetzner.com/favicon.ico',
  loginUrl: 'https://accounts.hetzner.com/login',
  createdAt: '2026-01-04T10:00:00.000Z',
  updatedAt: '2026-05-19T08:22:31.000Z',
  billingHistory: { totalAmount: 428.5, totalBills: 7 },
  billingNodes: [
    { nodeUuid: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'de-fsn-1', countryCode: 'DE' },
    { nodeUuid: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'fi-hel-1', countryCode: 'FI' },
  ],
};

/** 2.8.0: `billingNodes[]` required is `["name","details"]`, `details` nullable. */
const PROVIDER_280 = {
  uuid: '0e0f0f4a-9f5a-4b1a-9a30-6f9c2f4f7a11',
  name: 'Hetzner',
  faviconLink: null,
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
  it('reads the 2.7.4 provider record the panel actually sends', () => {
    assertMatchesSpecRecord(PROVIDER_274, PROVIDER_REQUIRED, 'provider/2.7.4');

    assert.deepStrictEqual(mapInfraProvider(PROVIDER_274), {
      uuid: '0e0f0f4a-9f5a-4b1a-9a30-6f9c2f4f7a11',
      name: 'Hetzner',
      faviconLink: 'https://hetzner.com/favicon.ico',
      loginUrl: 'https://accounts.hetzner.com/login',
      billedTotalAmount: 428.5,
      billsCount: 7,
      billingNodes: [
        { nodeUuid: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'de-fsn-1', countryCode: 'DE' },
        { nodeUuid: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'fi-hel-1', countryCode: 'FI' },
      ],
      createdAt: '2026-01-04T10:00:00.000Z',
      updatedAt: '2026-05-19T08:22:31.000Z',
    });
  });

  it('reads 2.8.0 billing nodes through their nested `details` block', () => {
    assertMatchesSpecRecord(PROVIDER_280, PROVIDER_REQUIRED, 'provider/2.8.0');

    const mapped = mapInfraProvider(PROVIDER_280);

    // The count is what the Costs tab renders; a `details`-less orphan must
    // still be counted, or the operator reconciles against a short number.
    assert.equal(mapped.billingNodes.length, 2);
    assert.deepStrictEqual(mapped.billingNodes[0], {
      nodeUuid: 'aaaaaaaa-0000-4000-8000-000000000001',
      name: 'de-fsn-1',
      countryCode: 'DE',
    });
    assert.deepStrictEqual(mapped.billingNodes[1], {
      nodeUuid: null,
      name: 'retired-node',
      countryCode: null,
    });
  });

  it('carries a cost figure on both builds — the tab is no longer costless', () => {
    for (const [label, record] of [
      ['2.7.4', PROVIDER_274],
      ['2.8.0', PROVIDER_280],
    ] as const) {
      const mapped = mapInfraProvider(record);
      assert.equal(mapped.billedTotalAmount, 428.5, `${label}: billed total`);
      assert.equal(mapped.billsCount, 7, `${label}: bill count`);
      assert.equal(mapped.billingNodes.length, 2, `${label}: billed nodes`);
    }
  });

  it('exposes no field the panel does not send', () => {
    // `type`, `currency`, `monthlyCost` and `nodesCount` were read here and
    // appear in NEITHER spec. Re-adding one would put a permanent `—`/`0` back
    // on the Costs tab, so the exact surface is pinned.
    assert.deepStrictEqual(Object.keys(mapInfraProvider(PROVIDER_274)).sort(), [
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
// `GET /api/node-plugins` → `response.nodePlugins[]`, `required` identical on
// both builds: ["uuid","viewPosition","name","pluginConfig"]

const NODE_PLUGIN_REQUIRED = ['uuid', 'viewPosition', 'name', 'pluginConfig'] as const;

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
  it('reads the record both builds send', () => {
    assertMatchesSpecRecord(NODE_PLUGIN_CONFIGURED, NODE_PLUGIN_REQUIRED, 'nodePlugin');

    assert.deepStrictEqual(mapNodePlugin(NODE_PLUGIN_CONFIGURED), {
      uuid: 'bbbbbbbb-0000-4000-8000-000000000001',
      name: 'torrent-blocker',
      viewPosition: 1,
      hasConfig: true,
    });
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
// `GET /api/snippets` → `response.snippets[]`, `required` identical on both
// builds: ["name","snippet"]. The write DTO types `snippet` as
// `{"type":"array","items":{"type":"object"}}`.

const SNIPPET_REQUIRED = ['name', 'snippet'] as const;

const SNIPPET_A = { name: 'happ-routing', snippet: [{ tag: 'direct' }, { tag: 'proxy' }] };
const SNIPPET_B = { name: 'happ-announce', snippet: [] };

describe('mapSnippet', () => {
  it('reads the two-field record both builds send', () => {
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
// `GET /api/subscription-page-configs` → `response.configs[]`, `required`
// identical on both builds: ["uuid","viewPosition","name","config"]

const SUBPAGE_REQUIRED = ['uuid', 'viewPosition', 'name', 'config'] as const;

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
  it('reads the record both builds send', () => {
    assertMatchesSpecRecord(SUBPAGE_CONFIGURED, SUBPAGE_REQUIRED, 'subpageConfig');

    assert.deepStrictEqual(mapSubpageConfig(SUBPAGE_CONFIGURED), {
      uuid: 'cccccccc-0000-4000-8000-000000000001',
      name: 'default-page',
      viewPosition: 1,
      hasConfig: true,
    });
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

// ── User summary ────────────────────────────────────────────────────────────
//
// `GET /api/users/by-{short-uuid,username,email,telegram-id}/…`, whose
// `response.required` is identical on both builds:
//   ["uuid","id","shortUuid","username","expireAt","telegramId","email",
//    "description","tag","hwidDeviceLimit","externalSquadUuid",
//    "trojanPassword","vlessUuid","ssPassword","subRevokedAt",
//    "lastTrafficResetAt","createdAt","updatedAt","subscriptionUrl",
//    "activeInternalSquads","userTraffic"]
//
// `status` and `trafficLimitBytes` are declared but NOT required, so they are
// carried here as the optional extras they are.

const USER_REQUIRED = [
  'uuid',
  'id',
  'shortUuid',
  'username',
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
  'subRevokedAt',
  'lastTrafficResetAt',
  'createdAt',
  'updatedAt',
  'subscriptionUrl',
  'activeInternalSquads',
  'userTraffic',
  // declared, optional
  'status',
  'trafficLimitBytes',
] as const;

const USER_RECORD = {
  uuid: 'dddddddd-0000-4000-8000-000000000001',
  id: 4211,
  shortUuid: 'aB3xY9zQ',
  username: 'durov',
  status: 'ACTIVE',
  trafficLimitBytes: 107374182400,
  expireAt: '2026-09-01T00:00:00.000Z',
  // `{"type": ["integer","null"]}` on 2.7.4, `{"type":"integer","nullable":true}`
  // on 2.8.0 — a NUMBER on both.
  telegramId: 123456789,
  email: 'durov@example.com',
  description: null,
  tag: 'VIP',
  hwidDeviceLimit: 5,
  externalSquadUuid: null,
  trojanPassword: 'tp',
  vlessUuid: 'eeeeeeee-0000-4000-8000-000000000001',
  ssPassword: 'ss',
  subRevokedAt: null,
  lastTrafficResetAt: null,
  createdAt: '2025-11-07T08:13:47.071Z',
  updatedAt: '2026-06-01T12:00:00.000Z',
  subscriptionUrl: 'https://sub.example.com/aB3xY9zQ',
  activeInternalSquads: [{ uuid: 'ffffffff-0000-4000-8000-000000000001', name: 'Default-Squad' }],
  // Consumption lives HERE on both builds; there is no row-level
  // `trafficUsedBytes` on any of the four user lookups.
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
    // `{"type": ["integer","null"]}` / `{"type":"integer","nullable":true}` —
    // a string-only read discarded every id that existed.
    assert.equal(mapUserSummary(USER_RECORD).telegramId, '123456789');
    assert.equal(mapUserSummary({ ...USER_RECORD, telegramId: null }).telegramId, null);
    // A transport that already stringified it must survive untouched.
    assert.equal(mapUserSummary({ ...USER_RECORD, telegramId: '987654321' }).telegramId, '987654321');
    // A value that has already lost precision is refused, not printed.
    assert.equal(mapUserSummary({ ...USER_RECORD, telegramId: 1.5 }).telegramId, null);
  });

  it('maps the rest of the record the panel really sends', () => {
    assert.deepStrictEqual(mapUserSummary(USER_RECORD), {
      id: 4211,
      uuid: 'dddddddd-0000-4000-8000-000000000001',
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
