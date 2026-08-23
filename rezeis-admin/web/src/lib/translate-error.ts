import type { TFunction } from 'i18next'

/**
 * One lookup for server-authored error sentences, shared by every surface that
 * shows one.
 *
 * `AdminSafeExceptionFilter` puts a small set of hand-written English
 * sentences on the wire -- 'Invalid login or password', 'Admin user is
 * inactive' -- and both dictionaries carry the matching copy under
 * `errors.<sentence>`. That table has existed since the dictionaries were
 * written and nothing ever read it, on either of the two surfaces that show
 * these sentences:
 *
 *   - `features/auth/sign-in-page.tsx` rendered `response.data.message` raw.
 *   - this module looked the sentence up at the dictionary ROOT (`t(message)`),
 *     where the entries do not live, so every lookup missed and handed its
 *     input straight back.
 *
 * Both go through `translateServerSentence` now. One lookup rather than two is
 * the point: two ways to translate the same sentence is how the next one
 * drifts apart from the first.
 */
const SERVER_ERROR_PREFIX = 'errors.'

/**
 * `errors.<exact server sentence>`, or the sentence itself when the
 * dictionaries hold no entry for it.
 *
 * A miss must never leave the KEY on screen, and a bare `t(...)` does exactly
 * that: i18next answers an unresolved key by echoing it back, so an
 * unrecognised sentence would render as
 * "errors.Too many login attempts. Try again later." Comparing the answer
 * against the key is what catches it.
 *
 * A sentence containing a '.' cannot resolve at all, because i18next splits
 * keys on it. That is a fallback rather than a fault: those arrive as the
 * server's own words, which is what the operator would have seen anyway.
 */
export function translateServerSentence(t: TFunction, sentence: string): string {
  const key = `${SERVER_ERROR_PREFIX}${sentence}`
  const translated: string = t(key)
  return translated === key ? sentence : translated
}

/**
 * The same lookup over the two shapes the safe filter emits: one sentence, or
 * the `string[]` of a validation failure. Returns null when the body carried
 * no message at all, so each caller picks its own fallback.
 *
 * The array is joined rather than handed to React as a list, which would
 * concatenate the items with no separator at all.
 */
export function translateServerMessage(t: TFunction, message: unknown): string | null {
  if (Array.isArray(message)) {
    const parts = message
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .map((part) => translateServerSentence(t, part))
    return parts.length > 0 ? parts.join(' ') : null
  }
  if (typeof message !== 'string' || message.length === 0) return null
  return translateServerSentence(t, message)
}

/**
 * What to show an operator for a failed request, given the rejection itself.
 *
 * Prefer the SERVER's sentence, localized. Reaching for `error.message`
 * instead -- which is what this module's only caller passed in for as long as
 * it existed -- never yields one. An axios rejection's `.message` is transport
 * prose ('Request failed with status code 403', 'Network Error', 'timeout of
 * 30000ms exceeded'); a Zod rejection's is a JSON blob of issues; neither is a
 * dictionary key in any language, so the lookup could not have hit even at the
 * right prefix. The body underneath is where the panel's own words are.
 *
 * With no body there are three cases, and they are not the same:
 *
 *   - An AXIOS rejection that never got a response did not reach the server at
 *     all. "The server refused you" and "the server is not there" send the
 *     operator to different places -- permissions versus the network, the
 *     backend process, the reverse proxy -- so this is its own copy rather
 *     than the generic. Axios's own `.message` says the same thing in English
 *     jargon ('Network Error', 'timeout of 30000ms exceeded') and says it in
 *     every locale, which is what used to be on screen.
 *   - An axios rejection that DID get a response reached the server, which
 *     simply answered with nothing readable -- an HTML error page from a
 *     proxy, an empty body. That is a refusal, not an unreachable host, and it
 *     takes the generic.
 *   - Any other rejection carries a message somebody WROTE -- the permission
 *     store's 'Failed to load permissions', auth-api's 'Malformed auth
 *     response payload'. Those are product copy, so they go through the same
 *     sentence lookup: they read as themselves today, and the moment a
 *     dictionary entry is added for one it lights up here with no edit.
 */
export function translateApiError(t: TFunction, error: unknown): string {
  const fromBody = translateServerMessage(t, readServerMessage(error))
  if (fromBody !== null) return fromBody
  const transport = translateTransportFailure(t, error)
  if (transport !== null) return transport
  const authored = isAxiosRejection(error) ? null : readAuthoredMessage(error)
  return authored === null ? t('errors.requestFailed') : translateServerSentence(t, authored)
}

/**
 * The transport copy for a request that never got an answer at all, or null
 * when the rejection is not one of those.
 *
 * Exported because two surfaces need this decision and only one of them can
 * use `translateApiError`: the sign-in form has its own fallback
 * (`signInPage.login.genericError`, and `signInPage.totp.invalidCode` on the
 * second step) rather than the dictionary generic. What differs between the
 * two is the fallback, which belongs at the call site; what must NOT differ is
 * which rejections count as unreachable and which sentence each gets, which is
 * why that half lives here and `readTransportFailureKey` has exactly one
 * caller.
 *
 * Returning null rather than a string is the whole contract: it lets a caller
 * put this rung UNDER the response body, so a refusal that carried a body is
 * never reported as a dead host.
 */
export function translateTransportFailure(t: TFunction, error: unknown): string | null {
  const key = readTransportFailureKey(error)
  return key === null ? null : t(key)
}

/**
 * Kept for callers that already hold a server sentence rather than the
 * rejection it arrived on. Delegates, so it cannot drift from the lookup above.
 */
export function translateErrorMessage(t: TFunction, message: string): string {
  return translateServerSentence(t, message)
}

/** `response.data.message` off an axios-shaped rejection, or undefined. */
function readServerMessage(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined
  return (error as { response?: { data?: { message?: unknown } } }).response?.data?.message
}

/**
 * Which transport copy a request that never got an answer deserves, or null
 * when the request is not one.
 *
 * The timeout split is worth making because the two states differ in what the
 * operator does next: an unreachable host means the backend or its proxy is
 * down, while a timeout means the host IS answering the socket and not the
 * request -- load, or an upstream timeout that is shorter than the work.
 * Axios labels the first `ERR_NETWORK` and the second `ECONNABORTED`, or
 * `ETIMEDOUT` when `transitional.clarifyTimeoutError` is on; both spellings
 * are accepted so the split does not depend on that setting.
 */
function readTransportFailureKey(error: unknown): 'errors.serverTimeout' | 'errors.serverUnreachable' | null {
  if (!isAxiosRejection(error)) return null
  // A rejection carrying a response DID reach the server. It answered with
  // nothing this function could read, which is a refusal, not a dead host.
  if ((error as { response?: unknown }).response !== undefined) return null
  const code = (error as { code?: unknown }).code
  return code === 'ECONNABORTED' || code === 'ETIMEDOUT'
    ? 'errors.serverTimeout'
    : 'errors.serverUnreachable'
}

/**
 * Axios brands every rejection it raises with this flag -- it is what
 * `axios.isAxiosError` itself tests. Duck-typed rather than imported so this
 * module stays a pure string helper with no transport dependency.
 */
function isAxiosRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as { isAxiosError?: unknown }).isAxiosError === true
}

/**
 * The message of a hand-authored Error, when it reads like something written
 * for an operator.
 *
 * The multi-line test is not cosmetic: a Zod rejection is an `Error` whose
 * `.message` is the pretty-printed JSON of every issue it found, and
 * `getMeApi` parses the profile with `authUserSchema`, so a backend that
 * reshapes that payload puts a JSON blob in front of the operator. One line is
 * a sentence; several are a dump.
 */
function readAuthoredMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null
  const message = error.message
  if (typeof message !== 'string' || message.length === 0) return null
  return message.includes('\n') ? null : message
}
