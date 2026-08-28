import 'reflect-metadata';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AdminUserSubscriptionsController } from '../src/modules/users/controllers/admin-user-subscriptions.controller';

/**
 * Who reset this customer's traffic, and who unbound their device.
 *
 * ── The gap, and how it appeared ─────────────────────────────────────────
 *
 * Three single-subscription actions that reach the VPN panel — reset traffic,
 * re-sync, unbind one device — wrote no operator row. Their BULK counterparts
 * do, so the same act performed on one customer was untraceable and performed
 * on a thousand was traceable, which is exactly backwards from how the question
 * gets asked: "who reset MY traffic" is about one person.
 *
 * ── Why the ordering is asserted ─────────────────────────────────────────
 *
 * Every row here is written AFTER the panel call returns. A row written first
 * would answer "who reset this" about a reset that threw — an audit log that
 * records intentions rather than events is worse than none, because it is
 * believed.
 */

const ADMIN = { id: 'admin-1' } as never;
const REQ = { headers: {}, socket: {} } as never;

const ROW = {
  remnawaveId: '4711',
  remnawavePanelId: 4711,
  remnawavePanelUsername: 'rz_one',
  configUrl: 'https://sub/1',
  userId: 'user-1',
  user: null,
};

function buildController(options: { readonly panelThrows?: boolean } = {}) {
  const audits: Array<Record<string, unknown>> = [];
  const order: string[] = [];

  const prisma = {
    subscription: {
      findUnique: async () => ROW,
      update: async () => ({}),
    },
    adminAuditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        order.push('audit');
        audits.push(args.data);
        return args.data;
      },
    },
  };

  const panel = {
    resetPanelUserTraffic: async () => {
      order.push('panel');
      if (options.panelThrows === true) throw new Error('panel refused');
    },
    getPanelShape: async () => ({ addressing: 'id', connectionsApi: 'connections' }),
    deletePanelUserDevice: async () => {
      order.push('panel');
      if (options.panelThrows === true) throw new Error('panel refused');
      return { total: 2 };
    },
  };

  const controller = new AdminUserSubscriptionsController(
    prisma as never,
    panel as never,
    {} as never,
    { info: () => undefined } as never,
    {} as never,
    {} as never,
  );
  return { controller, audits, order };
}

describe('resetting one subscription’s traffic', () => {
  it('records who did it, under the same name the bulk action uses', async () => {
    // One action name for one act, whichever screen performed it — otherwise
    // "who reset this" is two queries and somebody will only run one.
    const { controller, audits } = buildController();
    await controller.resetTraffic('sub-1', ADMIN, REQ);

    assert.equal(audits.length, 1);
    assert.equal(audits[0]['action'], 'user.subscription.traffic_reset');
    assert.equal(
      (audits[0]['metadata'] as { subscriptionId: string }).subscriptionId,
      'sub-1',
    );
  });

  it('writes the row only after the panel has actually done it', async () => {
    const { controller, order } = buildController();
    await controller.resetTraffic('sub-1', ADMIN, REQ);
    assert.deepStrictEqual(order, ['panel', 'audit']);
  });

  it('records nothing when the panel refused', async () => {
    // An audit log that records intentions rather than events is worse than
    // none, because it is believed.
    const { controller, audits } = buildController({ panelThrows: true });
    await assert.rejects(() => controller.resetTraffic('sub-1', ADMIN, REQ));
    assert.deepStrictEqual(audits, []);
  });

  it('records nothing for a subscription with no profile to reset', async () => {
    const { controller, audits } = buildController();
    const prisma = (
      controller as unknown as {
        prismaService: { subscription: { findUnique: () => Promise<unknown> } };
      }
    ).prismaService;
    prisma.subscription.findUnique = async () => ({
      remnawaveId: null,
      remnawavePanelId: null,
      remnawavePanelUsername: null,
      configUrl: null,
    });

    const result = await controller.resetTraffic('sub-1', ADMIN, REQ);
    assert.equal((result as { reset: boolean }).reset, false);
    assert.deepStrictEqual(audits, []);
  });
});

describe('unbinding one device', () => {
  it('records the operator, the subscription and which device', async () => {
    // The hwid is the point: "who unbound my device" is unanswerable without
    // naming which one, and the customer asking has several.
    const { controller, audits } = buildController();
    await controller.revokeDevice('sub-1', 'hwid-x', ADMIN, REQ);

    assert.equal(audits.length, 1);
    assert.equal(audits[0]['action'], 'user.subscription.device_revoked');
    const metadata = audits[0]['metadata'] as { hwid: string; subscriptionId: string };
    assert.equal(metadata.hwid, 'hwid-x');
    assert.equal(metadata.subscriptionId, 'sub-1');
  });

  it('writes the row only after the device is actually gone', async () => {
    const { controller, order } = buildController();
    await controller.revokeDevice('sub-1', 'hwid-x', ADMIN, REQ);
    assert.deepStrictEqual(order, ['panel', 'audit']);
  });
});
