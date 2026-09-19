/**
 * A `webhook_post` action's `authorizationHeader` is write-only.
 *
 * No rule read returns it. In its place the panel sends a reference — what
 * `automations.service.ts` calls a `SavedHeaderReference`:
 * `{ "stored": true, "index": <the action's place in the SAVED rule> }` — and a
 * save reads what comes back:
 *
 *   the reference, unchanged   keep the saved header;
 *   a string                   replace it;
 *   null, "" or nothing        remove it.
 *
 * So the editor never holds the value, and cannot send a mask back as one: the
 * reference is not a string, and the panel resolves it against the saved row or
 * refuses it. A kept header is also bound to the exact saved URL and to the
 * place of the action it came from — see `urlChanged` and `referenceShifted`.
 */
export interface SavedHeaderReference {
  readonly stored: true
  readonly index: number
}

export const HEADER_PARAM = 'authorizationHeader'

export function isSavedHeaderReference(value: unknown): value is SavedHeaderReference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record['stored'] === true &&
    typeof record['index'] === 'number' &&
    Number.isInteger(record['index']) &&
    record['index'] >= 0
  )
}

/**
 * Set on a webhook action by the panel when this reader may not see its URL
 * whole: the URL is then its origin and "…", and `urlHidden` is a reference to
 * the action's place in the saved rule — the same shape a saved header gets.
 *
 * «Сохранить» sends the reference back WITHOUT the URL (`actionsForSave`), and
 * the panel keeps the saved URL for that action or refuses: the mask is a valid
 * URL, and sent as one it used to replace the real URL. The reference holds only
 * while the URL in the params box is the one the panel sent — a URL typed in
 * its place is a new URL, sent as typed and without the reference.
 *
 * An editor meets one when their role gained the rights after the page loaded
 * the rule; a reader without them cannot save the action at all.
 */
export const URL_HIDDEN_PARAM = 'urlHidden'

/** The params without the header and the hidden-URL flag — what the JSON box shows and edits. */
export function paramsWithoutHeader(params: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(params ?? {}) }
  delete out[HEADER_PARAM]
  delete out[URL_HIDDEN_PARAM]
  return out
}

/** Whether the panel sent this action's URL as its origin only, with the reference that keeps it. */
export function isUrlHidden(params: Readonly<Record<string, unknown>> | undefined): boolean {
  return isSavedHeaderReference(params?.[URL_HIDDEN_PARAM])
}

/**
 * Params typed into the JSON box, with the header the field below holds put
 * back. A string typed into the box itself is an explicit new value and wins;
 * anything else there is dropped, so the box can neither show nor forge the
 * reference. The hidden-URL reference comes back the same way, and only while
 * the URL in the box is still the one the panel sent.
 */
export function paramsWithHeaderKept(
  typed: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const out = paramsWithoutHeader(typed)
  if (isUrlHidden(current) && typed['url'] === current?.['url']) out[URL_HIDDEN_PARAM] = current?.[URL_HIDDEN_PARAM]
  const typedHeader = typed[HEADER_PARAM]
  if (typeof typedHeader === 'string') return { ...out, [HEADER_PARAM]: typedHeader }
  const held = current?.[HEADER_PARAM]
  return held === undefined ? out : { ...out, [HEADER_PARAM]: held }
}

/**
 * The actions as «Сохранить» sends them: one that keeps a hidden URL sends its
 * reference and no URL — never the mask shown in its place, which the panel
 * would have to take for an address. The draft itself is left as it is.
 */
export function actionsForSave<T extends { readonly params: Readonly<Record<string, unknown>> }>(
  actions: readonly T[],
): T[] {
  return actions.map((action) => {
    if (!isUrlHidden(action.params)) return action
    const params: Record<string, unknown> = { ...action.params }
    delete params['url']
    return { ...action, params }
  })
}

/** The URL saved on the action a reference names, or undefined when it names none. */
export function savedUrlFor(
  header: unknown,
  savedActions: ReadonlyArray<{ readonly params?: Readonly<Record<string, unknown>> }>,
): unknown {
  return isSavedHeaderReference(header) ? savedActions[header.index]?.params?.['url'] : undefined
}

/**
 * A kept header whose URL is no longer, character for character, the saved
 * one. The panel refuses such a save — a header never follows its URL, not to
 * another host and not to another path — so the editor says so first.
 */
export function urlChanged(url: unknown, savedUrl: unknown): boolean {
  const now = typeof url === 'string' ? url.trim() : null
  const saved = typeof savedUrl === 'string' ? savedUrl.trim() : null
  return now !== saved
}

/**
 * A kept header that no longer sits where it was saved — an action above it
 * was removed. The panel keeps a header only for the action it came from.
 */
export function referenceShifted(header: unknown, position: number): boolean {
  return isSavedHeaderReference(header) && header.index !== position
}
