/**
 * The two things the vendor response parse did that a caller depended on
 * ═════════════════════════════════════════════════════════════════════════
 * `PanelCommandExecutor` used to run every panel answer through a pinned
 * vendor schema. On an answer the schema accepted, that parse changed the data
 * in exactly two ways — it turned datetime strings into `Date` objects, and it
 * stripped every key the schema did not declare. It had no defaults, coercions
 * or other transforms on any of the responses rezeis reads.
 *
 * The parse is gone. An audit of every production reader of every response
 * found that almost all of them read the raw JSON identically — they already
 * had to, because an answer the schema refused was handed back raw. Five reads
 * did not, and each is served by one of the two helpers below, applied by the
 * client that owns the read and to that field only:
 *
 *   • {@link decodePanelInstant} — the `lastSeen` of both connection jobs and the
 *     `requestAt` of the subscription request log. Their readers keep a string
 *     as the panel's own characters but re-render a `Date` through
 *     `toISOString()`, and the result is persisted in fraud-signal metadata and
 *     served by the live-IP drilldown. Without the decode those strings would
 *     change representation whenever a panel's own formatting differs.
 *   • {@link projectDeclaredKeys} — the HWID stats `byPlatform` rows, which an
 *     operational alert copies WHOLE into its metadata, and the device rows of
 *     the inventory walk, whose export reads `lastSeenAt ?? updatedAt` although
 *     no 3.x release declares `lastSeenAt`.
 *
 * On every answer the vendor schema accepted, these produce exactly what the
 * parse produced for those fields: the same `new Date(value)`, the same keys in
 * the same order. On an answer it refused — returned raw, before — they still
 * normalise what is well-formed and still drop what is undeclared, so the only
 * difference there is the representation of a timestamp string or the absence
 * of an undeclared key, never an instant or a count.
 *
 * TOLERANT, like every decoder in this directory: neither helper ever refuses.
 * A value they cannot improve is handed back exactly as it arrived, so a
 * reader's own "unreadable timestamp" and "not an object" branches still see it.
 */

/**
 * An ISO-8601 date-time, with or without seconds, fraction, `Z` or an offset —
 * the shapes `z.iso.datetime({ local: true, offset: true })` accepted in every
 * contract the fleet's panels ship. A bare date is NOT a date-time and is left
 * alone.
 */
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/;

/**
 * A panel timestamp as the `Date` the vendor parse used to produce, when it is a
 * well-formed date-time; otherwise the value exactly as the panel sent it.
 *
 * `new Date(value)` and not a re-implementation, because that IS what the vendor
 * schema's transform did — including reading a zone-less date-time as local
 * time, which is also what `Date.parse` does for the readers that never saw a
 * `Date` at all.
 */
export function decodePanelInstant(value: unknown): unknown {
  if (typeof value !== 'string' || !ISO_DATETIME.test(value)) return value;
  const decoded = new Date(value);
  return Number.isNaN(decoded.getTime()) ? value : decoded;
}

/**
 * `value` reduced to `keys`, in the order `keys` lists them, copying only keys
 * that are present — what zod's default object parse emitted for a declared
 * shape. Anything that is not a plain object is handed back unchanged.
 */
export function projectDeclaredKeys(value: unknown, keys: readonly string[]): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) projected[key] = record[key];
  }
  return projected;
}
