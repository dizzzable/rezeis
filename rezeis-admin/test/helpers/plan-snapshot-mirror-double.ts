import assert from 'node:assert/strict';

/**
 * A double of the ONE statement `PlanSnapshotSyncService.syncPlanSnapshotMetadata`
 * runs (review R3a-01): it updates the rows whose `plan_snapshot->>'<key>'` is
 * the plan, merging `jsonb_build_object('<k1>', $1, '<k2>', $2, …)` into the
 * stored JSON, and returns each row's id, the reset rule it named before, and
 * its status.
 *
 * Everything is read OUT OF THE STATEMENT — the key it selects on, the keys it
 * merges and the values it binds, in the order it binds them (the selected
 * plan id first) — so a statement that selected on another key, or merged a
 * key it must not (a frozen limit, the icon), is emulated doing exactly that,
 * and the spec using this double sees it.
 */
export interface MirroredRow {
  readonly id: string;
  planSnapshot: Record<string, unknown>;
  readonly status?: string;
}

export function emulatePlanSnapshotMirror(
  query: { readonly strings?: readonly string[]; readonly values?: readonly unknown[] },
  rows: MirroredRow[],
): Array<{ id: string; previousStrategy: unknown; status: string }> {
  const text = (query.strings ?? []).join('?');
  assert.match(text, /UPDATE "subscriptions"/, 'the mirror is one UPDATE of the subscriptions');
  const selectedOn = /WHERE\s+"plan_snapshot"->>'([^']+)'\s*=\s*\?/.exec(text)?.[1];
  assert.ok(selectedOn !== undefined, 'the mirror selects subscribers by a plan_snapshot JSON key');
  const merged = /jsonb_build_object\(([\s\S]*?)\)\s*,/.exec(text)?.[1];
  assert.ok(merged !== undefined, 'the mirror merges one jsonb_build_object into the stored snapshot');
  const keys = Array.from(merged.matchAll(/'([^']+)'/g), (match) => match[1]!);
  const [wanted, ...bound] = query.values ?? [];
  const matched = rows.filter((row) => row.planSnapshot[selectedOn] === wanted);
  return matched.map((row) => {
    const previousStrategy = row.planSnapshot['trafficLimitStrategy'] ?? null;
    const patch = Object.fromEntries(keys.map((key, index) => [key, bound[index] ?? null]));
    row.planSnapshot = { ...row.planSnapshot, ...patch };
    return { id: row.id, previousStrategy, status: row.status ?? 'ACTIVE' };
  });
}
