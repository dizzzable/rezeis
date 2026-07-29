import { ConflictException } from '@nestjs/common';
import { Currency, PaymentGatewayType, PlanType, PurchaseChannel, PurchaseType, TariffConstructorModuleType, TrafficLimitStrategy } from '@prisma/client';
import { Prisma } from '@prisma/client';

export const TARIFF_CONSTRUCTOR_SNAPSHOT_SOURCE = 'TARIFF_CONSTRUCTOR_CHECKOUT';
export const TARIFF_CONSTRUCTOR_SNAPSHOT_VERSION = 1;

export interface TariffConstructorSnapshot {
  readonly snapshotSource: typeof TARIFF_CONSTRUCTOR_SNAPSHOT_SOURCE;
  readonly snapshotVersion: 1;
  readonly revisionId: string;
  readonly revision: number;
  readonly selections: ReadonlyArray<{ readonly type: TariffConstructorModuleType; readonly value: number }>;
  readonly lines: ReadonlyArray<{ readonly kind: 'BASE' | 'MODULE'; readonly module: TariffConstructorModuleType | null; readonly value: number | null; readonly steps: number | null; readonly perStepAmount: string | null; readonly amount: string }>;
  readonly amount: string;
  readonly currency: Currency;
  readonly basePlan: { readonly id: string; readonly name: string; readonly description: string; readonly tag: string | null; readonly type: PlanType; readonly icon: unknown; readonly trafficLimitStrategy: TrafficLimitStrategy; readonly internalSquads: readonly string[]; readonly externalSquad: string | null };
  readonly trafficLimit: number;
  readonly deviceLimit: number;
  readonly durationDays: number;
  readonly channel: PurchaseChannel;
  readonly gatewayType: PaymentGatewayType;
  readonly purchaseType: 'NEW' | 'ADDITIONAL';
}

export function decodeTariffConstructorSnapshot(raw: unknown): TariffConstructorSnapshot | null {
  if (!isRecord(raw) || raw['snapshotSource'] !== TARIFF_CONSTRUCTOR_SNAPSHOT_SOURCE) return null;
  const malformed = (): never => { throw new ConflictException('Persisted tariff constructor snapshot is malformed'); };
  const snapshotVersion = raw['snapshotVersion']; const revisionId = raw['revisionId']; const revision = raw['revision'];
  const selections = raw['selections']; const lines = raw['lines']; const amount = raw['amount']; const currency = raw['currency'];
  const basePlan = raw['basePlan']; const trafficLimit = raw['trafficLimit']; const deviceLimit = raw['deviceLimit']; const durationDays = raw['durationDays'];
  const channel = raw['channel']; const gatewayType = raw['gatewayType']; const purchaseType = raw['purchaseType'];
  if (snapshotVersion !== 1 || !nonEmpty(revisionId) || !positiveInt(revision) || !Array.isArray(selections) || !Array.isArray(lines) || !decimal(amount) || !enumValue(Currency, currency) || !isRecord(basePlan) || !positiveInt(trafficLimit) || !positiveInt(deviceLimit) || !positiveInt(durationDays) || !enumValue(PurchaseChannel, channel) || !enumValue(PaymentGatewayType, gatewayType) || (purchaseType !== PurchaseType.NEW && purchaseType !== PurchaseType.ADDITIONAL)) return malformed();
  const decodedSelections = selections.map((entry) => {
    if (!isRecord(entry) || !moduleType(entry['type']) || !positiveInt(entry['value'])) return malformed();
    return { type: entry['type'], value: entry['value'] };
  });
  if (decodedSelections.length !== 2 || new Set(decodedSelections.map((entry) => entry.type)).size !== 2) return malformed();
  const selectedTraffic = decodedSelections.find((entry) => entry.type === TariffConstructorModuleType.TRAFFIC)?.value;
  const selectedDevices = decodedSelections.find((entry) => entry.type === TariffConstructorModuleType.DEVICES)?.value;
  if (selectedTraffic !== trafficLimit || selectedDevices !== deviceLimit) return malformed();
  const decodedLines = lines.map((entry) => {
    if (!isRecord(entry) || (entry['kind'] !== 'BASE' && entry['kind'] !== 'MODULE') || !decimal(entry['amount'])) return malformed();
    const module = entry['module']; const value = entry['value']; const steps = entry['steps']; const perStepAmount = entry['perStepAmount'];
    if (entry['kind'] === 'BASE') { if (module !== null || value !== null || steps !== null || perStepAmount !== null) return malformed(); }
    else if (!moduleType(module) || !positiveInt(value) || !nonNegativeInt(steps) || !decimal(perStepAmount)) return malformed();
    return { kind: entry['kind'], module, value, steps, perStepAmount, amount: entry['amount'] } as TariffConstructorSnapshot['lines'][number];
  });
  const baseLines = decodedLines.filter((line) => line.kind === 'BASE');
  const moduleLines = decodedLines.filter((line) => line.kind === 'MODULE');
  if (baseLines.length !== 1 || moduleLines.length !== decodedSelections.length) return malformed();
  for (const selection of decodedSelections) {
    const matching = moduleLines.filter((line) => line.module === selection.type);
    if (matching.length !== 1 || matching[0]?.value !== selection.value) return malformed();
  }
  const lineTotal = decodedLines.reduce((sum, line) => sum.plus(line.amount), new Prisma.Decimal(0));
  if (lineTotal.cmp(amount) !== 0) return malformed();
  const id = basePlan['id']; const name = basePlan['name']; const description = basePlan['description']; const tag = basePlan['tag']; const type = basePlan['type']; const icon = basePlan['icon']; const strategy = basePlan['trafficLimitStrategy']; const internalSquads = basePlan['internalSquads']; const externalSquad = basePlan['externalSquad'];
  if (!nonEmpty(id) || !nonEmpty(name) || typeof description !== 'string' || (tag !== null && typeof tag !== 'string') || !enumValue(PlanType, type) || !enumValue(TrafficLimitStrategy, strategy) || !Array.isArray(internalSquads) || !internalSquads.every(nonEmpty) || (externalSquad !== null && typeof externalSquad !== 'string')) return malformed();
  return { snapshotSource: TARIFF_CONSTRUCTOR_SNAPSHOT_SOURCE, snapshotVersion: 1, revisionId, revision, selections: decodedSelections, lines: decodedLines, amount, currency, basePlan: { id, name, description, tag, type, icon, trafficLimitStrategy: strategy, internalSquads, externalSquad }, trafficLimit, deviceLimit, durationDays, channel, gatewayType, purchaseType } as TariffConstructorSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function positiveInt(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value > 0; }
function nonNegativeInt(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 0; }
function decimal(value: unknown): value is string { return typeof value === 'string' && /^\d+(?:\.\d{1,8})?$/.test(value); }
function moduleType(value: unknown): value is TariffConstructorModuleType { return value === TariffConstructorModuleType.TRAFFIC || value === TariffConstructorModuleType.DEVICES; }
function enumValue<T extends Record<string, string>>(values: T, value: unknown): value is T[keyof T] { return typeof value === 'string' && Object.values(values).includes(value); }
