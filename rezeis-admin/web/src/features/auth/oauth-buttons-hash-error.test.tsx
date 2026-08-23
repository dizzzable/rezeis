/**
 * The reason a provider sign-in refused, read off the URL fragment.
 *
 * `admin-oauth.controller.ts:157` answers a 2FA account's GitHub callback with
 * `res.redirect('/#oauth_error=totp_required')`. Nothing in `web/src/` read that
 * fragment — `grep -rn "oauth_error" web/src/` returned zero results — so the
 * operator was bounced back to a sign-in screen that looked exactly as it had
 * before they clicked, with no message at all and no hint that the way in was
 * to finish with their password and TOTP instead.
 *
 * So the one thing every test here does is put the reason where the BROWSER
 * puts it — in `window.location`, before the component mounts — and take it
 * from nowhere else. `OAuthButtons` accepts no props, so there is no other
 * channel a message could arrive through; a fix that read the reason from
 * anything but the URL could not make these pass.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'

vi.mock('./auth-provider', () => ({ useAuth: () => ({ login: vi.fn() }) }))

import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import { OAuthButtons } from './oauth-buttons'

const GITHUB_PROVIDER = { type: 'GITHUB', displayName: 'GitHub', isEnabled: true }

/** Land on the sign-in route the way the backend's redirect lands on it. */
function arriveAt(hash: string): void {
  window.history.replaceState({}, '', `/${hash}`)
}

describe('OAuthButtons — the oauth_error fragment', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState({}, '', '/')
  })

  it('tells a 2FA admin why GitHub sign-in stopped, reading only the URL', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: [GITHUB_PROVIDER] })
    arriveAt('#oauth_error=totp_required')

    renderWithProviders(<OAuthButtons />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/two-factor authentication is enabled on this account/i)
    expect(alert).toHaveTextContent(/enter the code from your authenticator app/i)
  })

  it('clears the fragment so a refresh does not re-show a stale refusal', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: [GITHUB_PROVIDER] })
    arriveAt('#oauth_error=totp_required')

    renderWithProviders(<OAuthButtons />)

    await screen.findByRole('alert')
    await waitFor(() => expect(window.location.hash).toBe(''))
  })

  it('keeps the rest of the fragment when it clears the error', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: [GITHUB_PROVIDER] })
    arriveAt('#oauth_error=totp_required&tab=security')

    renderWithProviders(<OAuthButtons />)

    await screen.findByRole('alert')
    await waitFor(() => expect(window.location.hash).toBe('#tab=security'))
  })

  it('names an unrecognised reason instead of showing a blank screen', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: [GITHUB_PROVIDER] })
    arriveAt('#oauth_error=provider_disabled')

    renderWithProviders(<OAuthButtons />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/provider_disabled/)
    expect(alert).toHaveTextContent(/sign in with your email and password/i)
  })

  it('still reports the refusal when the provider list is empty', async () => {
    // The provider round trip is separate from the redirect. An operator who
    // arrives here arrived BECAUSE a provider was enabled; swallowing the
    // reason because a second request came back empty is the blank screen
    // again, one layer down.
    vi.spyOn(api, 'get').mockResolvedValue({ data: [] })
    arriveAt('#oauth_error=totp_required')

    renderWithProviders(<OAuthButtons />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/two-factor authentication is enabled on this account/i)
  })

  it('shows nothing when the fragment carries no error', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: [GITHUB_PROVIDER] })
    arriveAt('')

    renderWithProviders(<OAuthButtons />)

    expect(await screen.findByRole('button', { name: 'Continue with GitHub' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
