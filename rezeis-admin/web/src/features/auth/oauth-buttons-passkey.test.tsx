/**
 * The passkey sign-in button, driven from the click.
 *
 * This button had never once reached an authenticator, in any browser. The
 * handler passed the server's JSON options straight to
 * `navigator.credentials.get`, and `PublicKeyCredentialRequestOptions.challenge`
 * is declared `BufferSource` in WebIDL — converting the base64url STRING the
 * server sends throws a `TypeError` synchronously, inside the call, before any
 * prompt appears. The throw landed in `catch { }` and the click did nothing at
 * all: no prompt, no error, no log.
 *
 * So the one thing this file must simulate faithfully is that conversion.
 * `credentials.get` below rejects a non-BufferSource `challenge` (and a
 * non-BufferSource `allowCredentials[].id`) with a `TypeError` BEFORE recording
 * anything, exactly as the WebIDL binding does. Get that wrong — record first,
 * or accept a string — and this file would pass against the broken handler,
 * which is the failure mode it exists to prevent.
 *
 * Everything else is real: the actual `api` axios instance with its actual
 * response interceptor, the actual component. Only the transport underneath
 * axios and the authenticator itself are replaced.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import {
  AxiosError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const loginSpy = vi.fn()
vi.mock('./auth-provider', () => ({ useAuth: () => ({ login: loginSpy }) }))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() },
}))

import { toast } from 'sonner'

import { api } from '@/lib/api'
import { queryClient } from '@/lib/query-client'
import { endAdminClientSession } from '@/lib/admin-session'
import { OAuthButtons } from './oauth-buttons'

// ── The authenticator, and the WebIDL conversion in front of it ─────────────

const SERVER_CHALLENGE = 'Q0hBTExFTkdFLTAxMjM0NTY3ODk'
const SERVER_CREDENTIAL_ID = 'Y3JlZC1pZC0wMDE'
const ISSUED_TOKEN = 'issued.jwt.token'

interface RecordedCeremony {
  challenge: Uint8Array
  allowCredentialIds: Uint8Array[]
  rpId: string | undefined
  userVerification: string | undefined
}

let recorded: RecordedCeremony | null = null
/** What `credentials.get` should do once the conversion has passed. */
let ceremony: 'succeed' | 'dismissed' | 'aborted' = 'succeed'

function isBufferSource(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value)
}

function bytesOf(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

function base64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
  const binary = atob(padded + padding)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

const credentialsGet = vi.fn(async (options: CredentialRequestOptions) => {
  const publicKey = options.publicKey
  if (!publicKey) {
    throw new TypeError("Failed to read the 'publicKey' property")
  }
  // The conversion. Nothing is recorded above this point on purpose: in a real
  // browser a string challenge never becomes a ceremony, it becomes a throw.
  if (!isBufferSource(publicKey.challenge)) {
    throw new TypeError(
      "Failed to execute 'get' on 'CredentialsContainer': Failed to read the 'challenge' " +
        'property from PublicKeyCredentialRequestOptions: The provided value is not of type ' +
        "'(ArrayBuffer or ArrayBufferView)'.",
    )
  }
  for (const descriptor of publicKey.allowCredentials ?? []) {
    if (!isBufferSource(descriptor.id)) {
      throw new TypeError(
        "Failed to read the 'id' property from PublicKeyCredentialDescriptor: The provided " +
          "value is not of type '(ArrayBuffer or ArrayBufferView)'.",
      )
    }
  }

  recorded = {
    challenge: bytesOf(publicKey.challenge),
    allowCredentialIds: (publicKey.allowCredentials ?? []).map((d) =>
      bytesOf(d.id as ArrayBuffer),
    ),
    rpId: publicKey.rpId,
    userVerification: publicKey.userVerification,
  }

  if (ceremony === 'dismissed') {
    throw new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError')
  }
  if (ceremony === 'aborted') {
    throw new DOMException('The operation was aborted.', 'AbortError')
  }

  const credentialIdBytes = base64urlToBytes(SERVER_CREDENTIAL_ID)
  return {
    id: SERVER_CREDENTIAL_ID,
    rawId: credentialIdBytes.buffer,
    type: 'public-key',
    response: {
      authenticatorData: new Uint8Array([1, 2, 3]).buffer,
      clientDataJSON: new Uint8Array([4, 5, 6]).buffer,
      signature: new Uint8Array([7, 8, 9]).buffer,
      userHandle: null,
    },
  } as unknown as Credential
})

// ── The network ────────────────────────────────────────────────────────────

interface VerifyRequest {
  response: {
    id: string
    rawId: string
    type: string
    response: Record<string, string | null>
  }
}

const verifyRequests: VerifyRequest[] = []
/** 200 with a token, or the 401 a rejected assertion produces. */
let verifyOutcome: 'ok' | 'rejected' = 'ok'
let originalAdapter: AxiosAdapter | undefined

function ok(config: InternalAxiosRequestConfig, data: unknown): AxiosResponse {
  return { data, status: 200, statusText: 'OK', headers: {}, config } as AxiosResponse
}

const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  const url = config.url ?? ''
  if (url.includes('/admin/oauth/providers')) {
    return ok(config, [{ type: 'GITHUB', displayName: 'GitHub', isEnabled: true }])
  }
  if (url.includes('/admin/passkey/authenticate/options')) {
    // The real server's shape: JSON, so every binary field is a base64url
    // string. `allowCredentials` is populated here even though production
    // leaves it empty today, because the conversion trap is the same one.
    return ok(config, {
      challenge: SERVER_CHALLENGE,
      rpId: 'panel.example.com',
      timeout: 60000,
      userVerification: 'preferred',
      allowCredentials: [{ id: SERVER_CREDENTIAL_ID, transports: ['internal'] }],
    })
  }
  if (url.includes('/admin/passkey/authenticate/verify')) {
    verifyRequests.push(
      typeof config.data === 'string' ? (JSON.parse(config.data) as VerifyRequest) : ({} as VerifyRequest),
    )
    if (verifyOutcome === 'ok') {
      return ok(config, { accessToken: ISSUED_TOKEN, tokenType: 'Bearer', expiresIn: '24h' })
    }
    const response = {
      data: { statusCode: 401, message: 'Passkey authentication failed', errorCode: 'UNAUTHORIZED' },
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config,
    } as AxiosResponse
    throw new AxiosError(
      'Request failed with status code 401',
      AxiosError.ERR_BAD_REQUEST,
      config,
      {},
      response,
    )
  }
  throw new AxiosError(`unexpected request to ${url}`, AxiosError.ERR_BAD_REQUEST, config, {})
}

function renderButtons() {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <OAuthButtons />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function clickPasskey(): Promise<void> {
  const button = await screen.findByText('signInPage.oauth.passkey')
  button.closest('button')?.click()
}

beforeEach(() => {
  window.history.replaceState({}, '', '/sign-in')
  Object.defineProperty(window.navigator, 'credentials', {
    value: { get: credentialsGet, create: vi.fn() },
    configurable: true,
    writable: true,
  })
  originalAdapter = api.defaults.adapter as AxiosAdapter | undefined
  api.defaults.adapter = adapter
  recorded = null
  ceremony = 'succeed'
  verifyOutcome = 'ok'
  verifyRequests.length = 0
  endAdminClientSession(queryClient)
})

afterEach(() => {
  api.defaults.adapter = originalAdapter
  endAdminClientSession(queryClient)
  vi.clearAllMocks()
})

describe('passkey sign-in button', () => {
  it('converts the challenge to a buffer, so the ceremony actually starts', async () => {
    renderButtons()
    await clickPasskey()

    await waitFor(() => expect(recorded).not.toBeNull())
    // The assertion the old handler could never reach: a real browser threw on
    // the string before this point.
    expect(bytesToBase64url(recorded!.challenge)).toBe(SERVER_CHALLENGE)
    expect(recorded!.allowCredentialIds).toHaveLength(1)
    expect(bytesToBase64url(recorded!.allowCredentialIds[0])).toBe(SERVER_CREDENTIAL_ID)
    // The scalar fields are forwarded unchanged — they were never the problem,
    // and dropping them would quietly change which authenticators qualify.
    expect(recorded!.rpId).toBe('panel.example.com')
    expect(recorded!.userVerification).toBe('preferred')
  })

  it('sends the assertion on and adopts the token it gets back', async () => {
    renderButtons()
    await clickPasskey()

    await waitFor(() => expect(verifyRequests).toHaveLength(1))
    expect(verifyRequests[0].response.id).toBe(SERVER_CREDENTIAL_ID)
    expect(verifyRequests[0].response.type).toBe('public-key')
    expect(typeof verifyRequests[0].response.response.signature).toBe('string')
    await waitFor(() => expect(loginSpy).toHaveBeenCalledWith(ISSUED_TOKEN))
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('says nothing when the operator dismisses the browser prompt', async () => {
    ceremony = 'dismissed'
    renderButtons()
    await clickPasskey()

    await waitFor(() => expect(recorded).not.toBeNull())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(toast.error).not.toHaveBeenCalled()
    expect(verifyRequests).toHaveLength(0)
    expect(loginSpy).not.toHaveBeenCalled()
  })

  it('says nothing when the ceremony is aborted', async () => {
    ceremony = 'aborted'
    renderButtons()
    await clickPasskey()

    await waitFor(() => expect(recorded).not.toBeNull())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('tells the operator when the server rejects the assertion', async () => {
    // The case the empty catch hid: the button appears to do nothing, and the
    // operator has no way to tell a dead feature from a wrong credential.
    verifyOutcome = 'rejected'
    renderButtons()
    await clickPasskey()

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(loginSpy).not.toHaveBeenCalled()
  })

  it('tells the operator when the ceremony itself fails', async () => {
    // Anything that is not a dismissal — including the TypeError this whole
    // change exists to stop — has to surface rather than vanish.
    credentialsGet.mockImplementationOnce(async () => {
      throw new TypeError('conversion failed')
    })
    renderButtons()
    await clickPasskey()

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(verifyRequests).toHaveLength(0)
  })
})
