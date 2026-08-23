/**
 * `Subscription.trafficLimit` — one column, one conversion, one rule.
 *
 * The column is a whole number of GIGABYTES; every upstream it is filled from
 * (a Remnawave panel row, a Remnawave webhook, a 3x-ui client record, a
 * STEALTHNET tariff) states the cap in BYTES. Six call sites used to divide
 * those bytes themselves, and they had drifted: the panel importer wrote a bare
 * `Math.round`, the webhook mirror wrote `Math.max(1, Math.round(…))`. A 0.4 GB
 * cap therefore landed as `0` through one and `1` through the other.
 *
 * `0` is not a rounding artefact here — it is a value the column can legally
 * hold and it means ZERO gigabytes (unlimited is `null`). So the importer's
 * spelling did not merely round: it wrote "this customer may move no traffic",
 * and then `profile-sync` pushed that `0` back to the panel where `0` bytes
 * means UNLIMITED. One rounding, two opposite lies.
 *
 * These tests pin the rule and, more importantly, pin that every writer of the
 * column now gives the SAME answer for the same input.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RemnawaveImporterService } from '../src/modules/imports/services/remnawave-importer.service';
import {
  ThreeXuiImporterService,
  type ThreeXuiClient,
} from '../src/modules/imports/services/threexui-importer.service';
import { panelSubscriptionState } from '../src/modules/imports/utils/remnawave-overlay.util';
import { RemnawaveWebhookService } from '../src/modules/remnawave/services/remnawave-webhook.service';
import type { RemnawavePanelUser } from '../src/modules/remnawave/services/remnawave-api.service';
import { panelTrafficLimitToGb } from '../src/modules/remnawave/utils/panel-traffic-limit.util';
import { isNetworkSharingOffender } from '../src/modules/anti-fraud/sharing-detection.util';

const GIB = 1024 ** 3;

/**
 * Distinguishes "the writer wrote `null`" from "the writer never ran".
 *
 * Both importers swallow a failed row and the webhook swallows a failed
 * reconcile, so a stub that is missing a method produces NO write and NO error.
 * Without this marker every `assert.equal(written, null)` below would pass on a
 * code path that never reached the conversion at all.
 */
const NOT_WRITTEN = Symbol('no write reached the column');
type Written = number | null | typeof NOT_WRITTEN;

// ── Writer 1: the Remnawave panel importer ──────────────────────────────────

function panelRow(trafficLimitBytes: number): RemnawavePanelUser {
  return {
    uuid: 'profile-1',
    username: 'customer-1',
    status: 'ACTIVE',
    subscriptionUrl: 'https://panel.example/sub/profile-1',
    telegramId: 4242,
    panelId: 7,
    email: null,
    expireAt: '2030-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastTrafficResetAt: null,
    trafficLimitBytes,
    hwidDeviceLimit: 3,
    trafficLimitStrategy: 'NO_RESET',
    tag: null,
    description: null,
    activeInternalSquads: [],
    externalSquadUuid: null,
  };
}

async function importerWrites(trafficLimitBytes: number): Promise<Written> {
  let written: Written = NOT_WRITTEN;
  const prisma = {
    subscription: {
      findFirst: async () => ({ id: 'sub-1', userId: 'user-1', planSnapshot: {} }),
      update: async (args: { readonly data: Record<string, unknown> }) => {
        written = args.data['trafficLimit'] as number | null;
        return {};
      },
    },
  };
  const importer = new RemnawaveImporterService(prisma as never, {} as never);
  const outcome = await (
    importer as unknown as {
      syncSubscription(
        userId: string,
        panelUser: RemnawavePanelUser,
        importRecordId: string | null,
      ): Promise<string>;
    }
  ).syncSubscription('user-1', panelRow(trafficLimitBytes), null);
  assert.equal(outcome, 'updated', 'the fixture must reach the writing branch');
  return written;
}

// ── Writer 2: the Remnawave webhook mirror ──────────────────────────────────

async function webhookWrites(trafficLimitBytes: number): Promise<Written> {
  let written: Written = NOT_WRITTEN;
  const prisma = {
    remnawaveWebhookEvent: { create: async () => undefined },
    subscription: {
      updateMany: async (args: { readonly data: Record<string, unknown> }) => {
        written = args.data['trafficLimit'] as number | null;
        return { count: 1 };
      },
      findMany: async () => [{ id: 'sub-1', planSnapshot: {} }],
      update: async () => ({}),
    },
  };
  const service = new RemnawaveWebhookService(
    prisma as never,
    { webhookSecret: null } as never,
    { emit: () => undefined } as never,
    { getPanelUserUsage: async () => null } as never,
  );
  await service.handleEvent(
    'user.modified',
    { data: { uuid: 'profile-1', trafficLimitBytes } },
    null,
  );
  return written;
}

// ── Writer 3: the 3x-ui importer ────────────────────────────────────────────

function threeXuiRow(totalGb: number): ThreeXuiClient {
  return {
    email: 'customer-1',
    uuid: 'client-uuid-1',
    password: null,
    subId: 'sub-token-1',
    tgId: 4242,
    // 3x-ui's own name for a BYTE count — see the interface it comes from.
    totalGb,
    limitIp: 3,
    expiryTime: 0,
    enable: true,
    comment: null,
    reset: 0,
    up: 0,
    down: 0,
    inboundRemark: 'inbound-1',
    inboundProtocol: 'vless',
    subscriptionUrl: 'https://3xui.example/sub/sub-token-1',
  };
}

async function threeXuiWrites(totalGb: number): Promise<Written> {
  let written: Written = NOT_WRITTEN;
  const prisma = {
    subscription: {
      findFirst: async () => ({ id: 'sub-1' }),
      update: async (args: { readonly data: Record<string, unknown> }) => {
        written = args.data['trafficLimit'] as number | null;
        return {};
      },
    },
  };
  const importer = new ThreeXuiImporterService(prisma as never);
  const outcome = await (
    importer as unknown as {
      syncSubscription(
        userId: string,
        client: ThreeXuiClient,
        importRecordId: string | null,
      ): Promise<string>;
    }
  ).syncSubscription('user-1', threeXuiRow(totalGb), null);
  assert.equal(outcome, 'updated', 'the fixture must reach the writing branch');
  return written;
}

// ── Writer 4: the backup-import overlay (altshop / remnashop / STEALTHNET) ──

function overlayWrites(trafficLimitBytes: number): Written {
  return panelSubscriptionState(panelRow(trafficLimitBytes)).trafficLimit;
}

describe('panelTrafficLimitToGb — the one rule every writer of the column shares', () => {
  it('floors a positive sub-gigabyte cap at 1 GB instead of rounding it away', () => {
    // The whole defect in one line: 0.4 GB is a real, paid-for cap. Rounding it
    // to `0` does not mean "unlimited" in this column — it means no traffic.
    assert.equal(panelTrafficLimitToGb(0.4 * GIB), 1);
    // Even a single byte is a cap, and a cap is never zero gigabytes.
    assert.equal(panelTrafficLimitToGb(1), 1);
    assert.equal(panelTrafficLimitToGb(0.5 * GIB - 1), 1);
  });

  it('reads a panel zero as unlimited, never as zero gigabytes', () => {
    assert.equal(panelTrafficLimitToGb(0), null);
    assert.equal(panelTrafficLimitToGb(-1), null);
    assert.equal(panelTrafficLimitToGb(-5 * GIB), null);
  });

  it('rounds an ordinary cap to the nearest whole gigabyte', () => {
    assert.equal(panelTrafficLimitToGb(50 * GIB), 50);
    assert.equal(panelTrafficLimitToGb(1.6 * GIB), 2);
    assert.equal(panelTrafficLimitToGb(2.4 * GIB), 2);
  });

  it('answers null for a value it cannot read, so NaN can never reach the column', () => {
    assert.equal(panelTrafficLimitToGb(null), null);
    assert.equal(panelTrafficLimitToGb(undefined), null);
    assert.equal(panelTrafficLimitToGb(Number.NaN), null);
    assert.equal(panelTrafficLimitToGb(Number.POSITIVE_INFINITY), null);
  });
});

describe('every writer of Subscription.trafficLimit agrees on the same input', () => {
  /**
   * The inputs that separated the two spellings. `0.4 GB` is the one that used
   * to answer `0` through the importer and `1` through the webhook; `0` is the
   * one that must stay unlimited through both.
   */
  const CASES: ReadonlyArray<{ readonly label: string; readonly bytes: number }> = [
    { label: '0.4 GB — the sub-gigabyte cap that used to collapse to zero', bytes: 0.4 * GIB },
    { label: '1 byte — the smallest possible positive cap', bytes: 1 },
    { label: '0 bytes — the panel spelling of unlimited', bytes: 0 },
    { label: '1.6 GB — rounds up', bytes: 1.6 * GIB },
    { label: '50 GB — an ordinary plan cap', bytes: 50 * GIB },
  ];

  for (const { label, bytes } of CASES) {
    it(`the panel importer and the webhook mirror write the same GB for ${label}`, async () => {
      const expected = panelTrafficLimitToGb(bytes);
      const fromImporter = await importerWrites(bytes);
      const fromWebhook = await webhookWrites(bytes);

      assert.notEqual(fromImporter, NOT_WRITTEN, 'the importer never reached the column');
      assert.notEqual(fromWebhook, NOT_WRITTEN, 'the webhook mirror never reached the column');
      assert.equal(
        fromImporter,
        fromWebhook,
        `importer wrote ${String(fromImporter)} but the webhook wrote ${String(fromWebhook)}`,
      );
      assert.equal(fromImporter, expected);
    });
  }

  it('the 3x-ui importer and the backup-import overlay answer the same as the other two', async () => {
    for (const { bytes } of CASES) {
      const expected = panelTrafficLimitToGb(bytes);
      const fromThreeXui = await threeXuiWrites(bytes);
      assert.notEqual(fromThreeXui, NOT_WRITTEN, 'the 3x-ui importer never reached the column');
      assert.equal(fromThreeXui, expected, `3x-ui disagreed on ${bytes} bytes`);
      assert.equal(overlayWrites(bytes), expected, `the backup overlay disagreed on ${bytes} bytes`);
    }
  });

  it('a 0.4 GB panel cap never leaves a paying customer with zero traffic', async () => {
    // Stated separately from the agreement table because agreeing on the WRONG
    // answer would satisfy that table. This is the product rule itself.
    for (const written of [
      await importerWrites(0.4 * GIB),
      await webhookWrites(0.4 * GIB),
      await threeXuiWrites(0.4 * GIB),
      overlayWrites(0.4 * GIB),
    ]) {
      assert.notEqual(written, NOT_WRITTEN, 'a writer never reached the column');
      assert.notEqual(written, 0, 'a positive panel cap must never be written as zero gigabytes');
      assert.equal(written, 1);
    }
  });

  it('a panel cap of 0 bytes stays unlimited (null) through every writer', async () => {
    for (const written of [
      await importerWrites(0),
      await webhookWrites(0),
      await threeXuiWrites(0),
      overlayWrites(0),
    ]) {
      assert.notEqual(written, NOT_WRITTEN, 'a writer never reached the column');
      assert.equal(written, null, 'a panel zero is unlimited, not a cap of zero gigabytes');
      assert.notEqual(written, 0, 'unlimited must not be flattened into a zero-gigabyte cap');
    }
  });
});

describe('devices do NOT share the traffic encoding', () => {
  it('zero devices still means unlimited, so an unlimited subscription is never a sharing offender', () => {
    // `deviceLimit <= 0` is the product's canonical unlimited AND the panel's
    // (`hwidDeviceLimit: 0`). Making devices read like traffic — where `0` is a
    // real cap of zero — would turn every unlimited-device customer into a
    // permanent sharing offender the moment they connect a second network.
    assert.equal(isNetworkSharingOffender(50, 0, 1), false);
    assert.equal(isNetworkSharingOffender(2, 0, 0), false);
    assert.equal(isNetworkSharingOffender(1, 0, 0), false);
    // A negative limit is the same unlimited, spelled by an older row.
    assert.equal(isNetworkSharingOffender(50, -1, 1), false);
    // And a genuine finite limit still detects, so the guard above is not
    // simply switching the detector off.
    assert.equal(isNetworkSharingOffender(5, 2, 1), true);
  });

  it('the two columns answer differently for the same digit', () => {
    // The asymmetry in one assertion, for the reader who assumed they match:
    // an upstream `0` traffic cap is UNLIMITED and is stored as `null`, while a
    // `0` device limit is UNLIMITED and is stored as `0`. Same meaning, two
    // encodings — which is exactly why `trafficLimit: 0` is free to mean zero.
    assert.equal(panelTrafficLimitToGb(0), null);
    assert.equal(isNetworkSharingOffender(99, 0, 0), false);
  });
});
