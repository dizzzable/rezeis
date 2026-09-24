import { SubscriptionStatus } from '@prisma/client';

import { PANEL_LINK_POPULATION_SQL } from '../../src/modules/profile-sync/panel-link-reconciliation.service';

/**
 * The panel-link walk's page statement, answered by the unit specs' fake
 * databases.
 *
 * The walk selects its rows with raw SQL (a regular expression: "not a
 * decimal"), so a fake that evaluates Prisma `where` objects cannot answer it.
 * This restates the population in JavaScript for those fakes. It is a mirror,
 * and a mirror cannot prove the SQL: `test/panel-link-check-postgres.spec.ts`
 * runs the real statement on PostgreSQL against every kind of row.
 *
 * What a mirror CAN hold is that the service reads the one spelling of the
 * population: a page statement that does not carry
 * {@link PANEL_LINK_POPULATION_SQL} verbatim is refused here, so a walk that
 * grew its own copy of the predicate fails every unit spec that walks.
 */

/** Whether a row belongs to the population, the JavaScript mirror of the SQL. */
export function inPanelLinkPopulation(row: Record<string, unknown>): boolean {
  if (row['status'] === SubscriptionStatus.DELETED) return false;
  const identity = row['remnawaveId'];
  if (identity === null || identity === undefined) {
    return (
      row['remnawavePanelUsername'] !== null &&
      row['remnawavePanelUsername'] !== undefined &&
      row['configUrl'] !== null &&
      row['configUrl'] !== undefined
    );
  }
  return typeof identity === 'string' && !/^[0-9]+$/.test(identity);
}

interface SqlLike {
  readonly text?: unknown;
  readonly values?: unknown;
}

function textOf(query: unknown): string {
  const text = (query as SqlLike | null)?.text;
  return typeof text === 'string' ? text : '';
}

/** Whether `query` is the walk's page statement rather than some other raw read. */
export function isPanelLinkWalkPage(query: unknown): boolean {
  const text = textOf(query);
  return text.includes('FROM "subscriptions"') && text.includes('"config_url" AS "configUrl"');
}

/**
 * The page the statement asks for: population, `id > cursor` when the
 * statement has a cursor, ordered by id, `LIMIT` from its last parameter.
 */
export function answerPanelLinkWalkPage(
  table: ReadonlyArray<Record<string, unknown>>,
  query: unknown,
): Array<Record<string, unknown>> {
  const text = textOf(query);
  if (!text.includes(PANEL_LINK_POPULATION_SQL.text)) {
    throw new Error('the walk page statement does not read PANEL_LINK_POPULATION_SQL');
  }
  if (!/ORDER BY "id" ASC/.test(text)) {
    throw new Error('the walk page statement is not ordered by id');
  }
  const values = (query as SqlLike).values;
  const parameters = Array.isArray(values) ? values : [];
  const take = parameters[parameters.length - 1];
  if (typeof take !== 'number') throw new Error('the walk page statement has no numeric LIMIT');
  const cursor = /"id" > \$1/.test(text) ? String(parameters[0]) : null;
  return table
    .filter((row) => inPanelLinkPopulation(row))
    .filter((row) => cursor === null || String(row['id']) > cursor)
    .sort((left, right) => (String(left['id']) < String(right['id']) ? -1 : String(left['id']) > String(right['id']) ? 1 : 0))
    .slice(0, take)
    .map((row) => ({
      id: row['id'],
      userId: row['userId'],
      remnawaveId: row['remnawaveId'] ?? null,
      remnawavePanelUsername: row['remnawavePanelUsername'] ?? null,
      configUrl: row['configUrl'] ?? null,
    }));
}
