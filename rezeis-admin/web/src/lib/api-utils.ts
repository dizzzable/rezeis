/**
 * API response shape helpers.
 *
 * Some endpoints in the admin backend wrap responses in `{ data: ... }`,
 * others return the payload directly. This module centralises the
 * defensive unwrap so feature-level API modules don't keep re-implementing
 * the same isRecord / "is this wrapped?" logic.
 *
 * Three call patterns:
 *   - `isRecord(value)` — type guard for plain objects (excludes arrays).
 *   - `unwrapPayload(value)` — accepts a record OR wraps with `data`,
 *     returns the inner record / array. Throws if neither shape matches.
 *   - `unwrapPayloadOrArray(value)` — same, but also passes arrays
 *     straight through (used by list endpoints).
 *
 * Throwing on mismatch is intentional: every call site has a zod schema
 * waiting downstream, and a parse error message is more useful than
 * undefined-property runtime errors.
 */

const UNEXPECTED_PAYLOAD_KEY = 'errors.unexpectedResponsePayload'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Returns the unwrapped record. If the value is `{ data: <record> }`,
 * returns the inner record; otherwise returns the value itself when it
 * is already a record. Throws otherwise.
 */
export function unwrapPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(UNEXPECTED_PAYLOAD_KEY)
  }
  if ('data' in value && isRecord(value.data)) {
    return value.data
  }
  return value
}

/**
 * Same as {@link unwrapPayload} but tolerates list responses. Returns
 * either the inner record or an array depending on what the server
 * actually sent. Useful for endpoints that return lists or objects
 * depending on filters.
 */
export function unwrapPayloadOrArray(
  value: unknown,
): Record<string, unknown> | unknown[] {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) {
    throw new Error(UNEXPECTED_PAYLOAD_KEY)
  }
  if ('data' in value) {
    const inner = value.data
    if (Array.isArray(inner)) return inner
    if (isRecord(inner)) return inner
  }
  return value
}
