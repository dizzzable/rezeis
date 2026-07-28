import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Currency, Prisma, TariffConstructorModuleType } from '@prisma/client';

import { TariffConstructorService } from '../src/modules/tariff-constructor/tariff-constructor.service';

const duration = {
  id: 'duration-1',
  revisionId: 'revision-1',
  days: 30,
  currency: Currency.RUB,
  baseAmount: new Prisma.Decimal('100.25'),
};
const revision = {
  id: 'revision-1',
  constructorId: 'constructor-1',
  basePlanId: 'plan-1',
  version: 3,
  publishedBy: 'admin-1',
  publishedAt: new Date('2026-07-28T00:00:00Z'),
  durations: [duration],
  modules: [
    {
      id: 'traffic-1',
      revisionId: 'revision-1',
      type: TariffConstructorModuleType.TRAFFIC,
      minValue: 10,
      maxValue: 30,
      defaultValue: 20,
      step: 10,
      prices: [
        {
          id: 'p1',
          moduleId: 'traffic-1',
          durationId: duration.id,
          amount: new Prisma.Decimal('20.10'),
        },
      ],
    },
    {
      id: 'devices-1',
      revisionId: 'revision-1',
      type: TariffConstructorModuleType.DEVICES,
      minValue: 1,
      maxValue: 3,
      defaultValue: 1,
      step: 1,
      prices: [
        {
          id: 'p2',
          moduleId: 'devices-1',
          durationId: duration.id,
          amount: new Prisma.Decimal('5.50'),
        },
      ],
    },
  ],
};

function createService(options: { enabled?: boolean; publishedRevisionId?: string | null } = {}) {
  const publishedRevisionId =
    options.publishedRevisionId === undefined ? revision.id : options.publishedRevisionId;
  return new TariffConstructorService({
    tariffConstructor: {
      findUnique: async () =>
        options.enabled === false || publishedRevisionId === null
          ? { isEnabled: options.enabled ?? true, publishedRevisionId }
          : { isEnabled: true, publishedRevisionId: revision.id },
    },
    tariffConstructorRevision: {
      findUnique: async () => ({
        id: revision.id,
        constructorId: revision.constructorId,
        basePlanId: revision.basePlanId,
        version: revision.version,
        publishedBy: revision.publishedBy,
        publishedAt: revision.publishedAt,
      }),
    },
    tariffConstructorRevisionDuration: { findMany: async () => revision.durations },
    tariffConstructorRevisionModule: {
      findMany: async () =>
        revision.modules.map(({ prices: _prices, ...module }) => module),
    },
    tariffConstructorRevisionModulePrice: {
      findMany: async () => revision.modules.flatMap((module) => module.prices),
    },
  } as never);
}

const minimumSelections = [
  { type: TariffConstructorModuleType.TRAFFIC, value: 10 },
  { type: TariffConstructorModuleType.DEVICES, value: 1 },
];

describe('TariffConstructorService', () => {
  it('charges the duration base exactly once at minimum and adds independent module steps', async () => {
    const service = createService();
    const minimum = await service.quote({
      revisionId: revision.id,
      durationDays: 30,
      currency: Currency.RUB,
      selections: minimumSelections,
    });
    const maximum = await service.quote({
      revisionId: revision.id,
      durationDays: 30,
      currency: Currency.RUB,
      selections: [
        { type: TariffConstructorModuleType.TRAFFIC, value: 30 },
        { type: TariffConstructorModuleType.DEVICES, value: 3 },
      ],
    });

    assert.equal(minimum.total, '100.25');
    assert.equal(maximum.total, '151.45');
    assert.deepEqual(maximum.lines.map((line) => line.amount), ['100.25', '40.2', '11']);
  });

  it('rejects a value that is not aligned to the configured step', async () => {
    await assert.rejects(
      createService().quote({
        revisionId: revision.id,
        durationDays: 30,
        currency: Currency.RUB,
        selections: [
          { type: TariffConstructorModuleType.TRAFFIC, value: 15 },
          { type: TariffConstructorModuleType.DEVICES, value: 1 },
        ],
      }),
      { name: 'BadRequestException', message: 'TARIFF_CONSTRUCTOR_TRAFFIC_OUT_OF_RANGE' },
    );
  });

  it('rejects missing, unknown, and duplicate selections', async () => {
    const base = { revisionId: revision.id, durationDays: 30, currency: Currency.RUB };
    await assert.rejects(createService().quote({ ...base, selections: minimumSelections.slice(0, 1) }), {
      message: 'TARIFF_CONSTRUCTOR_MISSING_OR_UNKNOWN_SELECTION',
    });
    await assert.rejects(
      createService().quote({
        ...base,
        selections: [
          ...minimumSelections,
          { type: 'UNKNOWN' as TariffConstructorModuleType, value: 1 },
        ],
      }),
      { message: 'TARIFF_CONSTRUCTOR_MISSING_OR_UNKNOWN_SELECTION' },
    );
    await assert.rejects(
      createService().quote({ ...base, selections: [minimumSelections[0], minimumSelections[0]] }),
      { message: 'TARIFF_CONSTRUCTOR_DUPLICATE_SELECTION' },
    );
  });

  it('does not expose disabled or unpublished configuration', async () => {
    await assert.rejects(createService({ enabled: false }).manifest(), { name: 'NotFoundException' });
    await assert.rejects(createService({ publishedRevisionId: null }).manifest(), {
      name: 'NotFoundException',
    });
  });

  it('rejects stale revision quotes', async () => {
    await assert.rejects(
      createService().quote({
        revisionId: 'old-revision',
        durationDays: 30,
        currency: Currency.RUB,
        selections: minimumSelections,
      }),
      { name: 'ConflictException', message: 'TARIFF_CONSTRUCTOR_REVISION_MISMATCH' },
    );
  });

  it('returns a versioned user-safe manifest with defaults and decimal strings', async () => {
    const manifest = await createService().manifest();
    assert.deepEqual(Object.keys(manifest), [
      'contractVersion',
      'revisionId',
      'revision',
      'durations',
      'modules',
    ]);
    assert.equal(manifest.contractVersion, 1);
    assert.equal(manifest.durations[0].baseAmount, '100.25');
    assert.equal(manifest.modules[0].defaultValue, 20);
    assert.equal(manifest.modules[0].prices[0].perStepAmount, '20.1');
    assert.equal('basePlanId' in manifest, false);
    assert.equal('publishedBy' in manifest, false);
  });
});
