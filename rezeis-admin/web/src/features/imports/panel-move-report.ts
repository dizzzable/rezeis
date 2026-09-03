/**
 * The run's verdict about WHICH Remnawave panel the imported customers were on.
 *
 * Its own module rather than a second export from the dialog: a component file
 * that also exports helpers loses fast refresh, and this one has a test of its
 * own because it is a contract between two separately shipped images.
 */

/** What the notice needs. Null whenever there is nothing to say. */
export interface PanelMoveReport {
  readonly profilesToCreate: number
}

/**
 * Only `different` is news: it means every migrated subscription is waiting for
 * a profile this panel has yet to create, and therefore for a new connection
 * link. Any other verdict — and the five importers that report none at all —
 * is the ordinary case and says nothing worth a block on the screen.
 */
export function panelMoveField(record: Record<string, unknown>): PanelMoveReport | null {
  const raw = record['panelRelationship']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const report = raw as Record<string, unknown>
  if (report['verdict'] !== 'different') return null
  const count = report['profilesToCreate']
  return {
    profilesToCreate: typeof count === 'number' && Number.isFinite(count) ? count : 0,
  }
}
