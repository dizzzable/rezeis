/**
 * A small in-memory database for the plan-deletion specs — the reference
 * guard, the delete itself, the nightly sweep and the name release.
 *
 * WHY IT EVALUATES `where` INSTEAD OF ANSWERING FROM OPTIONS. Every condition in
 * `PlanReferenceGuardService` IS the protection: drop `fulfilledAt: null` from
 * the unsettled-payment kind and a fulfilled purchase keeps a plan alive for
 * ever; drop `archivedAt: null` from the promocode kind and so does every code
 * ever archived; flip a status and a paying customer's plan is removed. A double
 * that returns canned rows whatever it is asked makes all of those mutations
 * green — the retired-plan sweeper's first suite let 33 of 51 survive that way.
 * So rows go in, the service's own `where` is applied to them, and the answer
 * comes out.
 *
 * IT THROWS ON WHAT IT CANNOT READ. An operator this evaluator does not model, a
 * field a row does not have, SQL it does not recognise — each is an error, not
 * a quiet "match everything". A double that degrades silently is the defect it
 * exists to catch (`test/fixtures/subscription-where.ts` makes the same promise).
 *
 * WHAT IT DOES NOT MODEL: isolation, locking and cascades. Those are the live
 * PostgreSQL spec's job (`test/plan-delete-postgres.spec.ts`), which also proves
 * the Prisma JSON-path filters mean on a real engine what they mean here.
 */

export type Row = Record<string, unknown>;

type ModelName =
  | 'plan'
  | 'subscription'
  | 'subscriptionTerm'
  | 'transaction'
  | 'transactionItem'
  | 'trialClaim'
  | 'promocode'
  | 'promocodeAction'
  | 'quest'
  | 'contest'
  | 'contestPrize'
  | 'wheelSector'
  | 'addOn'
  | 'adPlacement'
  | 'settings'
  | 'adminAuditLog';

interface RelationSpec {
  readonly model: ModelName;
  readonly kind: 'one' | 'many';
  /** `one`: the foreign key on THIS row. `many`: the foreign key on the related rows. */
  readonly key: string;
}

const RELATIONS: Partial<Record<ModelName, Record<string, RelationSpec>>> = {
  transactionItem: { transaction: { model: 'transaction', kind: 'one', key: 'transactionId' } },
  promocode: { actions: { model: 'promocodeAction', kind: 'many', key: 'promocodeId' } },
  contestPrize: { contest: { model: 'contest', kind: 'one', key: 'contestId' } },
};

export interface PlanReferenceDbSeed {
  readonly plans?: readonly Row[];
  readonly subscriptions?: readonly Row[];
  readonly subscriptionTerms?: readonly Row[];
  readonly transactions?: readonly Row[];
  readonly transactionItems?: readonly Row[];
  readonly trialClaims?: readonly Row[];
  readonly promocodes?: readonly Row[];
  readonly promocodeActions?: readonly Row[];
  readonly quests?: readonly Row[];
  readonly contests?: readonly Row[];
  readonly contestPrizes?: readonly Row[];
  readonly wheelSectors?: readonly Row[];
  readonly addOns?: readonly Row[];
  readonly adPlacements?: readonly Row[];
  /** The singleton settings row; omitted means the table is empty. */
  readonly settings?: Row | null;
  /** Make one operation throw, e.g. `{ 'plan.deleteMany': new Error('refused') }`. */
  readonly failures?: Readonly<Record<string, Error>>;
}

const BASE_DATE = new Date('2026-01-01T00:00:00.000Z');

/** Prisma write operators; a JSON column value never uses these as keys. */
const WRITE_OPERATORS = new Set([
  'set',
  'push',
  'increment',
  'decrement',
  'multiply',
  'divide',
  'connect',
  'disconnect',
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

/** A plan row with every column the plan code reads. */
export function planRow(overrides: Row = {}): Row {
  const id = (overrides.id as string | undefined) ?? 'plan';
  return {
    id,
    name: `Plan ${id}`,
    orderIndex: 0,
    isActive: true,
    isArchived: false,
    archivedRenewMode: 'SELF_RENEW',
    type: 'BOTH',
    availability: 'ALL',
    description: null,
    tag: null,
    icon: null,
    trafficLimit: null,
    deviceLimit: 0,
    trafficLimitStrategy: 'NO_RESET',
    upgradeToPlanIds: [],
    replacementPlanIds: [],
    allowedUserIds: [],
    trialSettings: {},
    internalSquads: [],
    externalSquad: null,
    cashbackMode: 'INHERIT',
    cashbackPercent: null,
    deletedAt: null,
    deletedWhileOnSale: false,
    createdAt: BASE_DATE,
    updatedAt: BASE_DATE,
    durations: [],
    ...overrides,
  };
}

export function buildPlanReferenceDb(seed: PlanReferenceDbSeed = {}) {
  let generated = 0;
  const nextId = (model: string): string => `${model}-gen-${++generated}`;
  const tables: Record<ModelName, Row[]> = {
    plan: (seed.plans ?? []).map((row) => planRow(row)),
    subscription: copyRows(seed.subscriptions),
    subscriptionTerm: copyRows(seed.subscriptionTerms),
    transaction: copyRows(seed.transactions),
    transactionItem: copyRows(seed.transactionItems),
    trialClaim: copyRows(seed.trialClaims),
    promocode: copyRows(seed.promocodes),
    promocodeAction: copyRows(seed.promocodeActions),
    quest: copyRows(seed.quests),
    contest: copyRows(seed.contests),
    contestPrize: copyRows(seed.contestPrizes),
    wheelSector: copyRows(seed.wheelSectors),
    addOn: copyRows(seed.addOns),
    adPlacement: copyRows(seed.adPlacements),
    settings: seed.settings === undefined || seed.settings === null ? [] : [{ ...seed.settings }],
    adminAuditLog: [],
  };
  /** Every operation, in order: `plan.findMany`, `$queryRaw:lock-plan`, … */
  const calls: string[] = [];
  let transactions = 0;

  const fail = (operation: string): void => {
    const error = seed.failures?.[operation];
    if (error !== undefined) throw error;
  };

  function matchesWhere(model: ModelName, row: Row, where: unknown): boolean {
    if (where === undefined) return true;
    if (typeof where !== 'object' || where === null || Array.isArray(where)) {
      throw new Error(`plan-reference-db: ${model} where must be an object, got ${JSON.stringify(where)}`);
    }
    for (const [key, condition] of Object.entries(where)) {
      if (condition === undefined) continue;
      if (key === 'AND') {
        const list = Array.isArray(condition) ? condition : [condition];
        if (!list.every((clause) => matchesWhere(model, row, clause))) return false;
        continue;
      }
      if (key === 'OR') {
        if (!Array.isArray(condition)) throw new Error('plan-reference-db: OR must be an array');
        if (!condition.some((clause) => matchesWhere(model, row, clause))) return false;
        continue;
      }
      if (key === 'NOT') {
        const list = Array.isArray(condition) ? condition : [condition];
        if (list.some((clause) => matchesWhere(model, row, clause))) return false;
        continue;
      }
      const relation = RELATIONS[model]?.[key];
      if (relation !== undefined) {
        if (!matchesRelation(row, relation, condition)) return false;
        continue;
      }
      if (!(key in row)) {
        throw new Error(`plan-reference-db: ${model} has no field "${key}" in this fixture`);
      }
      if (!matchesField(model, key, row[key], condition)) return false;
    }
    return true;
  }

  function matchesRelation(row: Row, relation: RelationSpec, condition: unknown): boolean {
    const spec = condition as Record<string, unknown>;
    if (relation.kind === 'one') {
      const related = tables[relation.model].find((candidate) => candidate.id === row[relation.key]);
      if ('is' in spec) return related !== undefined && matchesWhere(relation.model, related, spec.is);
      if ('isNot' in spec) return related === undefined || !matchesWhere(relation.model, related, spec.isNot);
      return related !== undefined && matchesWhere(relation.model, related, spec);
    }
    const related = tables[relation.model].filter((candidate) => candidate[relation.key] === row.id);
    const keys = Object.keys(spec);
    if (keys.length !== 1) throw new Error(`plan-reference-db: to-many filter needs exactly one of some/every/none`);
    const [mode] = keys;
    if (mode === 'some') return related.some((candidate) => matchesWhere(relation.model, candidate, spec.some));
    if (mode === 'every') return related.every((candidate) => matchesWhere(relation.model, candidate, spec.every));
    if (mode === 'none') return !related.some((candidate) => matchesWhere(relation.model, candidate, spec.none));
    throw new Error(`plan-reference-db: unsupported to-many filter "${String(mode)}"`);
  }

  function matchesField(model: ModelName, field: string, actual: unknown, condition: unknown): boolean {
    if (condition === null) return actual === null || actual === undefined;
    if (condition instanceof Date) return actual instanceof Date && actual.getTime() === condition.getTime();
    if (typeof condition !== 'object' || Array.isArray(condition)) return actual === condition;
    const ops = condition as Record<string, unknown>;
    if ('path' in ops) {
      const { path, equals, ...rest } = ops;
      if (Object.keys(rest).length > 0 || !Array.isArray(path)) {
        throw new Error(`plan-reference-db: JSON filter on ${model}.${field} supports path+equals only`);
      }
      let value: unknown = actual;
      for (const segment of path as string[]) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
        value = (value as Record<string, unknown>)[segment];
      }
      return value !== undefined && value === equals;
    }
    for (const [op, expected] of Object.entries(ops)) {
      switch (op) {
        case 'equals':
          if (!matchesField(model, field, actual, expected)) return false;
          break;
        case 'not':
          if (expected === null) {
            if (actual === null || actual === undefined) return false;
          } else if (actual === null || actual === undefined || isEqual(actual, expected)) {
            // SQL: `col <> v` is never true for a NULL column.
            return false;
          }
          break;
        case 'in':
          if (!Array.isArray(expected)) throw new Error('plan-reference-db: `in` needs an array');
          if (actual === null || actual === undefined || !expected.some((value) => isEqual(actual, value))) return false;
          break;
        case 'notIn':
          if (!Array.isArray(expected)) throw new Error('plan-reference-db: `notIn` needs an array');
          if (actual === null || actual === undefined || expected.some((value) => isEqual(actual, value))) return false;
          break;
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte': {
          if (actual === null || actual === undefined) return false;
          const left = actual instanceof Date ? actual.getTime() : (actual as number);
          const right = expected instanceof Date ? expected.getTime() : (expected as number);
          if (op === 'gt' && !(left > right)) return false;
          if (op === 'gte' && !(left >= right)) return false;
          if (op === 'lt' && !(left < right)) return false;
          if (op === 'lte' && !(left <= right)) return false;
          break;
        }
        case 'has':
          if (!Array.isArray(actual) || !actual.includes(expected)) return false;
          break;
        case 'hasSome':
          if (!Array.isArray(actual) || !Array.isArray(expected)) throw new Error('plan-reference-db: hasSome needs arrays');
          if (!expected.some((value) => actual.includes(value))) return false;
          break;
        default:
          throw new Error(`plan-reference-db: unsupported operator "${op}" on ${model}.${field}`);
      }
    }
    return true;
  }

  function project(row: Row, select: unknown): Row {
    if (select === undefined) return { ...row };
    const out: Row = {};
    for (const [key, wanted] of Object.entries(select as Record<string, unknown>)) {
      if (wanted !== true) throw new Error(`plan-reference-db: nested select "${key}" is not modelled`);
      if (!(key in row)) throw new Error(`plan-reference-db: select of missing field "${key}"`);
      out[key] = row[key];
    }
    return out;
  }

  function sortRows(rows: Row[], orderBy: unknown): Row[] {
    if (orderBy === undefined) return rows;
    const clauses = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Record<string, 'asc' | 'desc'>[];
    return [...rows].sort((left, right) => {
      for (const clause of clauses) {
        const [field, direction] = Object.entries(clause)[0]!;
        const a = left[field] instanceof Date ? (left[field] as Date).getTime() : (left[field] as number | string);
        const b = right[field] instanceof Date ? (right[field] as Date).getTime() : (right[field] as number | string);
        if (a === b) continue;
        const order = a < b ? -1 : 1;
        return direction === 'desc' ? -order : order;
      }
      return 0;
    });
  }

  function applyData(model: ModelName, row: Row, data: Row): void {
    for (const [key, value] of Object.entries(data)) {
      // Prisma ignores an `undefined` field in `data`; so does this.
      if (value === undefined) continue;
      // Durations are delete-and-recreate on every plan update; this database
      // does not model the durations table, so the nested write is accepted
      // and the row keeps what it had.
      if (model === 'plan' && key === 'durations') continue;
      if (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        !(value instanceof Date) &&
        Object.keys(value).some((op) => WRITE_OPERATORS.has(op))
      ) {
        throw new Error(`plan-reference-db: write operator in "${key}" on ${model} is not modelled`);
      }
      row[key] = Array.isArray(value) ? [...value] : value;
    }
  }

  function delegate(model: ModelName) {
    const table = () => tables[model];
    return {
      findMany: async (args: { where?: unknown; select?: unknown; orderBy?: unknown; distinct?: string[]; take?: number } = {}) => {
        calls.push(`${model}.findMany`);
        fail(`${model}.findMany`);
        let rows = sortRows(table().filter((row) => matchesWhere(model, row, args.where)), args.orderBy);
        if (args.distinct !== undefined) {
          const seen = new Set<string>();
          rows = rows.filter((row) => {
            const key = JSON.stringify(args.distinct!.map((field) => row[field]));
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
        if (args.take !== undefined) rows = rows.slice(0, args.take);
        return rows.map((row) => project(row, args.select));
      },
      findFirst: async (args: { where?: unknown; select?: unknown; orderBy?: unknown } = {}) => {
        calls.push(`${model}.findFirst`);
        fail(`${model}.findFirst`);
        const row = sortRows(table().filter((candidate) => matchesWhere(model, candidate, args.where)), args.orderBy)[0];
        return row === undefined ? null : project(row, args.select);
      },
      findUnique: async (args: { where: unknown; select?: unknown }) => {
        calls.push(`${model}.findUnique`);
        fail(`${model}.findUnique`);
        const matched = table().filter((candidate) => matchesWhere(model, candidate, args.where));
        if (matched.length > 1) throw new Error(`plan-reference-db: findUnique on ${model} matched ${matched.length} rows`);
        return matched[0] === undefined ? null : project(matched[0], args.select);
      },
      findUniqueOrThrow: async (args: { where: unknown; select?: unknown }) => {
        calls.push(`${model}.findUniqueOrThrow`);
        fail(`${model}.findUniqueOrThrow`);
        const matched = table().filter((candidate) => matchesWhere(model, candidate, args.where));
        if (matched.length !== 1) throw new Error(`plan-reference-db: findUniqueOrThrow on ${model} matched ${matched.length} rows`);
        return project(matched[0]!, args.select);
      },
      count: async (args: { where?: unknown } = {}) => {
        calls.push(`${model}.count`);
        fail(`${model}.count`);
        return table().filter((row) => matchesWhere(model, row, args.where)).length;
      },
      groupBy: async (args: { by: string[]; where?: unknown; _count?: { _all?: boolean } }) => {
        calls.push(`${model}.groupBy`);
        fail(`${model}.groupBy`);
        if (args._count?._all !== true) throw new Error('plan-reference-db: groupBy models `_count: { _all: true }` only');
        const groups = new Map<string, { row: Row; count: number }>();
        for (const row of table().filter((candidate) => matchesWhere(model, candidate, args.where))) {
          const key = JSON.stringify(args.by.map((field) => row[field]));
          const group = groups.get(key) ?? { row, count: 0 };
          group.count += 1;
          groups.set(key, group);
        }
        return [...groups.values()].map(({ row, count }) => ({
          ...Object.fromEntries(args.by.map((field) => [field, row[field]])),
          _count: { _all: count },
        }));
      },
      create: async (args: { data: Row }) => {
        calls.push(`${model}.create`);
        fail(`${model}.create`);
        const { durations: _durations, adminUser, ...data } = args.data as Row & { durations?: unknown; adminUser?: unknown };
        const base = model === 'plan' ? planRow({ id: nextId(model) }) : { id: nextId(model) };
        const row: Row = { ...base, ...data };
        if (adminUser !== undefined) row.adminUser = adminUser;
        table().push(row);
        return { ...row };
      },
      update: async (args: { where: { id: string }; data: Row }) => {
        calls.push(`${model}.update`);
        fail(`${model}.update`);
        const row = table().find((candidate) => matchesWhere(model, candidate, args.where));
        if (row === undefined) throw new Error(`plan-reference-db: ${model}.update found no row for ${JSON.stringify(args.where)}`);
        applyData(model, row, args.data);
        return { ...row };
      },
      updateMany: async (args: { where?: unknown; data: Row }) => {
        calls.push(`${model}.updateMany`);
        fail(`${model}.updateMany`);
        const rows = table().filter((row) => matchesWhere(model, row, args.where));
        for (const row of rows) applyData(model, row, args.data);
        return { count: rows.length };
      },
      delete: async (args: { where: unknown }) => {
        calls.push(`${model}.delete`);
        fail(`${model}.delete`);
        const index = table().findIndex((row) => matchesWhere(model, row, args.where));
        if (index < 0) throw new Error(`plan-reference-db: ${model}.delete found no row`);
        const [removed] = table().splice(index, 1);
        return removed;
      },
      deleteMany: async (args: { where?: unknown } = {}) => {
        calls.push(`${model}.deleteMany`);
        fail(`${model}.deleteMany`);
        const keep = table().filter((row) => !matchesWhere(model, row, args.where));
        const count = table().length - keep.length;
        // In place, so an array a spec captured before the call stays current.
        table().splice(0, table().length, ...keep);
        return { count };
      },
    };
  }

  /** The raw statements the deletion code sends, recognised by their text. */
  function runRaw(kind: '$queryRaw' | '$executeRaw', sql: unknown): unknown {
    // `Prisma.Sql` is a type only at runtime in Prisma 7; the object `Prisma.sql`
    // builds carries `strings` and `values`, which is all this reads.
    const statement = sql as { readonly strings?: unknown; readonly values?: unknown };
    if (!Array.isArray(statement.strings) || !Array.isArray(statement.values)) {
      throw new Error(`plan-reference-db: ${kind} expects a Prisma.sql template, got ${typeof sql}`);
    }
    const text = (statement.strings as string[]).join('?').replace(/\s+/g, ' ');
    const values = statement.values as unknown[];
    if (kind === '$queryRaw' && /FROM "plans" WHERE "id" = \? FOR UPDATE/.test(text)) {
      calls.push('$queryRaw:lock-plan');
      const row = tables.plan.find((candidate) => candidate.id === values[0]);
      return row === undefined
        ? []
        : [{ id: row.id, name: row.name, deletedAt: row.deletedAt, isActive: row.isActive, isArchived: row.isArchived }];
    }
    if (kind === '$queryRaw' && /FROM "plans" WHERE "id" IN \(.*\) ORDER BY "id" FOR UPDATE/.test(text)) {
      calls.push('$queryRaw:lock-plans');
      return tables.plan.filter((candidate) => values.includes(candidate.id)).map((row) => ({ id: row.id }));
    }
    if (kind === '$executeRaw' && /array_remove\("upgrade_to_plan_ids"/.test(text) && /array_remove\("replacement_plan_ids"/.test(text)) {
      calls.push('$executeRaw:strip-transitions');
      const planId = values[0];
      if (values.some((value) => value !== planId)) {
        throw new Error('plan-reference-db: the strip statement is expected to bind only the deleted plan id');
      }
      let changed = 0;
      for (const row of tables.plan) {
        if (row.id === planId) continue;
        const upgrade = row.upgradeToPlanIds as string[];
        const replacement = row.replacementPlanIds as string[];
        if (!upgrade.includes(planId as string) && !replacement.includes(planId as string)) continue;
        row.upgradeToPlanIds = upgrade.filter((id) => id !== planId);
        row.replacementPlanIds = replacement.filter((id) => id !== planId);
        changed += 1;
      }
      return changed;
    }
    throw new Error(`plan-reference-db: unrecognised ${kind}: ${text}`);
  }

  const client = {
    plan: delegate('plan'),
    subscription: delegate('subscription'),
    subscriptionTerm: delegate('subscriptionTerm'),
    transaction: delegate('transaction'),
    transactionItem: delegate('transactionItem'),
    trialClaim: delegate('trialClaim'),
    promocode: delegate('promocode'),
    promocodeAction: delegate('promocodeAction'),
    quest: delegate('quest'),
    contest: delegate('contest'),
    contestPrize: delegate('contestPrize'),
    wheelSector: delegate('wheelSector'),
    addOn: delegate('addOn'),
    adPlacement: delegate('adPlacement'),
    settings: delegate('settings'),
    adminAuditLog: delegate('adminAuditLog'),
    $queryRaw: async (sql: unknown) => runRaw('$queryRaw', sql),
    $executeRaw: async (sql: unknown) => runRaw('$executeRaw', sql),
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      transactions += 1;
      return fn(client);
    },
  };

  return {
    client,
    tables,
    calls,
    get transactions() {
      return transactions;
    },
    plan: (id: string): Row | undefined => tables.plan.find((row) => row.id === id),
    /** Visible (not soft-deleted) plans as `id@orderIndex`, in on-screen order. */
    visibleOrder: (): string =>
      sortRows(
        tables.plan.filter((row) => row.deletedAt === null),
        [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
      )
        .map((row) => `${String(row.id)}@${String(row.orderIndex)}`)
        .join(' '),
  };
}

export type PlanReferenceDb = ReturnType<typeof buildPlanReferenceDb>;

function copyRows(rows: readonly Row[] | undefined): Row[] {
  return (rows ?? []).map((row) => ({ ...row }));
}

function isEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  return left === right;
}
