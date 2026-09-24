import { createHash } from 'node:crypto';

/**
 * The version of one settings group, computed the way the cabinet computes it
 * ═══════════════════════════════════════════════════════════════════════════
 * The cabinet holds a copy of each group the internal routes serve and polls
 * `POST /api/internal/config-versions` to learn whether its copy is still the
 * current one. It compares the versions served here with versions it computes
 * itself from the copy it holds — so both sides must compute the same function
 * of the same thing, and the only thing both sides see is the WIRE: what
 * `res.json` wrote and the cabinet's transport parsed back.
 *
 * Hence `JSON.stringify` first, exactly as Express does it (Dates become ISO
 * strings, `undefined` fields vanish, a BigInt goes through this process's
 * `toJSON`), then a canonical form with every object's keys sorted, so the
 * order a service happened to build an object in cannot make two equal answers
 * look different. SHA-256, first 32 hex digits.
 *
 * THE CABINET HAS A COPY OF THIS FILE
 * (`reiwa/src/infrastructure/config-versions/config-version.ts`). Both sides pin
 * the same test vector (`test/config-version-hash.spec.ts` here); change one and
 * its vector goes red before the two can disagree in production, where a
 * disagreement would read as "every group changed" on every poll — a re-read of
 * everything every twenty seconds, and a card after every save.
 */

/** A JSON value with every object's keys sorted. Arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // `undefined` inside an array is what `JSON.stringify` writes as `null`.
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** The version of a payload as the wire carries it. */
export function configVersionOf(payload: unknown): string {
  const wire: unknown = JSON.parse(JSON.stringify(payload) ?? 'null');
  return createHash('sha256').update(canonicalJson(wire), 'utf8').digest('hex').slice(0, 32);
}
