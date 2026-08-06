import { FraudSignalSeverity, FraudSignalStatus } from '@prisma/client';

import { PrismaService } from '../../src/common/prisma/prisma.service';

/**
 * The in-memory Postgres the anti-fraud suites run against.
 *
 * Deliberately STRICT rather than permissive. A double that quietly matched
 * everything it did not understand would turn "the service started using a
 * filter operator we do not model" into a green test — which is precisely the
 * failure mode this repository has recorded nine times. So: an unknown column
 * throws, an unmodelled operator throws, an `upsert` without a compound key
 * throws. A test that goes green here has exercised a query shape the double
 * actually understands.
 *
 * Shared by `anti-fraud-signal-lifecycle.spec.ts` and
 * `anti-fraud-gates.spec.ts` so the two cannot drift into disagreeing about
 * what the database does.
 */

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface SignalRow {
  id: string;
  code: string;
  fingerprint: string;
  severity: FraudSignalSeverity;
  status: FraudSignalStatus;
  title: string;
  description: string;
  score: number;
  confidence: number;
  affectedUserIds: string[];
  metadata: Record<string, unknown>;
  lastAction: string;
  detectedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StreakRow {
  id: string;
  code: string;
  conditionKey: string;
  observations: number;
  severity: FraudSignalSeverity;
  lastSeverity: FraudSignalSeverity;
  score: number;
  title: string;
  affectedUserIds: string[];
  heldBy: string;
  exemptionId: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExemptionRow {
  id: string;
  userId: string;
  codes: string[];
  reason: string;
  expiresAt: Date;
  createdBy: string | null;
  revokedAt: Date | null;
  revokedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditRow {
  action: string;
  metadata: Record<string, unknown>;
  adminId: string | null;
}

/**
 * The user shape `buildFraudNotifyPayload` selects.
 *
 * Every field is present because Prisma's `select` always returns the selected
 * keys — `telegramId` is `null`, never absent. A double that returned a bare
 * `{ id }` would make `user.telegramId !== null` true and `.toString()` blow up
 * inside the notify path, which is a bug in the double and not in the service.
 */
export interface UserRow {
  id: string;
  telegramId: bigint | null;
  username: string | null;
  name: string | null;
  email: string | null;
  role: string;
  isBlocked: boolean;
  webAccount: { id: string } | null;
  _count: { subscriptions: number };
}

// ── Query engine ─────────────────────────────────────────────────────────────

const SUPPORTED_OPERATORS = ['in', 'notIn', 'gte', 'gt', 'lt', 'lte', 'hasSome', 'not'];

export function matches(row: object, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [field, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (field === 'OR') {
      if (!(condition as Record<string, unknown>[]).some((c) => matches(row, c))) return false;
      continue;
    }
    if (field === 'AND') {
      if (!(condition as Record<string, unknown>[]).every((c) => matches(row, c))) return false;
      continue;
    }
    const value = (row as unknown as Record<string, unknown>)[field];
    if (!(field in row)) throw new Error(`double: unknown column ${field}`);
    if (condition === null) {
      if (value !== null) return false;
      continue;
    }
    if (condition instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== condition.getTime()) return false;
      continue;
    }
    if (typeof condition === 'object') {
      const ops = condition as Record<string, unknown>;
      for (const op of Object.keys(ops)) {
        if (!SUPPORTED_OPERATORS.includes(op)) {
          throw new Error(`double: unsupported filter operator ${field}.${op}`);
        }
      }
      if ('in' in ops && !(ops.in as unknown[]).includes(value)) return false;
      if ('notIn' in ops && (ops.notIn as unknown[]).includes(value)) return false;
      if ('not' in ops && value === ops.not) return false;
      if ('gte' in ops && !(compare(value, ops.gte) >= 0)) return false;
      if ('gt' in ops && !(compare(value, ops.gt) > 0)) return false;
      if ('lte' in ops && !(compare(value, ops.lte) <= 0)) return false;
      if ('lt' in ops && !(compare(value, ops.lt) < 0)) return false;
      if (
        'hasSome' in ops &&
        !(value as string[]).some((v) => (ops.hasSome as string[]).includes(v))
      ) {
        return false;
      }
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
}

export function compare(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return NaN;
  const left = a instanceof Date ? a.getTime() : (a as number | string);
  const right = b instanceof Date ? b.getTime() : (b as number | string);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Postgres puts NULLs first on DESC and last on ASC; the ordering matters. */
export function sortRows<T extends object>(
  rows: T[],
  orderBy: Record<string, 'asc' | 'desc'>[] | undefined,
): T[] {
  if (!orderBy) return rows;
  return [...rows].sort((a, b) => {
    for (const clause of orderBy) {
      const [field, direction] = Object.entries(clause)[0];
      const av = (a as unknown as Record<string, unknown>)[field];
      const bv = (b as unknown as Record<string, unknown>)[field];
      if (av === bv) continue;
      if (av === null) return direction === 'desc' ? -1 : 1;
      if (bv === null) return direction === 'desc' ? 1 : -1;
      const cmp = compare(av, bv);
      if (cmp !== 0) return direction === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
}

/**
 * One table. `compoundKeys` names the Prisma composite-key accessors the
 * service is allowed to look rows up by; anything else in a `findUnique`/
 * `upsert` `where` throws rather than silently missing.
 */
function makeTable<T extends { id: string }>(input: {
  readonly rows: T[];
  readonly name: string;
  readonly compoundKeys: Readonly<Record<string, readonly (keyof T)[]>>;
  readonly hydrate: (seed: Partial<T>, id: string) => T;
  readonly nextId: () => string;
  readonly clone: (row: T) => T;
}) {
  const { rows, name, compoundKeys, hydrate, nextId, clone } = input;

  const locate = (where: Record<string, unknown>): T | undefined => {
    if (typeof where.id === 'string') return rows.find((r) => r.id === where.id);
    for (const [key, fields] of Object.entries(compoundKeys)) {
      const composite = where[key] as Record<string, unknown> | undefined;
      if (composite === undefined) continue;
      return rows.find((r) => fields.every((f) => r[f] === composite[f as string]));
    }
    throw new Error(`double: unsupported ${name}.findUnique where ${JSON.stringify(where)}`);
  };

  return {
    findUnique: (args: { where: Record<string, unknown>; include?: Record<string, unknown> }) => {
      const hit = locate(args.where);
      return Promise.resolve(hit ? withIncludes(clone(hit), args.include) : null);
    },
    findMany: (args: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, 'asc' | 'desc'>[];
      take?: number;
      include?: Record<string, unknown>;
      select?: Record<string, unknown>;
    }) => {
      const filtered = rows.filter((r) => matches(r, args.where));
      const sorted = sortRows(filtered, args.orderBy);
      const page = args.take ? sorted.slice(0, args.take) : sorted;
      return Promise.resolve(page.map((r) => withIncludes(clone(r), args.include)));
    },
    findFirst: (args: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, 'asc' | 'desc'>[];
    }) => {
      const filtered = rows.filter((r) => matches(r, args.where));
      const sorted = sortRows(filtered, args.orderBy);
      return Promise.resolve(sorted.length > 0 ? clone(sorted[0]) : null);
    },
    create: (args: { data: Record<string, unknown> }) => {
      const row = hydrate(args.data as Partial<T>, nextId());
      rows.push(row);
      return Promise.resolve(clone(row));
    },
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows.find((r) => r.id === args.where.id);
      if (!row) throw new Error(`double: no ${name} row ${args.where.id}`);
      Object.assign(row, args.data);
      (row as unknown as { updatedAt: Date }).updatedAt = new Date();
      return Promise.resolve(clone(row));
    },
    upsert: (args: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const existing = locate(args.where);
      if (existing) {
        Object.assign(existing, args.update);
        (existing as unknown as { updatedAt: Date }).updatedAt = new Date();
        return Promise.resolve(clone(existing));
      }
      const row = hydrate(args.create as Partial<T>, nextId());
      rows.push(row);
      return Promise.resolve(clone(row));
    },
    deleteMany: (args: { where?: Record<string, unknown> }) => {
      let removed = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (!matches(rows[i], args.where)) continue;
        rows.splice(i, 1);
        removed += 1;
      }
      return Promise.resolve({ count: removed });
    },
  };
}

/**
 * Prisma returns relation objects only when asked. The service reads
 * `creator?.login`, so the double must say "no creator loaded" rather than
 * leave the property absent and let an optional chain hide a missing include.
 */
function withIncludes<T>(row: T, include: Record<string, unknown> | undefined): T {
  if (!include) return row;
  const out = row as unknown as Record<string, unknown>;
  for (const key of Object.keys(include)) out[key] = null;
  return row;
}

// ── The store ────────────────────────────────────────────────────────────────

export interface AntiFraudStore {
  readonly rows: SignalRow[];
  readonly streaks: StreakRow[];
  readonly exemptions: ExemptionRow[];
  readonly audits: AuditRow[];
  readonly users: UserRow[];
  readonly prisma: PrismaService;
  byFingerprint(code: string, fingerprint: string): SignalRow | undefined;
  familyOf(base: string): SignalRow[];
  streakFor(code: string, conditionKey: string): StreakRow | undefined;
}

export function makeAntiFraudStore(input: {
  readonly signals?: readonly Partial<SignalRow>[];
  readonly streaks?: readonly Partial<StreakRow>[];
  readonly exemptions?: readonly Partial<ExemptionRow>[];
  readonly users?: readonly string[];
  /** The day bucket seeded fingerprints default to. */
  readonly today: string;
}): AntiFraudStore {
  let sequence = 0;
  const nextId = () => `row-${++sequence}`;

  const rows: SignalRow[] = (input.signals ?? []).map((s) => hydrateSignal(s, nextId(), input.today));
  const streaks: StreakRow[] = (input.streaks ?? []).map((s) => hydrateStreak(s, nextId()));
  const exemptions: ExemptionRow[] = (input.exemptions ?? []).map((s) => hydrateExemption(s, nextId()));
  const audits: AuditRow[] = [];
  const users: UserRow[] = (input.users ?? []).map((id) => ({
    id,
    telegramId: null,
    username: null,
    name: null,
    email: null,
    role: 'USER',
    isBlocked: false,
    webAccount: null,
    _count: { subscriptions: 0 },
  }));

  const fraudSignal = makeTable<SignalRow>({
    rows,
    name: 'fraudSignal',
    compoundKeys: { code_fingerprint: ['code', 'fingerprint'] },
    hydrate: (seed, id) => hydrateSignal(seed, id, input.today),
    nextId,
    clone: (row) => ({ ...row, affectedUserIds: [...row.affectedUserIds], metadata: { ...row.metadata } }),
  });

  const fraudCandidateStreak = makeTable<StreakRow>({
    rows: streaks,
    name: 'fraudCandidateStreak',
    compoundKeys: { code_conditionKey: ['code', 'conditionKey'] },
    hydrate: hydrateStreak,
    nextId,
    clone: (row) => ({ ...row, affectedUserIds: [...row.affectedUserIds] }),
  });

  const fraudExemption = makeTable<ExemptionRow>({
    rows: exemptions,
    name: 'fraudExemption',
    compoundKeys: {},
    hydrate: hydrateExemption,
    nextId,
    clone: (row) => ({ ...row, codes: [...row.codes] }),
  });

  const prisma = {
    fraudSignal,
    fraudCandidateStreak,
    fraudExemption,
    user: {
      findUnique: (args: { where: { id: string } }) =>
        Promise.resolve(users.find((u) => u.id === args.where.id) ?? null),
      findMany: (args: { where?: { id?: { in?: string[] } } }) => {
        const wanted = args.where?.id?.in;
        return Promise.resolve(
          wanted ? users.filter((u) => wanted.includes(u.id)) : [...users],
        );
      },
    },
    adminAuditLog: {
      create: (args: { data: Record<string, unknown> }) => {
        const connect = args.data.adminUser as { connect?: { id?: string } } | undefined;
        audits.push({
          action: String(args.data.action),
          metadata: (args.data.metadata ?? {}) as Record<string, unknown>,
          adminId: connect?.connect?.id ?? null,
        });
        return Promise.resolve({ id: nextId() });
      },
    },
  } as unknown as PrismaService;

  return {
    rows,
    streaks,
    exemptions,
    audits,
    users,
    prisma,
    byFingerprint: (code, fingerprint) =>
      rows.find((r) => r.code === code && r.fingerprint === fingerprint),
    familyOf: (base) => rows.filter((r) => r.fingerprint.replace(/#\d+$/, '') === base),
    streakFor: (code, conditionKey) =>
      streaks.find((r) => r.code === code && r.conditionKey === conditionKey),
  };
}

function hydrateSignal(seed: Partial<SignalRow>, id: string, today: string): SignalRow {
  const now = new Date();
  return {
    id: seed.id ?? id,
    code: seed.code ?? 'PROMO_ABUSE',
    fingerprint: seed.fingerprint ?? `${today}|x`,
    severity: seed.severity ?? FraudSignalSeverity.MEDIUM,
    status: seed.status ?? FraudSignalStatus.OPEN,
    title: seed.title ?? 'title',
    description: seed.description ?? 'description',
    score: seed.score ?? 50,
    confidence: seed.confidence ?? 70,
    affectedUserIds: [...(seed.affectedUserIds ?? [])],
    metadata: { ...(seed.metadata ?? {}) },
    lastAction: seed.lastAction ?? 'none',
    detectedAt: seed.detectedAt ?? now,
    resolvedAt: seed.resolvedAt ?? null,
    resolvedBy: seed.resolvedBy ?? null,
    resolutionNote: seed.resolutionNote ?? null,
    createdAt: seed.createdAt ?? now,
    updatedAt: seed.updatedAt ?? now,
  };
}

function hydrateStreak(seed: Partial<StreakRow>, id: string): StreakRow {
  const now = new Date();
  return {
    id: seed.id ?? id,
    code: seed.code ?? 'SUBSCRIPTION_SHARING_HWID',
    conditionKey: seed.conditionKey ?? 'uuid-1',
    observations: seed.observations ?? 1,
    severity: seed.severity ?? FraudSignalSeverity.MEDIUM,
    lastSeverity: seed.lastSeverity ?? seed.severity ?? FraudSignalSeverity.MEDIUM,
    score: seed.score ?? 50,
    title: seed.title ?? 'title',
    affectedUserIds: [...(seed.affectedUserIds ?? [])],
    heldBy: seed.heldBy ?? 'streak',
    exemptionId: seed.exemptionId ?? null,
    firstSeenAt: seed.firstSeenAt ?? now,
    lastSeenAt: seed.lastSeenAt ?? now,
    createdAt: seed.createdAt ?? now,
    updatedAt: seed.updatedAt ?? now,
  };
}

function hydrateExemption(seed: Partial<ExemptionRow>, id: string): ExemptionRow {
  const now = new Date();
  return {
    id: seed.id ?? id,
    userId: seed.userId ?? 'u1',
    codes: [...(seed.codes ?? ['SUBSCRIPTION_SHARING_HWID'])],
    reason: seed.reason ?? 'verified power user',
    expiresAt: seed.expiresAt ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    createdBy: seed.createdBy ?? 'admin-1',
    revokedAt: seed.revokedAt ?? null,
    revokedBy: seed.revokedBy ?? null,
    createdAt: seed.createdAt ?? now,
    updatedAt: seed.updatedAt ?? now,
  };
}
