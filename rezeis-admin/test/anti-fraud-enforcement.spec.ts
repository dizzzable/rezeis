import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FraudSignalSeverity, FraudSignalStatus } from '@prisma/client';

import { AntiFraudService } from '../src/modules/anti-fraud/services/anti-fraud.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { SystemEventsService } from '../src/common/services/system-events.service';
import { FraudDetectors } from '../src/modules/anti-fraud/detectors/fraud-detectors';
import { RemnawaveDetectors } from '../src/modules/anti-fraud/detectors/remnawave-detectors';
import { SharingDetectors } from '../src/modules/anti-fraud/detectors/sharing-detectors';
import { SubscriptionUaDetectors } from '../src/modules/anti-fraud/detectors/subscription-ua-detectors';
import type { PanelDevicesOutcome } from '../src/modules/remnawave/services/panel-devices.client';
import { panelDevicesDouble, panelRejected } from './fixtures/anti-fraud-panel-clients';

interface SignalSeed {
  readonly id?: string;
  readonly code?: string;
  readonly metadata?: Record<string, unknown>;
  readonly affectedUserIds?: string[];
  /** Rows `subscription.findMany` answers with, for the identity fallbacks. */
  readonly subscriptions?: ReadonlyArray<{
    remnawaveId?: string | null;
    remnawavePanelId?: number | null;
  }>;
  readonly dropOutcome?: PanelDevicesOutcome<unknown>;
}

function build(seed: SignalSeed | null) {
  const auditCreates: unknown[] = [];
  const events: unknown[] = [];

  const prisma = {
    fraudSignal: {
      findUnique: () =>
        Promise.resolve(
          seed === null
            ? null
            : {
                id: seed.id ?? 'sig-1',
                code: seed.code ?? 'SUBSCRIPTION_SHARING_IP',
                severity: FraudSignalSeverity.HIGH,
                status: FraudSignalStatus.OPEN,
                metadata: seed.metadata ?? {},
                affectedUserIds: seed.affectedUserIds ?? [],
              },
        ),
    },
    subscription: {
      findMany: () => Promise.resolve([...(seed?.subscriptions ?? [])]),
    },
    adminAuditLog: {
      create: (args: unknown) => {
        auditCreates.push(args);
        return Promise.resolve({});
      },
    },
  } as unknown as PrismaService;

  const devices = panelDevicesDouble({ dropOutcome: seed?.dropOutcome });

  const sysEvents = {
    warn: (...args: unknown[]) => {
      events.push(args);
    },
  } as unknown as SystemEventsService;

  const service = new AntiFraudService(
    prisma,
    {} as unknown as FraudDetectors,
    {} as unknown as RemnawaveDetectors,
    {} as unknown as SharingDetectors,
    {} as unknown as SubscriptionUaDetectors,
    devices.client,
    sysEvents,
  );

  return { service, auditCreates, dropCalls: devices.dropBodies, events };
}

const META = { requestId: 'r1', remoteAddress: '10.0.0.1', userAgent: 'jest' };

describe('AntiFraudService.enforceDropConnections', () => {
  it('drops by the panel user id from metadata and writes audit + event', async () => {
    // 3.x spells the discriminator's user arm `userIds: number[]`. The 2.x
    // spelling was `userUuids: string[]`, and a request in the old shape is a
    // guaranteed 400 the sync layer files as terminal.
    const { service, auditCreates, dropCalls, events } = build({
      code: 'SUBSCRIPTION_SHARING_HWID',
      metadata: { remnawaveUuid: '4471' },
    });
    const res = await service.enforceDropConnections({
      signalId: 'sig-1',
      mode: 'user',
      adminId: 'admin-1',
      requestMetadata: META,
    });
    assert.equal(res.ok, true);
    assert.equal(res.dropped.count, 1);
    assert.deepEqual(dropCalls, [
      {
        dropBy: { by: 'userIds', userIds: [4471] },
        targetNodes: { target: 'allNodes' },
      },
    ]);
    assert.equal(auditCreates.length, 1);
    assert.equal(events.length, 1);
  });

  it('never turns a 2.x-era uuid into the id its leading digits spell', async () => {
    // `Number.parseInt('330f2b38-1362-…', 10)` is `330` — a valid-looking id
    // belonging to a different customer, whose live connections this call would
    // then drop. The uuid is resolved through the subscription row that records
    // the numeric id, or it is not resolved at all.
    const { service, dropCalls } = build({
      code: 'SUBSCRIPTION_SHARING_HWID',
      metadata: { remnawaveUuid: '330f2b38-1362-46ab-b5c0-dea32167eff9' },
      subscriptions: [{ remnawaveId: '330f2b38-1362-46ab-b5c0-dea32167eff9', remnawavePanelId: 91 }],
    });

    await service.enforceDropConnections({
      signalId: 'sig-1',
      mode: 'user',
      adminId: 'admin-1',
      requestMetadata: META,
    });

    assert.deepEqual(dropCalls, [
      { dropBy: { by: 'userIds', userIds: [91] }, targetNodes: { target: 'allNodes' } },
    ]);
  });

  it('refuses rather than guessing when a 2.x uuid maps to no recorded id', async () => {
    const { service, dropCalls } = build({
      code: 'SUBSCRIPTION_SHARING_HWID',
      metadata: { remnawaveUuid: '330f2b38-1362-46ab-b5c0-dea32167eff9' },
      subscriptions: [],
    });

    await assert.rejects(
      service.enforceDropConnections({
        signalId: 'sig-1',
        mode: 'user',
        adminId: 'admin-1',
        requestMetadata: META,
      }),
    );
    assert.deepEqual(dropCalls, [], 'nothing may be dropped on a guessed identity');
  });

  it('surfaces a refused drop to the operator instead of reporting success', async () => {
    // The operator pressed a button. `invalid-request` in particular is rezeis
    // building the request wrong and catching it before it was sent — reporting
    // that as a completed drop would tell them connections went away that did
    // not.
    const { service } = build({
      code: 'SUBSCRIPTION_SHARING_HWID',
      metadata: { remnawaveUuid: '4471' },
      dropOutcome: panelRejected(403, 'A019'),
    });

    await assert.rejects(
      service.enforceDropConnections({
        signalId: 'sig-1',
        mode: 'user',
        adminId: 'admin-1',
        requestMetadata: META,
      }),
      /403/,
    );
  });

  it('drops by IP addresses when mode is ip', async () => {
    const { service, dropCalls } = build({
      code: 'SUBSCRIPTION_SHARING_IP',
      metadata: { ips: [{ ip: '1.1.1.1' }, { ip: '2.2.2.2' }, { ip: '1.1.1.1' }] },
    });
    const res = await service.enforceDropConnections({
      signalId: 'sig-1',
      mode: 'ip',
      adminId: 'admin-1',
      requestMetadata: META,
    });
    assert.equal(res.dropped.count, 2); // deduped
    assert.deepEqual(dropCalls, [
      {
        dropBy: { by: 'ipAddresses', ipAddresses: ['1.1.1.1', '2.2.2.2'] },
        targetNodes: { target: 'allNodes' },
      },
    ]);
  });

  it('throws when the signal does not exist', async () => {
    const { service } = build(null);
    await assert.rejects(
      service.enforceDropConnections({
        signalId: 'missing',
        mode: 'user',
        adminId: 'admin-1',
        requestMetadata: META,
      }),
    );
  });

  it('throws when there are no resolvable users to drop', async () => {
    const { service } = build({ code: 'SUBSCRIPTION_SHARING_HWID', metadata: {} });
    await assert.rejects(
      service.enforceDropConnections({
        signalId: 'sig-1',
        mode: 'user',
        adminId: 'admin-1',
        requestMetadata: META,
      }),
    );
  });
});
