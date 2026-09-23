/**
 * «Имя отправителя» on the SMTP card may be left empty, and empty means "the brand".
 *
 * The field used to be REQUIRED and filled from the name the panel would send
 * under right now. So the first «Сохранить» on this card wrote that name into
 * the database, and from then on it was a stored choice: for years it was
 * "Rezeis" — the panel's name in the sender of every customer letter — and once
 * that default was gone it would have been today's brand, frozen, with a later
 * rename never reaching the letters.
 *
 * Now the card shows only a name somebody SAVED, offers the name an empty field
 * sends as its placeholder, and saves an empty field as empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import { usePermissionStore } from '@/features/rbac'
import NotificationsPage from '@/features/notifications/notifications-page'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

/** `GET /admin/email/settings` for an install that never saved a sender name. */
const NOTHING_SAVED = {
  enabled: true,
  notifyUsers: false,
  host: 'smtp.example.com',
  port: 587,
  username: null,
  password: null,
  fromAddress: 'no-reply@acme.example',
  fromName: '',
  fromNameFallback: 'Acme VPN',
  fromNameFallbackSource: 'brand',
  useTls: true,
  useSsl: false,
  passwordSet: false,
}

function mockEmailSettings(settings: Record<string, unknown>): void {
  vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/settings') {
      return { data: { userNotifications: {}, systemNotifications: { telegram: {} } } }
    }
    if (path === '/admin/email/settings') return { data: settings }
    return { data: [] }
  })
}

async function openSmtpCard(): Promise<{
  readonly card: ReturnType<typeof within>
  readonly user: ReturnType<typeof userEvent.setup>
}> {
  renderWithProviders(<NotificationsPage />)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('tab', { name: 'Delivery settings' }))
  const heading = await screen.findByText('Email (SMTP)')
  const card = heading.closest('[data-concept-surface="card"]')
  expect(card).not.toBeNull()
  return { card: within(card as HTMLElement), user }
}

beforeEach(async () => {
  await loadFeatureBundle('notifications')
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(['settings:edit', 'email:edit']),
    mustChangePassword: false,
    role: 'ADMIN',
    rbacRoleId: 'role-1',
    error: null,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  usePermissionStore.getState().reset()
})

describe('the sender name on the SMTP card', () => {
  it('is empty when none was saved, and says what an empty one sends', async () => {
    mockEmailSettings(NOTHING_SAVED)
    const { card } = await openSmtpCard()

    const field = card.getByLabelText('From name') as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.placeholder).toBe('Acme VPN')
    expect(card.getByText(/under your brand \(currently “Acme VPN”\)/)).toBeInTheDocument()
  })

  it('says so when the environment, not the brand, names the sender', async () => {
    mockEmailSettings({ ...NOTHING_SAVED, fromNameFallback: 'Acme Mail', fromNameFallbackSource: 'env' })
    const { card } = await openSmtpCard()

    expect((card.getByLabelText('From name') as HTMLInputElement).placeholder).toBe('Acme Mail')
    expect(card.getByText(/“Acme Mail”, set by EMAIL_FROM_NAME/)).toBeInTheDocument()
  })

  it('saves with the name left empty', async () => {
    mockEmailSettings(NOTHING_SAVED)
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: NOTHING_SAVED })
    const { card, user } = await openSmtpCard()

    await user.click(card.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(post).toHaveBeenCalledTimes(1)
    })
    expect(post.mock.calls[0]?.[0]).toBe('/admin/email/settings')
    expect(post.mock.calls[0]?.[1]).toMatchObject({ fromName: '' })
  })

  it('shows and keeps a name that was saved', async () => {
    mockEmailSettings({ ...NOTHING_SAVED, fromName: 'Acme Support' })
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: NOTHING_SAVED })
    const { card, user } = await openSmtpCard()

    expect((card.getByLabelText('From name') as HTMLInputElement).value).toBe('Acme Support')
    await user.click(card.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(post).toHaveBeenCalledTimes(1)
    })
    expect(post.mock.calls[0]?.[1]).toMatchObject({ fromName: 'Acme Support' })
  })
})
