/**
 * The user card's copy buttons report what the clipboard actually did.
 *
 * Three of them ran `navigator.clipboard.writeText(v)` without waiting for the
 * answer and toasted "copied" on the next line — the registration IP and the
 * tracking code (`AnalyticsRow`), the Remnawave profile id, and the
 * subscription link. A refused write (the tab not focused, a browser policy)
 * showed the same green toast as a successful one, and the operator pasted
 * whatever the clipboard held before into a message to the customer.
 *
 * Each case pins the clipboard's ANSWER. The success cases are the control:
 * an implementation that toasted "failed" for everything would pass the
 * refusal cases alone.
 *
 * (It lives with the payments feature only because that is where this change
 * may write; it drives `features/users/user-detail-panel.tsx`.)
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { i18nReady, loadFeatureBundle } from '@/i18n/i18n'
import { api } from '@/lib/api'
import { renderWithProviders } from '@/test/test-utils'
import { usePermissionStore } from '@/features/rbac'

vi.mock('@/features/plans/plans-api', () => ({ usePlans: () => ({ data: [] }) }))

const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toastMock }))

import UserDetailPanel from '@/features/users/user-detail-panel'

const REMNAWAVE_ID = '5a1b8c3d-2e4f-4a6b-9c8d-7e6f5a4b3c2d'
const CONFIG_URL = 'https://sub.example.test/s/AbC123'
const REGISTRATION_IP = '203.0.113.5'

const SUBSCRIPTION = {
  id: 'sub-1',
  status: 'ACTIVE',
  isTrial: false,
  trafficLimit: 100,
  deviceLimit: 3,
  expireAt: '2026-12-01T10:00:00.000Z',
  remnawaveId: REMNAWAVE_ID,
  remnawaveProfileName: 'rz_alice_sub',
  configUrl: CONFIG_URL,
  plan: { id: 'plan-1', name: 'Base', type: 'BOTH' },
}

const USER = {
  id: 'user-1',
  telegramId: '12345',
  username: 'alice',
  name: 'Alice',
  email: 'alice@example.com',
  language: 'en',
  role: 'USER',
  isBlocked: false,
  isPartner: false,
  points: 0,
  personalDiscount: 0,
  purchaseDiscount: 0,
  maxSubscriptions: 1,
  createdAt: '2026-06-04T10:00:00.000Z',
  updatedAt: '2026-06-04T10:00:00.000Z',
  subscriptions: [SUBSCRIPTION],
  transactions: [],
  referralsGiven: [],
  partner: null,
  webAccount: null,
  canViewRegistration: true,
  registrationIp: REGISTRATION_IP,
}

let writeText: ReturnType<typeof vi.fn>

/** The clipboard as the browser answers it, and the older path's answer too. */
function clipboardAnswers(answer: 'accepts' | 'refuses'): void {
  writeText = vi.fn(async () => {
    if (answer === 'refuses') throw new DOMException('Document is not focused.', 'NotAllowedError')
  })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: vi.fn(() => false) })
}

function renderCard() {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue({ data: { ...USER } })
  renderWithProviders(<UserDetailPanel telegramId="12345" />)
  return user
}

/** The copy button in the Analytics row that shows `value`. */
async function analyticsCopyButton(user: ReturnType<typeof userEvent.setup>, value: string) {
  await user.click(await screen.findByRole('tab', { name: 'Analytics' }))
  const row = (await screen.findByText(value)).parentElement
  if (row === null) throw new Error(`no row for ${value}`)
  return within(row).getByRole('button')
}

beforeAll(async () => {
  await i18nReady
  await loadFeatureBundle('userDetail')
})

beforeEach(() => {
  vi.restoreAllMocks()
  usePermissionStore.setState({ loaded: true, role: 'DEV' })
  toastMock.success.mockClear()
  toastMock.error.mockClear()
})

describe('Analytics row copy', () => {
  it('says the copy failed when the clipboard refused it', async () => {
    const user = renderCard()
    const copy = await analyticsCopyButton(user, REGISTRATION_IP)
    clipboardAnswers('refuses')

    await user.click(copy)

    // Whichever toast came first is the verdict; it has to be the failure.
    await waitFor(() =>
      expect(toastMock.success.mock.calls.length + toastMock.error.mock.calls.length).toBe(1),
    )
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining('Could not copy Registration IP'),
      { description: REGISTRATION_IP },
    )
  })

  it('says it copied when it did, and is named for what it copies', async () => {
    const user = renderCard()
    const copy = await analyticsCopyButton(user, REGISTRATION_IP)
    clipboardAnswers('accepts')

    await user.click(copy)

    expect(writeText).toHaveBeenCalledWith(REGISTRATION_IP)
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1))
    expect(toastMock.error).not.toHaveBeenCalled()
    expect(copy).toHaveAccessibleName('Copy Registration IP')
  })
})

describe('Remnawave profile copy', () => {
  it('says the copy failed when the clipboard refused it', async () => {
    const user = renderCard()
    await user.click(await screen.findByRole('tab', { name: /^Subscriptions/ }))
    clipboardAnswers('refuses')

    await user.click(
      await screen.findByRole('button', { name: 'Copy Remnawave profile identifier to clipboard' }),
    )

    // Whichever toast came first is the verdict; it has to be the failure.
    await waitFor(() =>
      expect(toastMock.success.mock.calls.length + toastMock.error.mock.calls.length).toBe(1),
    )
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining('Could not copy Remnawave profile'),
      { description: REMNAWAVE_ID },
    )
  })

  it('says it copied when it did', async () => {
    const user = renderCard()
    await user.click(await screen.findByRole('tab', { name: /^Subscriptions/ }))
    clipboardAnswers('accepts')

    await user.click(
      await screen.findByRole('button', { name: 'Copy Remnawave profile identifier to clipboard' }),
    )

    expect(writeText).toHaveBeenCalledWith(REMNAWAVE_ID)
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith('Remnawave profile identifier copied'),
    )
    expect(toastMock.error).not.toHaveBeenCalled()
  })
})

describe('subscription link copy', () => {
  async function linkButton(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('tab', { name: /^Subscriptions/ }))
    await user.click(await screen.findByRole('button', { name: 'Quick edits' }))
    return screen.findByRole('button', { name: 'Copy link' })
  }

  it('says the copy failed, and hands over the link, when the clipboard refused it', async () => {
    const user = renderCard()
    const button = await linkButton(user)
    clipboardAnswers('refuses')

    await user.click(button)

    // Whichever toast came first is the verdict; it has to be the failure.
    await waitFor(() =>
      expect(toastMock.success.mock.calls.length + toastMock.error.mock.calls.length).toBe(1),
    )
    expect(toastMock.success).not.toHaveBeenCalled()
    // The card never shows the link as text, so the toast is the only place
    // left to select it from by hand.
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining('Could not copy Subscription link'),
      { description: CONFIG_URL },
    )
  })

  it('says it copied when it did', async () => {
    const user = renderCard()
    const button = await linkButton(user)
    clipboardAnswers('accepts')

    await user.click(button)

    expect(writeText).toHaveBeenCalledWith(CONFIG_URL)
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Subscription link copied'))
    expect(toastMock.error).not.toHaveBeenCalled()
  })
})

/**
 * The temporary-password dialog of the Web cabinet tab.
 *
 * Issuing a password copies the login and the password automatically, and the
 * dialog said «Login and password are already copied to the clipboard» no
 * matter what — while the copy itself was `writeText(…).then(ok, () => {})`,
 * refused in silence. That automatic copy runs after a network round trip,
 * without a click, which is exactly what browsers are most likely to refuse.
 */
describe('the temporary password dialog', () => {
  const ISSUED = { login: 'alice', temporaryPassword: 'Tmp-7Q2m9x', expiresAt: '2026-09-19T10:00:00.000Z' }
  const WEB_USER = {
    ...USER,
    webAccount: {
      login: 'alice',
      email: null,
      requiresPasswordChange: false,
      temporaryPasswordExpiresAt: null,
    },
  }

  async function issueTemporaryPassword() {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockImplementation(async (path: string) =>
      path.endsWith('/web/temp-password')
        ? { data: { temporaryPassword: null, expiresAt: null } }
        : { data: { ...WEB_USER } },
    )
    vi.spyOn(api, 'post').mockResolvedValue({ data: ISSUED })
    renderWithProviders(<UserDetailPanel telegramId="12345" />)
    await user.click(await screen.findByRole('tab', { name: 'Web cabinet' }))
    await user.click(await screen.findByRole('button', { name: 'Issue temporary password' }))
    return user
  }

  async function confirmAndOpenDialog(user: ReturnType<typeof userEvent.setup>) {
    const confirm = within(await screen.findByRole('alertdialog')).getByRole('button', {
      name: 'Issue temporary password',
    })
    await user.click(confirm)
    return screen.findByRole('dialog', { name: 'Temporary password' })
  }

  it('does not claim the automatic copy worked when the browser refused it', async () => {
    const user = await issueTemporaryPassword()
    clipboardAnswers('refuses')

    const dialog = await confirmAndOpenDialog(user)

    expect(
      await within(dialog).findByText(/The browser did not let the login and password be copied automatically/),
    ).toBeInTheDocument()
    expect(within(dialog).queryByText(/already copied/)).not.toBeInTheDocument()
    expect(toastMock.error).toHaveBeenCalledWith(
      'Could not copy the login and password: the browser did not allow access to the clipboard. Select them on screen and copy them by hand.',
    )
  })

  it('says «already copied» once the clipboard took them, and not before', async () => {
    const user = await issueTemporaryPassword()
    let answer: (() => void) | undefined
    writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          answer = resolve
        }),
    )
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    const dialog = await confirmAndOpenDialog(user)

    // Asked, not yet answered: only what is true regardless.
    expect(
      within(dialog).getByText('This password is shown once — after you close the dialog there is no way to recover it.'),
    ).toBeInTheDocument()
    expect(within(dialog).queryByText(/already copied/)).not.toBeInTheDocument()

    answer?.()

    expect(await within(dialog).findByText(/Login and password are already copied/)).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith('Current login: alice\nPassword: Tmp-7Q2m9x')
  })

  it('names its copy buttons for what they do, not for a result', async () => {
    const user = await issueTemporaryPassword()
    clipboardAnswers('accepts')

    const dialog = await confirmAndOpenDialog(user)

    expect(within(dialog).getAllByRole('button', { name: 'Copy login and password' })).toHaveLength(2)
    expect(within(dialog).queryByRole('button', { name: 'Login and password copied' })).not.toBeInTheDocument()
  })
})
