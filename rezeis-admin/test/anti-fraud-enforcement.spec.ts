import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FraudSignalSeverity, FraudSignalStatus } from '@prisma/client';

import { AntiFraudService } from '../src/modules/anti-fraud/services/anti-fraud.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { SystemEventsService } from '../src/common/services/system-events.service';
import { FraudDetectors } from '../src/modules/anti-fraud/detectors/fraud-detectors';
import { RemnawaveDetectors } from '../src/modules/anti-fraud/detectors/remnawave-detectors';
import { SharingDetectors } from '../src/modules/anti-fraud/detectors/sharing-detectors';
import { RemnawaveApiService } from '../src/modules/remnawave/services/remnawave-api.service';

interface SignalSeed {
  readonly id?: string;
  readonly code?: string;
  readonly metadata?: Record<string, unknown>;
  readonly affectedUserIds?: string[];
}

function build(seed: SignalSeed | null) {
  const auditCreates: unknown[] = [];
  const dropCalls: unknown[] = [];
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
      findMany: () => Promise.resolve([] as Array<{ remnawaveId: string | null }>),
    },
    adminAuditLog: {
      create: (args: unknown) => {
        auditCreates.push(args);
        return Promise.resolve({});
      },
    },
  } as unknown as PrismaService;

  const remna = {
    dropConnections: (input: unknown) => {
      dropCalls.push(input);
      return Promise.resolve({ ok: true });
    },
  } as unknown as RemnawaveApiService;

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
    remna,
    sysEvents,
  );

  return { service, auditCreates, dropCalls, events };
}

const META = { requestId: 'r1', remoteAddress: '10.0.0.1', userAgent: 'jest' };

describe('AntiFraudService.enforceDropConnections', () => {
  it('drops by user UUID from metadata and writes audit + event', async () => {
    const { service, auditCreates, dropCalls, events } = build({
      code: 'SUBSCRIPTION_SHARING_HWID',
      metadata: { remnawaveUuid: 'uuid-1' },
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
        dropBy: { by: 'userUuids', userUuids: ['uuid-1'] },
        targetNodes: { target: 'allNodes' },
      },
    ]);
    assert.equal(auditCreates.length, 1);
    assert.equal(events.length, 1);
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
