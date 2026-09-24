/**
 * stealthnet-catalog-id.util
 * ──────────────────────────
 * How a STEALTHNET id (a CUID) is named in the donor catalog the plan cloner
 * reads. The one spelling for both halves of a STEALTHNET import: the catalog
 * the importer writes (`mapTariffToPlanRow`, the durations and prices), and the
 * cloner reading a subscription's tariff back to link it to a clone.
 */

/**
 * Deterministic 31-bit hash of a CUID-like string. Used to fabricate
 * integer source-plan ids that the cloner's catalog expects. Two
 * CUIDs colliding would degrade the user experience (clone preview
 * shows the wrong subscription count) but never corrupts data — the
 * cloner identifies real plans through the catalog payload, never
 * through these synthetic ids beyond Map lookups.
 */
export function stableHashId(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * The catalog plan id of the STEALTHNET tariff a subscription's snapshot names
 * — `originalPlanSnapshot.id`, else `sourceTariffId`, as the importer stored
 * them: the raw tariff id, hashed here exactly as the catalog row was. `null`
 * when the snapshot names no tariff.
 *
 * The raw id is a CUID, so reading it as a number (`Number(id)`, as the other
 * donors' integer ids are read) gave `NaN` for every STEALTHNET subscription,
 * and «Привязать импортированные подписки к клонам» linked none of them.
 */
export function stealthnetCatalogPlanIdOf(snapshot: Readonly<Record<string, unknown>>): number | null {
  const original = snapshot['originalPlanSnapshot'];
  const fromOriginal =
    typeof original === 'object' && original !== null && !Array.isArray(original)
      ? (original as Record<string, unknown>)['id']
      : undefined;
  const tariffId = fromOriginal ?? snapshot['sourceTariffId'];
  if (typeof tariffId === 'string' && tariffId.length > 0) return stableHashId(tariffId);
  return null;
}
