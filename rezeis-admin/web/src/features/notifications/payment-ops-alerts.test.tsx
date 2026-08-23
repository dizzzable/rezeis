/**
 * The delivery tab is the only place a payment-webhook alert can be switched on.
 *
 * `PaymentOpsAlertService.sendWebhookAlert` returns before sending anything
 * while `enabled` is false or no `chatId` is stored, and the stored default is
 * exactly that — so `notifyWebhookFailed` and `notifyWebhookReplay` reached
 * nobody, and the single write path to that config
 * (`PATCH /admin/settings/system-notifications/payment-ops`) had no caller in
 * this SPA at all. A spec that asserted the form *exists* would reproduce the
 * disease it is guarding against, so every case below drives the page the way
 * an operator does and then reads the request that actually went out.
 *
 * The `errorReports` cases are the smaller half of the same gap: the two fields
 * round-trip on the Telegram delivery config, the backend has taken them since
 * the day it was written, and the form never sent them — so `auto` (the on-disk
 * archive) was unreachable and the Telegram attachment could not be turned off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { api } from '@/lib/api'
import { loadFeatureBundle } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import { usePermissionStore } from '@/features/rbac'
import type { RbacAction } from '@/features/rbac'
import NotificationsPage from '@/features/notifications/notifications-page'

/**
 * The toast is the whole output of a failed test alert, so it has to be
 * readable rather than merely fired.
 */
const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: toastMock }))

/** Shape of `GET /admin/settings/system-notifications/payment-ops`. */
interface PaymentOpsFixture {
  readonly enabled: boolean
  readonly chatId: string | null
  readonly threadId: string | null
  readonly hashtag: string | null
}

/** `DEFAULT_PAYMENT_OPS_ALERT_SETTINGS` — what a panel that never configured this answers. */
const UNCONFIGURED: PaymentOpsFixture = {
  enabled: false,
  chatId: null,
  threadId: null,
  hashtag: '#payments_ops',
}

const CONFIGURED: PaymentOpsFixture = {
  enabled: true,
  chatId: '-1003713706224',
  threadId: '10',
  hashtag: '#payments_ops',
}

/** Enough of `GET /admin/email/settings` for the SMTP card to mount quietly. */
const SMTP_SETTINGS = {
  enabled: false,
  host: null,
  port: 587,
  username: null,
  password: null,
  fromAddress: 'noreply@example.com',
  fromName: 'Rezeis',
  useTls: true,
  useSsl: false,
  passwordSet: false,
}

function grant(permissions: ReadonlyArray<{ resource: string; action: RbacAction }>): void {
  usePermissionStore.setState({
    loaded: true,
    loading: false,
    granted: new Set(permissions.map((permission) => `${permission.resource}:${permission.action}`)),
    mustChangePassword: false,
    role: 'ADMIN',
    rbacRoleId: 'role-1',
    error: null,
  })
}

/**
 * `GET /admin/settings` hands the SPA the RAW stored `systemNotifications`
 * (only the credential-bearing root keys are masked), so `telegram` here is
 * literally what is in the database column.
 */
function mockGet(options: {
  readonly paymentOps?: PaymentOpsFixture
  readonly telegram?: Record<string, unknown>
}): ReturnType<typeof vi.spyOn> {
  const paymentOps = options.paymentOps ?? UNCONFIGURED
  const telegram = options.telegram ?? {}
  return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
    if (path === '/admin/settings') {
      return { data: { userNotifications: {}, systemNotifications: { telegram } } }
    }
    if (path === '/admin/settings/system-notifications/payment-ops') {
      return { data: paymentOps }
    }
    if (path === '/admin/email/settings') return { data: SMTP_SETTINGS }
    return { data: [] }
  })
}

async function openDeliveryTab(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('tab', { name: 'Delivery settings' }))
}

/** The card a title belongs to, so "Save" means the right form's Save. */
async function findCard(title: string): Promise<HTMLElement> {
  const heading = await screen.findByText(title)
  const card = heading.closest('[data-concept-surface="card"]')
  expect(card).not.toBeNull()
  return card as HTMLElement
}

beforeEach(async () => {
  // `notificationsPage.*` ships as a lazy feature bundle — without it every
  // label below renders as its raw key path.
  await loadFeatureBundle('notifications')
  toastMock.error.mockClear()
  toastMock.success.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
  usePermissionStore.getState().reset()
})

describe('payment webhook alerts can be switched on from the panel', () => {
  it('PATCHes the whole stored shape when the operator fills the form in', async () => {
    grant([{ resource: 'settings', action: 'edit' }])
    mockGet({})
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: CONFIGURED })

    renderWithProviders(<NotificationsPage />)
    const user = userEvent.setup()
    await openDeliveryTab(user)

    const card = within(await findCard('Payment webhook alerts'))
    await user.click(card.getByRole('switch', { name: 'Enable payment webhook alerts' }))
    await user.type(card.getByLabelText('Alert chat ID'), '-1003713706224')
    await user.type(card.getByLabelText('Topic ID (message_thread_id)'), '10')
    await user.clear(card.getByLabelText('Hashtag'))
    await user.type(card.getByLabelText('Hashtag'), '#billing_alerts')
    await user.click(card.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(patch).toHaveBeenCalledTimes(1)
    })
    // The request itself, field for field — `enabled` and `chatId` are the two
    // the alert service reads before deciding to send anything at all.
    expect(patch).toHaveBeenCalledWith('/admin/settings/system-notifications/payment-ops', {
      enabled: true,
      chatId: '-1003713706224',
      threadId: '10',
      hashtag: '#billing_alerts',
    })
  })

  it('sends blank optional fields as null, which is what the DTO accepts', async () => {
    grant([{ resource: 'settings', action: 'edit' }])
    mockGet({})
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: UNCONFIGURED })

    renderWithProviders(<NotificationsPage />)
    const user = userEvent.setup()
    await openDeliveryTab(user)

    const card = within(await findCard('Payment webhook alerts'))
    await user.click(card.getByRole('switch', { name: 'Enable payment webhook alerts' }))
    await user.type(card.getByLabelText('Alert chat ID'), '-1003713706224')
    await user.click(card.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(patch).toHaveBeenCalledTimes(1)
    })
    // `''` would fail the @Matches on threadId; null is the value @IsOptional
    // waves through.
    expect(patch).toHaveBeenCalledWith('/admin/settings/system-notifications/payment-ops', {
      enabled: true,
      chatId: '-1003713706224',
      threadId: null,
      hashtag: '#payments_ops',
    })
  })

  it('refuses to enable alerts with no chat id, and sends nothing', async () => {
    grant([{ resource: 'settings', action: 'edit' }])
    mockGet({})
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: UNCONFIGURED })

    renderWithProviders(<NotificationsPage />)
    const user = userEvent.setup()
    await openDeliveryTab(user)

    const card = within(await findCard('Payment webhook alerts'))
    await user.click(card.getByRole('switch', { name: 'Enable payment webhook alerts' }))
    await user.click(card.getByRole('button', { name: 'Save' }))

    expect(await card.findByText('Chat ID is required when alerts are enabled')).toBeInTheDocument()
    expect(patch).not.toHaveBeenCalled()
  })

  it('sends a real test alert through the test route so the operator can see it land', async () => {
    grant([{ resource: 'settings', action: 'edit' }])
    mockGet({ paymentOps: CONFIGURED })
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { sent: true } })

    renderWithProviders(<NotificationsPage />)
    const user = userEvent.setup()
    await openDeliveryTab(user)

    const card = within(await findCard('Payment webhook alerts'))
    await user.click(card.getByRole('button', { name: 'Send a test alert' }))

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith('/admin/settings/system-notifications/payment-ops/test')
    })
  })

  it('is not offered at all to an admin without settings:edit', async () => {
    grant([{ resource: 'settings', action: 'view' }])
    const get = mockGet({})

    renderWithProviders(<NotificationsPage />)
    const user = userEvent.setup()
    await openDeliveryTab(user)

    // The tab really did render — this is the neighbouring form on it.
    expect(await screen.findByText('Telegram delivery')).toBeInTheDocument()
    expect(screen.queryByText('Payment webhook alerts')).toBeNull()
    expect(get).not.toHaveBeenCalledWith('/admin/settings/system-notifications/payment-ops')
  })
})

describe('the telegram delivery form carries the error-report config', () => {
  const ENABLED_TELEGRAM: Record<string, unknown> = {
    enabled: true,
    chatId: '-1003713706224',
  }

  it('submits the mode the operator picked and the attachment switch they flipped', async () => {
    grant([{ resource: 'settings', action: 'edit' }])
    mockGet({ telegram: { ...ENABLED_TELEGRAM, errorReports: { mode: 'manual', telegramTxt: true } } })
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })

    renderWithProviders(<NotificationsPage />)
    const user = userEvent.setup()
    await openDeliveryTab(user)

    const card = within(await findCard('Telegram delivery'))
    await user.click(card.getByRole('button', { name: 'Automatic' }))
    await user.click(
      card.getByRole('switch', { name: 'Attach the .txt report to Telegram error messages' }),
    )
    await user.click(card.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(patch).toHaveBeenCalledTimes(1)
    })
    const [path, body] = patch.mock.calls[0] as [string, Record<string, unknown>]
    expect(path).toBe('/admin/settings/system-notifications/telegram')
    // `auto` is the only value that makes the server write the on-disk archive,
    // and it was unreachable from the panel until these controls existed.
    expect(body.errorReportMode).toBe('auto')
    expect(body.errorReportTelegramTxt).toBe(false)
  })

  it('round-trips the backend defaults when nothing was ever stored', async () => {
    grant([{ resource: 'settings', action: 'edit' }])
    mockGet({ telegram: ENABLED_TELEGRAM })
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })

    renderWithProviders(<NotificationsPage />)
    const user = userEvent.setup()
    await openDeliveryTab(user)

    const card = within(await findCard('Telegram delivery'))
    // The mode the server would report for an absent `errorReports` object.
    expect(card.getByRole('button', { name: 'On demand' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(card.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(patch).toHaveBeenCalledTimes(1)
    })
    const [, body] = patch.mock.calls[0] as [string, Record<string, unknown>]
    // Saving an untouched form must not silently change either one.
    expect(body.errorReportMode).toBe('manual')
    expect(body.errorReportTelegramTxt).toBe(true)
  })
})

/**
 * The test button is the operator's only warning that the REAL alerts cannot be
 * sent either, so a rejection has to name which of the two things is missing.
 * Both codes come from `settings.service.ts`.
 */
describe('a rejected test alert names the cause and the remedy', () => {
  async function clickTestAlert(rejection: unknown): Promise<void> {
    grant([{ resource: 'settings', action: 'edit' }])
    mockGet({ paymentOps: CONFIGURED })
    vi.spyOn(api, 'post').mockRejectedValue(rejection)

    renderWithProviders(<NotificationsPage />)
    const user = userEvent.setup()
    await openDeliveryTab(user)
    const card = within(await findCard('Payment webhook alerts'))
    await user.click(card.getByRole('button', { name: 'Send a test alert' }))
    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalled()
    })
  }

  it('points at the panel Bot Token card when no token is configured anywhere', async () => {
    await clickTestAlert({
      response: { data: { statusCode: 503, message: 'PAYMENT_OPS_ALERT_BOT_TOKEN_NOT_CONFIGURED' } },
    })

    // Not the generic "Failed to send test alert": on a panel-configured
    // deployment that toast was the operator's ONLY signal, and it named
    // neither the cause nor anywhere to go.
    const message = String(toastMock.error.mock.calls[0]?.[0] ?? '')
    expect(message).toContain('Bot Token')
    expect(message).not.toBe('Failed to send test alert')
  })

  it('points back at the chat id field when no chat is saved', async () => {
    await clickTestAlert({
      response: { data: { statusCode: 400, message: 'PAYMENT_OPS_ALERT_CHAT_NOT_CONFIGURED' } },
    })

    const message = String(toastMock.error.mock.calls[0]?.[0] ?? '')
    expect(message).toContain('chat ID')
    expect(message).not.toBe('Failed to send test alert')
  })

  it('falls back to the generic line for a cause it does not recognise', async () => {
    await clickTestAlert(new Error('Network Error'))

    expect(toastMock.error).toHaveBeenCalledWith('Failed to send test alert')
  })
})
