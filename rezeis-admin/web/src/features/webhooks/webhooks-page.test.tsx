import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { i18n } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'
import WebhooksPage from './webhooks-page'
import {
  createWebhookSubscription,
  deleteWebhookSubscription,
  getWebhookEventCatalog,
  listWebhookDeliveries,
  listWebhookSubscriptions,
  regenerateWebhookSecret,
  replayWebhookDelivery,
  testWebhookSubscription,
  updateWebhookSubscription,
} from './webhooks-api'

vi.mock('./webhooks-api', () => ({
  createWebhookSubscription: vi.fn(),
  deleteWebhookSubscription: vi.fn(),
  getWebhookEventCatalog: vi.fn(),
  listWebhookDeliveries: vi.fn(),
  listWebhookSubscriptions: vi.fn(),
  regenerateWebhookSecret: vi.fn(),
  replayWebhookDelivery: vi.fn(),
  testWebhookSubscription: vi.fn(),
  updateWebhookSubscription: vi.fn(),
}))

describe('WebhooksPage accessibility', () => {
  beforeEach(() => {
    vi.mocked(getWebhookEventCatalog).mockResolvedValue([])
    vi.mocked(listWebhookDeliveries).mockResolvedValue({ items: [], nextCursor: null })
    vi.mocked(listWebhookSubscriptions).mockResolvedValue({
      items: [
        {
          id: 'webhook-1',
          name: 'Slack alerts',
          url: 'https://example.com/hooks/rezeis',
          secret: null,
          eventTypes: [],
          description: null,
          isActive: true,
          createdById: 'admin-1',
          lastDeliveredAt: null,
          consecutiveFailures: 0,
          totalDeliveries: 4,
          totalFailures: 0,
          autoDisabledAt: null,
          createdAt: '2026-06-04T10:00:00.000Z',
          updatedAt: '2026-06-04T10:00:00.000Z',
        },
      ],
      total: 1,
    })
    vi.mocked(createWebhookSubscription).mockResolvedValue({} as never)
    vi.mocked(deleteWebhookSubscription).mockResolvedValue(undefined)
    vi.mocked(regenerateWebhookSecret).mockResolvedValue({} as never)
    vi.mocked(replayWebhookDelivery).mockResolvedValue({ newDeliveryId: 'delivery-2' })
    vi.mocked(testWebhookSubscription).mockResolvedValue({ deliveryId: 'delivery-1' })
    vi.mocked(updateWebhookSubscription).mockResolvedValue({} as never)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('uses an accessible alert dialog before deleting a subscription', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)

    renderWithProviders(<WebhooksPage />)

    await user.click(await screen.findByRole('button', { name: 'Delete' }))

    const dialog = await screen.findByRole('alertdialog', { name: 'Delete' })
    expect(dialog).toHaveTextContent('Delete "Slack alerts"? Delivery history will be removed.')
    expect(deleteWebhookSubscription).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(deleteWebhookSubscription).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(deleteWebhookSubscription).toHaveBeenCalledWith('webhook-1')
    })
    expect(confirmSpy).not.toHaveBeenCalled()
  })
})

describe('where the panel does not send a webhook, on this page', () => {
  // Russian, because the reason arrives in English and the point is that the
  // operator reads it in their own language.
  beforeEach(async () => {
    vi.mocked(getWebhookEventCatalog).mockResolvedValue([])
    vi.mocked(listWebhookSubscriptions).mockResolvedValue({ items: [], total: 0 })
    await i18n.changeLanguage('ru')
  })

  afterEach(async () => {
    // Unmount first: switching the language back under a mounted page
    // re-renders it outside `act`.
    cleanup()
    await i18n.changeLanguage('en')
    vi.clearAllMocks()
  })

  it('shows a refused delivery’s reason in the delivery log, in words', async () => {
    vi.mocked(listWebhookDeliveries).mockResolvedValue({
      items: [
        {
          id: 'delivery-9',
          subscriptionId: 'webhook-1',
          subscriptionName: 'Docker',
          eventType: 'payment.completed',
          status: 'FAILED',
          attempt: 1,
          httpStatus: null,
          responseBody: null,
          errorMessage: 'Refused before sending: the URL points at a loopback address (127.0.0.0/8)',
          durationMs: 0,
          nextRetryAt: null,
          startedAt: '2026-09-18T10:00:00.000Z',
          finishedAt: '2026-09-18T10:00:00.000Z',
          createdAt: '2026-09-18T10:00:00.000Z',
        },
      ],
      nextCursor: null,
    })

    renderWithProviders(<WebhooksPage />)

    expect(await screen.findByText('Не отправлено: URL указывает на адрес loopback (127.0.0.0/8).')).toBeInTheDocument()
    expect(screen.queryByText(/Refused before sending/)).not.toBeInTheDocument()
  })

  it('says why a subscription URL was refused, in words', async () => {
    vi.mocked(listWebhookDeliveries).mockResolvedValue({ items: [], nextCursor: null })
    vi.mocked(createWebhookSubscription).mockRejectedValue({
      isAxiosError: true,
      message: 'Request failed with status code 400',
      response: {
        status: 400,
        data: {
          statusCode: 400,
          message: 'The panel does not send webhooks there: the URL points at a loopback address (127.0.0.0/8)',
        },
      },
    })
    const user = userEvent.setup()
    renderWithProviders(<WebhooksPage />)

    await user.type(await screen.findByLabelText('Название'), 'Docker')
    await user.type(screen.getByLabelText('URL'), 'http://127.0.0.1:2375/containers/create')
    await user.click(screen.getByRole('button', { name: 'Создать' }))

    expect(
      await screen.findByText('Панель не отправляет вебхуки на этот адрес: URL указывает на адрес loopback (127.0.0.0/8).'),
    ).toBeInTheDocument()
  })
})
