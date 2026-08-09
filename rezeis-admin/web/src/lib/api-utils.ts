/**
 * API response shape helpers.
 *
 * Some endpoints in the admin backend wrap responses in `{ data: ... }`,
 * others return the payload directly. This module centralises the
 * defensive unwrap so feature-level API modules don't keep re-implementing
 * the same isRecord / "is this wrapped?" logic.
 *
 * Four call patterns:
 *   - `isRecord(value)` — type guard for plain objects (excludes arrays).
 *   - `unwrapPayload(value)` — accepts a record OR wraps with `data`,
 *     returns the inner record / array. Throws if neither shape matches.
 *   - `unwrapPayloadOrArray(value)` — same, but also passes arrays
 *     straight through (used by list endpoints).
 *   - `expectArray(value)` — asserts the value really is an array before a
 *     consumer calls `.map` on it.
 *
 * WHY THESE THROW. `isRecord` / `unwrapPayload` / `unwrapPayloadOrArray` are
 * used by a small cluster of modules that pipe the unwrapped value straight
 * into a zod schema; there, the throw is redundant belt-and-braces and the
 * schema produces the readable message. That is a convention of those
 * modules, NOT a project-wide contract — most feature API modules never
 * import this file, and `expectArray` exists precisely for them: it is the
 * only validation in the path, so its throw is load-bearing.
 *
 * Throwing rather than degrading to `[]` is the deliberate choice in both
 * cases. A silent empty list is a confident false statement — the operator
 * reads "no squads" / "no icons" and concludes their infrastructure is
 * empty. A throw reaches an error boundary, or better, an `isError` branch
 * that says "unavailable" out loud.
 */

const UNEXPECTED_PAYLOAD_KEY = 'errors.unexpectedResponsePayload'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Asserts that a value really is an array and hands it back at the element
 * type the caller claims.
 *
 * `api.get<T[]>(url)` is an assertion, not a check — axios never verifies it,
 * so `{}`, `{ data: [...] }`, or an HTML error page served with HTTP 200 all
 * reach the component typed as `T[]` and blow up at the first `.map` inside
 * render. The HTML case is the nasty one: a string has a perfectly working
 * `.length`, so it walks past every `length === 0` guard before dying.
 *
 * The element type is NOT checked — `expectArray<Plan>` proves the container
 * and nothing about what is in it. Reach for a `z.array(schema)` instead when
 * the consumer reads nested fields off the elements.
 */
export function expectArray<T>(value: unknown): T[] {
  if (!Array.isArray(value)) {
    throw new Error(UNEXPECTED_PAYLOAD_KEY)
  }
  return value as T[]
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
