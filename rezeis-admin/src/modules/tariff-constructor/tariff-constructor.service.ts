import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Currency, Prisma, TariffConstructorModuleType } from '@prisma/client';

import { PrismaService } from '../../common/prisma/prisma.service';
import { buildAdminAuditLogData } from '../../common/utils/admin-audit-log.util';
import { CurrentAdminInterface } from '../auth/interfaces/current-admin.interface';
import { RequestMetadataInterface } from '../auth/interfaces/request-metadata.interface';
import {
  QuoteTariffConstructorDto,
  SaveTariffConstructorDraftDto,
} from './dto/tariff-constructor.dto';

const CONTRACT_VERSION = 1;
const SINGLETON_KEY = 'default';

type Draft = Prisma.TariffConstructorGetPayload<object> & {
  readonly durations: Prisma.TariffConstructorDurationGetPayload<object>[];
  readonly modules: Array<
    Prisma.TariffConstructorModuleGetPayload<object> & {
      readonly prices: Array<
        Prisma.TariffConstructorModulePriceGetPayload<object> & {
          readonly duration: Prisma.TariffConstructorDurationGetPayload<object>;
        }
      >;
    }
  >;
  readonly revisions: Prisma.TariffConstructorRevisionGetPayload<object>[];
};

type Revision = Prisma.TariffConstructorRevisionGetPayload<object> & {
  readonly durations: Prisma.TariffConstructorRevisionDurationGetPayload<object>[];
  readonly modules: Array<
    Prisma.TariffConstructorRevisionModuleGetPayload<object> & {
      readonly prices: Prisma.TariffConstructorRevisionModulePriceGetPayload<object>[];
    }
  >;
};

export interface AdminTariffConstructorOutput {
  readonly contractVersion: number;
  readonly id: string;
  readonly enabled: boolean;
  readonly draftVersion: number;
  readonly basePlanId: string;
  readonly publishedRevisionId: string | null;
  readonly durations: ReadonlyArray<{
    readonly days: number;
    readonly currency: Currency;
    readonly baseAmount: string;
  }>;
  readonly modules: ReadonlyArray<{
    readonly type: TariffConstructorModuleType;
    readonly minValue: number;
    readonly maxValue: number;
    readonly defaultValue: number;
    readonly step: number;
    readonly prices: ReadonlyArray<{
      readonly days: number;
      readonly currency: Currency;
      readonly perStepAmount: string;
    }>;
  }>;
  readonly revisions: ReadonlyArray<{
    readonly id: string;
    readonly version: number;
    readonly publishedAt: Date;
  }>;
}

export interface TariffConstructorManifestOutput {
  readonly contractVersion: number;
  readonly revisionId: string;
  readonly revision: number;
  readonly durations: ReadonlyArray<{
    readonly days: number;
    readonly currency: Currency;
    readonly baseAmount: string;
  }>;
  readonly modules: ReadonlyArray<{
    readonly type: TariffConstructorModuleType;
    readonly min: number;
    readonly max: number;
    readonly defaultValue: number;
    readonly step: number;
    readonly prices: ReadonlyArray<{
      readonly days: number;
      readonly currency: Currency;
      readonly perStepAmount: string;
    }>;
  }>;
}

export interface TariffConstructorQuoteOutput {
  readonly contractVersion: number;
  readonly revisionId: string;
  readonly durationDays: number;
  readonly currency: Currency;
  readonly lines: ReadonlyArray<{
    readonly kind: 'BASE' | 'MODULE';
    readonly module?: TariffConstructorModuleType;
    readonly value?: number;
    readonly steps?: number;
    readonly perStepAmount?: string;
    readonly amount: string;
  }>;
  readonly total: string;
}

@Injectable()
export class TariffConstructorService {
  public constructor(private readonly prisma: PrismaService) {}

  public async list(): Promise<AdminTariffConstructorOutput[]> {
    const row = await this.getAdminConfig();
    return row === null ? [] : [this.serializeAdmin(row)];
  }

  public async get(): Promise<AdminTariffConstructorOutput> {
    const row = await this.getAdminConfig();
    if (row === null) throw new NotFoundException('TARIFF_CONSTRUCTOR_NOT_FOUND');
    return this.serializeAdmin(row);
  }

  public async saveDraft(
    input: SaveTariffConstructorDraftDto,
    actor: CurrentAdminInterface,
    requestMetadata: RequestMetadataInterface,
  ): Promise<AdminTariffConstructorOutput> {
    this.validateDraft(input);
    return this.prisma.$transaction(async (tx) => {
      await this.assertActiveBasePlan(tx, input.basePlanId);
      const existing = await tx.tariffConstructor.findUnique({
        where: { key: SINGLETON_KEY },
      });
      const before =
        existing === null ? null : this.serializeAdmin(await this.loadDraft(tx, existing));
      const constructor =
        existing === null
          ? await tx.tariffConstructor.create({
              data: { key: SINGLETON_KEY, basePlanId: input.basePlanId },
            })
          : await tx.tariffConstructor.update({
              where: { id: existing.id },
              data: { basePlanId: input.basePlanId, draftVersion: { increment: 1 } },
            });

      await tx.tariffConstructorModulePrice.deleteMany({
        where: { module: { constructorId: constructor.id } },
      });
      await tx.tariffConstructorModule.deleteMany({ where: { constructorId: constructor.id } });
      await tx.tariffConstructorDuration.deleteMany({ where: { constructorId: constructor.id } });

      const durationIds = new Map<string, string>();
      for (const duration of input.durations) {
        const row = await tx.tariffConstructorDuration.create({
          data: {
            constructorId: constructor.id,
            days: duration.days,
            currency: duration.currency,
            baseAmount: new Prisma.Decimal(duration.baseAmount),
          },
        });
        durationIds.set(this.durationKey(duration.days, duration.currency), row.id);
      }
      for (const module of input.modules) {
        const moduleRow = await tx.tariffConstructorModule.create({
          data: {
            constructorId: constructor.id,
            type: module.type,
            minValue: module.minValue,
            maxValue: module.maxValue,
            defaultValue: module.defaultValue,
            step: module.step,
          },
        });
        await tx.tariffConstructorModulePrice.createMany({
          data: module.prices.map((price) => ({
            moduleId: moduleRow.id,
            durationId: durationIds.get(this.durationKey(price.days, price.currency))!,
            amount: new Prisma.Decimal(price.perStepAmount),
          })),
        });
      }
      const afterRow = await tx.tariffConstructor.findUniqueOrThrow({
        where: { id: constructor.id },
      });
      const after = this.serializeAdmin(await this.loadDraft(tx, afterRow));
      await tx.adminAuditLog.create({
        data: buildAdminAuditLogData({
          action:
            existing === null
              ? 'tariff_constructor.created'
              : 'tariff_constructor.draft_updated',
          actorId: actor.id,
          requestMetadata,
          metadata: { before, after },
        }),
      });
      return after;
    });
  }

  public async publish(
    actor: CurrentAdminInterface,
    requestMetadata: RequestMetadataInterface,
  ): Promise<{ revisionId: string; version: number }> {
    return this.prisma.$transaction(async (tx) => {
      const constructor = await tx.tariffConstructor.findUnique({
        where: { key: SINGLETON_KEY },
      });
      if (constructor === null) throw new BadRequestException('TARIFF_CONSTRUCTOR_DRAFT_EMPTY');
      const draft = await this.loadDraft(tx, constructor);
      this.validatePersistedDraft(draft);
      await this.assertActiveBasePlan(tx, draft.basePlanId);

      const version =
        (
          await tx.tariffConstructorRevision.aggregate({
            where: { constructorId: draft.id },
            _max: { version: true },
          })
        )._max.version ?? 0;
      const revision = await tx.tariffConstructorRevision.create({
        data: {
          constructorId: draft.id,
          version: version + 1,
          basePlanId: draft.basePlanId,
          publishedBy: actor.id,
        },
      });
      const durationIds = new Map<string, string>();
      for (const duration of draft.durations) {
        const row = await tx.tariffConstructorRevisionDuration.create({
          data: {
            revisionId: revision.id,
            days: duration.days,
            currency: duration.currency,
            baseAmount: duration.baseAmount,
          },
        });
        durationIds.set(duration.id, row.id);
      }
      for (const module of draft.modules) {
        const moduleRow = await tx.tariffConstructorRevisionModule.create({
          data: {
            revisionId: revision.id,
            type: module.type,
            minValue: module.minValue,
            maxValue: module.maxValue,
            defaultValue: module.defaultValue,
            step: module.step,
          },
        });
        await tx.tariffConstructorRevisionModulePrice.createMany({
          data: module.prices.map((price) => ({
            moduleId: moduleRow.id,
            durationId: durationIds.get(price.durationId)!,
            amount: price.amount,
          })),
        });
      }
      await tx.tariffConstructor.update({
        where: { id: draft.id },
        data: { publishedRevisionId: revision.id },
      });
      await tx.adminAuditLog.create({
        data: buildAdminAuditLogData({
          action: 'tariff_constructor.published',
          actorId: actor.id,
          requestMetadata,
          metadata: {
            before: { publishedRevisionId: draft.publishedRevisionId },
            after: {
              publishedRevisionId: revision.id,
              version: revision.version,
              basePlanId: revision.basePlanId,
            },
          },
        }),
      });
      return { revisionId: revision.id, version: revision.version };
    });
  }

  public async toggle(
    enabled: boolean,
    actor: CurrentAdminInterface,
    requestMetadata: RequestMetadataInterface,
  ): Promise<{ enabled: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.tariffConstructor.findUnique({ where: { key: SINGLETON_KEY } });
      if (existing === null) throw new NotFoundException('TARIFF_CONSTRUCTOR_NOT_FOUND');
      if (enabled && existing.publishedRevisionId === null) {
        throw new ConflictException('TARIFF_CONSTRUCTOR_NOT_PUBLISHED');
      }
      await tx.tariffConstructor.update({
        where: { id: existing.id },
        data: { isEnabled: enabled },
      });
      await tx.adminAuditLog.create({
        data: buildAdminAuditLogData({
          action: 'tariff_constructor.toggled',
          actorId: actor.id,
          requestMetadata,
          metadata: { before: { enabled: existing.isEnabled }, after: { enabled } },
        }),
      });
      return { enabled };
    });
  }

  public async manifest(): Promise<TariffConstructorManifestOutput> {
    const revision = await this.getEffectiveRevision();
    if (revision === null) throw new NotFoundException('TARIFF_CONSTRUCTOR_UNAVAILABLE');
    return this.serializeManifest(revision);
  }

  public async quote(input: QuoteTariffConstructorDto): Promise<TariffConstructorQuoteOutput> {
    const revision = await this.getEffectiveRevision();
    if (revision === null) throw new NotFoundException('TARIFF_CONSTRUCTOR_UNAVAILABLE');
    if (revision.id !== input.revisionId) {
      throw new ConflictException('TARIFF_CONSTRUCTOR_REVISION_MISMATCH');
    }
    const duration = revision.durations.find(
      (row) => row.days === input.durationDays && row.currency === input.currency,
    );
    if (duration === undefined) {
      throw new BadRequestException('TARIFF_CONSTRUCTOR_DURATION_UNAVAILABLE');
    }

    const selections = new Map<TariffConstructorModuleType, number>();
    for (const selection of input.selections) {
      if (!revision.modules.some((module) => module.type === selection.type)) {
        throw new BadRequestException('TARIFF_CONSTRUCTOR_MISSING_OR_UNKNOWN_SELECTION');
      }
      if (selections.has(selection.type)) {
        throw new BadRequestException('TARIFF_CONSTRUCTOR_DUPLICATE_SELECTION');
      }
      selections.set(selection.type, selection.value);
    }
    if (selections.size !== revision.modules.length) {
      throw new BadRequestException('TARIFF_CONSTRUCTOR_MISSING_OR_UNKNOWN_SELECTION');
    }

    const moduleLines: TariffConstructorQuoteOutput['lines'] = revision.modules.map((module) => {
      const value = selections.get(module.type);
      if (value === undefined) {
        throw new BadRequestException('TARIFF_CONSTRUCTOR_MISSING_OR_UNKNOWN_SELECTION');
      }
      if (
        value < module.minValue ||
        value > module.maxValue ||
        (value - module.minValue) % module.step !== 0
      ) {
        throw new BadRequestException(`TARIFF_CONSTRUCTOR_${module.type}_OUT_OF_RANGE`);
      }
      const perStepAmount = module.prices.find(
        (price) => price.durationId === duration.id,
      )?.amount;
      if (perStepAmount === undefined) {
        throw new BadRequestException('TARIFF_CONSTRUCTOR_PRICE_UNAVAILABLE');
      }
      const steps = (value - module.minValue) / module.step;
      const amount = perStepAmount.mul(steps);
      return {
        kind: 'MODULE',
        module: module.type,
        value,
        steps,
        perStepAmount: perStepAmount.toString(),
        amount: amount.toString(),
      };
    });
    const lines: TariffConstructorQuoteOutput['lines'] = [
      { kind: 'BASE', amount: duration.baseAmount.toString() },
      ...moduleLines,
    ];
    const total = lines.reduce(
      (sum, line) => sum.plus(line.amount),
      new Prisma.Decimal(0),
    );
    return {
      contractVersion: CONTRACT_VERSION,
      revisionId: revision.id,
      durationDays: duration.days,
      currency: duration.currency,
      lines,
      total: total.toString(),
    };
  }

  private async getAdminConfig(): Promise<Draft | null> {
    const row = await this.prisma.tariffConstructor.findUnique({
      where: { key: SINGLETON_KEY },
    });
    return row === null ? null : this.loadDraft(this.prisma, row);
  }

  private async getEffectiveRevision(): Promise<Revision | null> {
    const constructor = await this.prisma.tariffConstructor.findUnique({
      where: { key: SINGLETON_KEY },
      select: { isEnabled: true, publishedRevisionId: true },
    });
    if (constructor?.isEnabled !== true || constructor.publishedRevisionId === null) return null;
    const revision = await this.prisma.tariffConstructorRevision.findUnique({
      where: { id: constructor.publishedRevisionId },
    });
    return revision === null ? null : this.loadRevision(this.prisma, revision);
  }

  private async loadDraft(
    tx: Prisma.TransactionClient | PrismaService,
    row: Prisma.TariffConstructorGetPayload<object>,
  ): Promise<Draft> {
    const [durations, modules, revisions] = await Promise.all([
      tx.tariffConstructorDuration.findMany({ where: { constructorId: row.id } }),
      tx.tariffConstructorModule.findMany({ where: { constructorId: row.id } }),
      tx.tariffConstructorRevision.findMany({
        where: { constructorId: row.id },
        orderBy: { publishedAt: 'desc' },
      }),
    ]);
    const prices = await tx.tariffConstructorModulePrice.findMany({
      where: { moduleId: { in: modules.map((module) => module.id) } },
    });
    const durationsById = new Map(durations.map((duration) => [duration.id, duration]));
    return {
      ...row,
      durations,
      revisions,
      modules: modules.map((module) => ({
        ...module,
        prices: prices
          .filter((price) => price.moduleId === module.id)
          .map((price) => ({ ...price, duration: durationsById.get(price.durationId)! })),
      })),
    };
  }

  private async loadRevision(
    tx: Prisma.TransactionClient | PrismaService,
    row: Prisma.TariffConstructorRevisionGetPayload<object>,
  ): Promise<Revision> {
    const [durations, modules] = await Promise.all([
      tx.tariffConstructorRevisionDuration.findMany({ where: { revisionId: row.id } }),
      tx.tariffConstructorRevisionModule.findMany({ where: { revisionId: row.id } }),
    ]);
    const prices = await tx.tariffConstructorRevisionModulePrice.findMany({
      where: { moduleId: { in: modules.map((module) => module.id) } },
    });
    return {
      ...row,
      durations,
      modules: modules.map((module) => ({
        ...module,
        prices: prices.filter((price) => price.moduleId === module.id),
      })),
    };
  }

  private validateDraft(input: SaveTariffConstructorDraftDto): void {
    const durationKeys = new Set(
      input.durations.map((row) => this.durationKey(row.days, row.currency)),
    );
    if (durationKeys.size !== input.durations.length) {
      throw new BadRequestException('DUPLICATE_DURATION');
    }
    if (new Set(input.modules.map((row) => row.type)).size !== input.modules.length) {
      throw new BadRequestException('DUPLICATE_MODULE');
    }
    for (const module of input.modules) {
      this.validateModuleRange(module);
      const prices = new Set<string>();
      for (const price of module.prices) {
        const key = this.durationKey(price.days, price.currency);
        if (!durationKeys.has(key)) throw new BadRequestException('UNKNOWN_PRICE_DURATION');
        if (prices.has(key)) throw new BadRequestException('DUPLICATE_PRICE');
        prices.add(key);
      }
      if (prices.size !== durationKeys.size) {
        throw new BadRequestException('INCOMPLETE_MODULE_PRICES');
      }
    }
  }

  private validatePersistedDraft(draft: Draft): void {
    if (draft.durations.length === 0 || draft.modules.length === 0) {
      throw new BadRequestException('TARIFF_CONSTRUCTOR_DRAFT_EMPTY');
    }
    for (const module of draft.modules) {
      this.validateModuleRange(module);
      if (
        module.prices.length !== draft.durations.length ||
        new Set(module.prices.map((price) => price.durationId)).size !== draft.durations.length
      ) {
        throw new BadRequestException('INCOMPLETE_MODULE_PRICES');
      }
    }
  }

  private validateModuleRange(module: {
    readonly minValue: number;
    readonly maxValue: number;
    readonly defaultValue: number;
    readonly step: number;
  }): void {
    if (
      module.step <= 0 ||
      module.maxValue < module.minValue ||
      module.defaultValue < module.minValue ||
      module.defaultValue > module.maxValue ||
      (module.maxValue - module.minValue) % module.step !== 0 ||
      (module.defaultValue - module.minValue) % module.step !== 0
    ) {
      throw new BadRequestException('INVALID_MODULE_RANGE');
    }
  }

  private async assertActiveBasePlan(
    tx: Prisma.TransactionClient,
    basePlanId: string,
  ): Promise<void> {
    const plan = await tx.plan.findFirst({
      where: { id: basePlanId, isActive: true, isArchived: false },
      select: { id: true },
    });
    if (plan === null) throw new BadRequestException('TARIFF_CONSTRUCTOR_BASE_PLAN_UNAVAILABLE');
  }

  private durationKey(days: number, currency: Currency): string {
    return `${days}:${currency}`;
  }

  private serializeAdmin(row: Draft): AdminTariffConstructorOutput {
    return {
      contractVersion: CONTRACT_VERSION,
      id: row.id,
      enabled: row.isEnabled,
      draftVersion: row.draftVersion,
      basePlanId: row.basePlanId,
      publishedRevisionId: row.publishedRevisionId,
      durations: row.durations.map((duration) => ({
        days: duration.days,
        currency: duration.currency,
        baseAmount: duration.baseAmount.toString(),
      })),
      modules: row.modules.map((module) => ({
        type: module.type,
        minValue: module.minValue,
        maxValue: module.maxValue,
        defaultValue: module.defaultValue,
        step: module.step,
        prices: module.prices.map((price) => ({
          days: price.duration.days,
          currency: price.duration.currency,
          perStepAmount: price.amount.toString(),
        })),
      })),
      revisions: row.revisions.map((revision) => ({
        id: revision.id,
        version: revision.version,
        publishedAt: revision.publishedAt,
      })),
    };
  }

  private serializeManifest(revision: Revision): TariffConstructorManifestOutput {
    const durationsById = new Map(revision.durations.map((duration) => [duration.id, duration]));
    return {
      contractVersion: CONTRACT_VERSION,
      revisionId: revision.id,
      revision: revision.version,
      durations: revision.durations.map((duration) => ({
        days: duration.days,
        currency: duration.currency,
        baseAmount: duration.baseAmount.toString(),
      })),
      modules: revision.modules.map((module) => ({
        type: module.type,
        min: module.minValue,
        max: module.maxValue,
        defaultValue: module.defaultValue,
        step: module.step,
        prices: module.prices.map((price) => {
          const duration = durationsById.get(price.durationId)!;
          return {
            days: duration.days,
            currency: duration.currency,
            perStepAmount: price.amount.toString(),
          };
        }),
      })),
    };
  }
}
