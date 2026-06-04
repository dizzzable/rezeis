import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

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
