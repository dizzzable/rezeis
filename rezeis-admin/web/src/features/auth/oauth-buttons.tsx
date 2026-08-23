import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation } from '@tanstack/react-query'
import { Loader2, KeyRound, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { useNavigate } from 'react-router'
import { consumeReturnTo } from '@/lib/return-to'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { api } from '@/lib/api'
import { expectArray } from '@/lib/api-utils'

import {
  type AuthProviderIconType,
  getAuthProviderIcon,
} from '@/features/settings/auth-provider-icons'

import { useAuth } from './auth-provider'

interface PublicProvider {
  type: string
  displayName: string
  isEnabled: boolean
}

/**
 * `POST /admin/passkey/authenticate/options` as it arrives — JSON, so every
 * binary field is a base64url STRING. Typed here rather than cast straight to
 * `PublicKeyCredentialRequestOptions`, because that cast is the whole bug in
 * `handlePasskey`: the two types differ in exactly the fields the browser
 * refuses to accept as strings.
 */
interface PasskeyRequestOptionsJSON {
  challenge: string
  rpId?: string
  timeout?: number
  userVerification?: UserVerificationRequirement
  allowCredentials?: { id: string; transports?: AuthenticatorTransport[] }[]
}

/**
 * Every `oauth_error=` value the backend can put in the fragment, mapped to the
 * copy that tells the operator what to do next.
 *
 * The list is exhaustive as of this change: `res.redirect('/#oauth_error=…')`
 * occurs exactly once in the whole tree —
 * `src/modules/oauth/controllers/admin-oauth.controller.ts:157`, which sends
 * `totp_required` when `processOAuthLogin` refuses a 2FA account. (The other
 * failure leg of that callback, the CSRF state mismatch at :136, answers with a
 * plain `403` body and never reaches the SPA at all.)
 *
 * It is a MAP and not a comparison against one string because the fragment is
 * a wire contract with a route this file cannot see: the next reason somebody
 * adds there — a disabled provider, a linked-account conflict — would otherwise
 * land back on the blank screen this whole component exists to end.
 * `UNKNOWN_OAUTH_ERROR_KEY` is what an unrecognised value gets, so the failure
 * mode of a missing entry is "wrong words" rather than "no words".
 */
const OAUTH_ERROR_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  totp_required: 'signInPage.oauth.error.totpRequired',
}

const UNKNOWN_OAUTH_ERROR_KEY = 'signInPage.oauth.error.unknown'
const UNKNOWN_OAUTH_ERROR_NO_CODE_KEY = 'signInPage.oauth.error.unknownNoCode'

/**
 * The `oauth_error` value in `location.hash`, if any.
 *
 * The reason travels in the FRAGMENT rather than the query string so it never
 * reaches an access log — the same rule the success leg follows for the token
 * (`admin-oauth.controller.ts:163`). Nothing in the SPA read it, so the only
 * way an operator learned that GitHub sign-in had refused them was that the
 * sign-in screen reappeared unchanged.
 */
function readOAuthErrorFromHash(): string | null {
  if (typeof window === 'undefined' || !window.location.hash) return null
  const code = new URLSearchParams(window.location.hash.slice(1)).get('oauth_error')
  return code !== null && code.length > 0 ? code : null
}

/**
 * Drop `oauth_error` from the fragment, keeping anything else that was in it.
 *
 * Without this a refresh — or a `returnTo` navigation back to `/` — re-shows an
 * error about an attempt that finished minutes ago. `auth-storage.ts:21` clears
 * the whole fragment because the token it consumes is the only thing that can
 * be in it; this one is surgical because the error can arrive beside other
 * state.
 */
function clearOAuthErrorFromHash(): void {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams(window.location.hash.slice(1))
  if (!params.has('oauth_error')) return
  params.delete('oauth_error')
  const rest = params.toString()
  const { pathname, search } = window.location
  window.history.replaceState({}, '', `${pathname}${search}${rest.length > 0 ? `#${rest}` : ''}`)
}

/**
 * A fragment value is attacker-supplied — anyone can mail a link with any
 * `#oauth_error=` in it — and this one is echoed back into the page for the
 * unrecognised case. React escapes it as text, so the risk is not script; it is
 * a multi-kilobyte string or a bidi override wrecking the sign-in screen. Strip
 * to the shape a real code has and clamp; an empty result gets the codeless
 * wording instead of an empty pair of brackets.
 */
function displayableOAuthCode(code: string): string {
  return code.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 48)
}

/**
 * OAuth login buttons shown on the sign-in page.
 * Only renders if there are enabled providers — or if the provider round trip
 * came back with a reason the operator has to be told.
 */
export function OAuthButtons() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { login } = useAuth()

  // Read during the first render, not in an effect: the value has to be
  // captured before anything else can rewrite `location.hash`, and the effect
  // below is what removes it.
  const [oauthError] = useState<string | null>(readOAuthErrorFromHash)

  useEffect(() => {
    if (oauthError === null) return
    clearOAuthErrorFromHash()
  }, [oauthError])

  const { data: providers, isLoading } = useQuery({
    queryKey: ['oauth', 'providers'],
    queryFn: async () => {
      const res = await api.get('/admin/oauth/providers')
      return expectArray<PublicProvider>(res.data)
    },
    staleTime: 60_000,
  })

  const telegramMutation = useMutation({
    mutationFn: async (data: Record<string, string>) => {
      const res = await api.post<{ accessToken: string }>('/admin/oauth/telegram/login', data)
      return res.data
    },
    onSuccess: (data) => {
      login(data.accessToken)
      navigate(consumeReturnTo() ?? '/', { replace: true })
    },
  })

  const hasProviders = !isLoading && !!providers && providers.length > 0

  // The refusal outlives the provider list on purpose. `GET /admin/oauth/providers`
  // is a second, independent round trip: if it is slow, empty or failing, an
  // early `return null` here would swallow the one message the operator is
  // standing on this screen waiting for — and the reason they are here at all
  // is that a provider WAS enabled a moment ago.
  if (!hasProviders && oauthError === null) {
    return null
  }

  const handleGitHub = () => {
    window.location.href = '/api/admin/oauth/github/authorize'
  }

  const handlePasskey = async () => {
    try {
      // Get authentication options
      const optionsRes = await api.post<PasskeyRequestOptionsJSON>('/admin/passkey/authenticate/options', {})
      const options = optionsRes.data

      // Why this conversion exists, and what happened without it.
      //
      // The server speaks JSON, so `challenge` reaches us as a base64url
      // string. `PublicKeyCredentialRequestOptions.challenge` is declared
      // `BufferSource`, and the WebIDL conversion for a string is not lenient:
      // it throws a TypeError SYNCHRONOUSLY, inside `navigator.credentials.get`,
      // before the authenticator is ever consulted. This button therefore never
      // reached a prompt in any browser — the throw landed in an empty `catch`
      // and the click did nothing at all. The registration half in
      // `two-factor-page.tsx` has always converted; only the login half did not.
      //
      // `allowCredentials` is empty today (the server only fills it for the
      // account-scoped branch of `generateAuthenticationOptions`, which no
      // caller uses yet) and is converted anyway: it is the same string-vs-
      // buffer trap, and it would fire the first time someone wires a
      // username-first login.
      const publicKey: PublicKeyCredentialRequestOptions = {
        challenge: base64urlToBuffer(options.challenge),
        rpId: options.rpId,
        timeout: options.timeout,
        userVerification: options.userVerification,
        allowCredentials: options.allowCredentials?.map((c) => ({
          id: base64urlToBuffer(c.id),
          type: 'public-key' as const,
          transports: c.transports,
        })),
      }

      const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null

      if (!credential) return

      const response = credential.response as AuthenticatorAssertionResponse

      // Send to backend for verification
      const verifyRes = await api.post<{ accessToken: string }>('/admin/passkey/authenticate/verify', {
        response: {
          id: credential.id,
          rawId: bufferToBase64url(credential.rawId),
          type: credential.type,
          response: {
            authenticatorData: bufferToBase64url(response.authenticatorData),
            clientDataJSON: bufferToBase64url(response.clientDataJSON),
            signature: bufferToBase64url(response.signature),
            userHandle: response.userHandle ? bufferToBase64url(response.userHandle) : null,
          },
        },
      })

      login(verifyRes.data.accessToken)
      navigate(consumeReturnTo() ?? '/', { replace: true })
    } catch (error) {
      // The empty catch this replaces is why a feature that had never once
      // executed shipped and stayed shipped: it made "the operator pressed
      // Escape" and "the call throws a TypeError on every browser on earth"
      // the same silent no-op.
      //
      // Only the first of those is a non-event. `NotAllowedError` is what the
      // WebAuthn spec raises when the user dismisses the prompt or lets it time
      // out, and `AbortError` when something cancels the ceremony. Everything
      // else — a rejected assertion, an unknown credential, a 401, a 429, a
      // conversion the browser refuses — is a failure the operator is entitled
      // to see, because otherwise the button simply does nothing and there is
      // nothing on screen to act on.
      const name = (error as { name?: string } | null)?.name
      if (name === 'NotAllowedError' || name === 'AbortError') return
      console.error('Passkey sign-in failed', error)
      toast.error(t('signInPage.oauth.passkeyFailed', { defaultValue: 'Passkey sign-in failed' }))
    }
  }

  // Check if passkey is supported
  const passkeySupported = typeof window !== 'undefined' && 'credentials' in navigator

  return (
    <>
      {oauthError !== null ? (
        <Alert variant="destructive" className="mt-4" data-oauth-error={oauthError}>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t('signInPage.oauth.error.title')}</AlertTitle>
          <AlertDescription>{describeOAuthError(t, oauthError)}</AlertDescription>
        </Alert>
      ) : null}

      {hasProviders ? (
        <div className="relative my-4">
          <Separator />
          <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs text-muted-foreground">
            {t('signInPage.oauth.or')}
          </span>
        </div>
      ) : null}

      {hasProviders ? (
        <div className="space-y-2">
          {(providers ?? []).map((provider) => {
            const Icon = getAuthProviderIcon(provider.type as AuthProviderIconType)

            if (provider.type === 'GITHUB') {
              return (
                <Button
                  key={provider.type}
                  variant="outline"
                  className="w-full gap-2"
                  onClick={handleGitHub}
                >
                  <Icon className="h-4 w-4" />
                  {t('signInPage.oauth.continueWith', { provider: provider.displayName })}
                </Button>
              )
            }

            if (provider.type === 'TELEGRAM') {
              return (
                <Button
                  key={provider.type}
                  variant="outline"
                  className="w-full gap-2"
                  onClick={() => {
                    // Telegram Login Widget will be handled via the widget script
                    // For now, show a placeholder
                    telegramMutation.mutate({})
                  }}
                  disabled={telegramMutation.isPending}
                >
                  {telegramMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Icon className="h-4 w-4" />
                  )}
                  {t('signInPage.oauth.continueWith', { provider: provider.displayName })}
                </Button>
              )
            }

            return (
              <Button
                key={provider.type}
                variant="outline"
                className="w-full gap-2"
                onClick={() => {
                  window.location.href = `/api/admin/oauth/${provider.type.toLowerCase()}/authorize`
                }}
              >
                <Icon className="h-4 w-4" />
                {t('signInPage.oauth.continueWith', { provider: provider.displayName })}
              </Button>
            )
          })}

          {passkeySupported && (
            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={handlePasskey}
            >
              <KeyRound className="h-4 w-4" />
              {t('signInPage.oauth.passkey')}
            </Button>
          )}
        </div>
      ) : null}
    </>
  )
}

/**
 * The sentence for one `oauth_error` value. Unrecognised values are named
 * rather than swallowed, because "something went wrong" and "GitHub sign-in
 * cannot finish while 2FA is on" call for different next steps, and an operator
 * who can read the code off the screen can at least search for it.
 */
function describeOAuthError(t: (key: string, options?: Record<string, unknown>) => string, code: string): string {
  const known = OAUTH_ERROR_MESSAGE_KEYS[code]
  if (known !== undefined) return t(known)
  const display = displayableOAuthCode(code)
  return display.length > 0
    ? t(UNKNOWN_OAUTH_ERROR_KEY, { code: display })
    : t(UNKNOWN_OAUTH_ERROR_NO_CODE_KEY)
}

/**
 * Base64url string -> ArrayBuffer, for the WebAuthn fields the browser insists
 * are buffers.
 *
 * A local copy of the helper `two-factor-page.tsx` defines for the registration
 * ceremony. Duplicated on purpose: the natural move is to extract it into a
 * shared `lib/` module and have both import it, and that is what should happen
 * — but it means editing `two-factor-page.tsx`, which is not this change's to
 * edit. Two copies that agree is a smaller problem than a login button that
 * cannot run; a follow-up should collapse them.
 */
function base64urlToBuffer(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
  const binary = atob(padded + padding)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}
