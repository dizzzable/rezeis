/**
 * A `subscription.findMany` double that actually HONOURS its `where`.
 *
 * WHY THIS EXISTS. Both anti-fraud detector specs used to stub the query as
 * `findMany: () => Promise.resolve(subs)` — the row list came back whatever was
 * asked for. Under that stub a lookup that matches one column and a lookup that
 * matches two are the same green, which is precisely how the panel-identity
 * defect shipped: on a 3.x panel the detectors asked `remnawaveId IN (<3.x
 * decimals>)` while every subscription linked during the 2.x era stores a uuid
 * there, so the match missed that whole population and no test could see it.
 *
 * WHAT IT MODELS. Only the shapes these two call sites send — `remnawaveId`,
 * `remnawavePanelId`, `in`, and a top-level `OR` — and it THROWS on anything
 * else rather than quietly matching, so a future `where` this evaluator cannot
 * read fails loudly instead of silently degrading back into "returns
 * everything".
 *
 * IT MODELS THE DANGEROUS SPELLINGS ON PURPOSE. `remnawavePanelId: null` and an
 * `in` list carrying a null/undefined both match EVERY row that has no panel
 * id here, the way `IS NULL` does in Postgres. `remnawave_panel_id` has no
 * unique constraint and is null on most rows (migration `20260810160000`
 * records why one could not be added to live data), so that is the catastrophic
 * widening an anti-fraud detector must never send — and a guard that proves
 * unrelated subscriptions are not matched is worth nothing if the double is
 * incapable of matching them.
 */

/** The two columns that name a Remnawave profile locally. */
export interface PanelIdentityRow {
  readonly remnawaveId?: string | null;
  readonly remnawavePanelId?: number | null;
}

/** One recorded call: what was asked, and which rows answered. */
export interface SubscriptionQuery<TRow> {
  readonly where: unknown;
  readonly matched: readonly TRow[];
}

const SUPPORTED_FIELDS = ['remnawaveId', 'remnawavePanelId'] as const;

type SupportedField = (typeof SUPPORTED_FIELDS)[number];

function columnOf<TRow extends PanelIdentityRow>(row: TRow, field: SupportedField): unknown {
  const value = field === 'remnawaveId' ? row.remnawaveId : row.remnawavePanelId;
  return value === undefined ? null : value;
}

function matchesCondition(actual: unknown, condition: unknown): boolean {
  // Prisma renders `column: null` as `IS NULL` — the widening this guard exists
  // to catch, so it is modelled rather than rejected.
  if (condition === null || condition === undefined) return actual === null;
  if (typeof condition === 'object') {
    const list = (condition as { in?: unknown }).in;
    if (!Array.isArray(list)) {
      throw new Error(
        `subscription-where: only \`in\` is modelled, got ${JSON.stringify(condition)}`,
      );
    }
    return list.some((value) =>
      value === null || value === undefined ? actual === null : value === actual,
    );
  }
  return condition === actual;
}

export function matchesSubscriptionWhere<TRow extends PanelIdentityRow>(
  row: TRow,
  where: unknown,
): boolean {
  if (where === null || typeof where !== 'object') {
    throw new Error(`subscription-where: unsupported where ${JSON.stringify(where)}`);
  }
  return Object.entries(where as Record<string, unknown>).every(([key, condition]) => {
    if (key === 'OR') {
      if (!Array.isArray(condition)) {
        throw new Error('subscription-where: OR must be an array');
      }
      // An empty OR matches nothing in Prisma; keep that rather than inventing
      // a friendlier answer.
      return condition.some((arm) => matchesSubscriptionWhere(row, arm));
    }
    if (!(SUPPORTED_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`subscription-where: unsupported field \`${key}\``);
    }
    return matchesCondition(columnOf(row, key as SupportedField), condition);
  });
}

/**
 * Builds the `findMany` stub plus the log of what it was asked and what it
 * answered. The log is the assertion surface: "which subscriptions did this
 * batch actually select" is the question the widening defect turns into "all of
 * them".
 */
export function subscriptionFindManyDouble<TRow extends PanelIdentityRow>(
  rows: readonly TRow[],
): {
  readonly findMany: (args?: { where?: unknown }) => Promise<TRow[]>;
  readonly queries: readonly SubscriptionQuery<TRow>[];
} {
  const queries: SubscriptionQuery<TRow>[] = [];
  return {
    queries,
    findMany: (args?: { where?: unknown }): Promise<TRow[]> => {
      const where = args?.where;
      // A call with no `where` at all is a full-table read; it is never what
      // these detectors mean, so it fails rather than returning everything.
      if (where === undefined) {
        throw new Error('subscription-where: findMany called without a `where`');
      }
      const matched = rows.filter((row) => matchesSubscriptionWhere(row, where));
      queries.push({ where, matched });
      return Promise.resolve(matched);
    },
  };
}
