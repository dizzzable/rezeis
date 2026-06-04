import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { loadFeatureBundle } from '@/i18n/i18n';
import { renderWithProviders } from '@/test/test-utils';
import AutomationsPage from './automations-page';
import {
  createRule,
  deleteRule,
  getCatalog,
  getRule,
  listExecutions,
  listRules,
  runRuleManually,
  toggleRule,
  updateRule,
} from './automations-api';

vi.mock('./automations-api', () => ({
  createRule: vi.fn(),
  deleteRule: vi.fn(),
  getCatalog: vi.fn(),
  getRule: vi.fn(),
  listExecutions: vi.fn(),
  listRules: vi.fn(),
  runRuleManually: vi.fn(),
  toggleRule: vi.fn(),
  updateRule: vi.fn(),
}))

describe('AutomationsPage accessibility', () => {
  beforeEach(() => {
    vi.mocked(getCatalog).mockResolvedValue({ actionTypes: ['notify_telegram'] })
    vi.mocked(listRules).mockResolvedValue([
      {
        id: 'rule-1',
        name: 'Payment failure alert',
        description: null,
        isEnabled: true,
        triggerKind: 'REALTIME',
        triggerSpec: 'payment.failed',
        conditions: null,
        actions: [{ type: 'notify_telegram', params: { text: 'Payment failed' } }],
        createdById: 'admin-1',
        lastRunAt: null,
        lastRunStatus: null,
        lastRunMessage: null,
        runCount: 0,
        createdAt: '2026-06-04T10:00:00.000Z',
        updatedAt: '2026-06-04T10:00:00.000Z',
      },
    ])
    vi.mocked(getRule).mockResolvedValue({
      id: 'rule-1',
      name: 'Payment failure alert',
      description: null,
      isEnabled: true,
      triggerKind: 'REALTIME',
      triggerSpec: 'payment.failed',
      conditions: null,
      actions: [{ type: 'notify_telegram', params: { text: 'Payment failed' } }],
      createdById: 'admin-1',
      lastRunAt: null,
      lastRunStatus: null,
      lastRunMessage: null,
      runCount: 0,
      createdAt: '2026-06-04T10:00:00.000Z',
      updatedAt: '2026-06-04T10:00:00.000Z',
    })
    vi.mocked(listExecutions).mockResolvedValue({ items: [], nextCursor: null })
    vi.mocked(createRule).mockResolvedValue({} as never)
    vi.mocked(deleteRule).mockResolvedValue(undefined)
    vi.mocked(runRuleManually).mockResolvedValue({ executionId: 'execution-1', status: 'SUCCEEDED', actionResults: [], errorMessage: null })
    vi.mocked(toggleRule).mockResolvedValue({} as never)
    vi.mocked(updateRule).mockResolvedValue({} as never)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('uses an accessible alert dialog before deleting a rule', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await loadFeatureBundle('automations')

    renderWithProviders(<AutomationsPage />)

    await screen.findByDisplayValue('Payment failure alert')
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    const dialog = await screen.findByRole('alertdialog', { name: 'Delete' })
    expect(dialog).toHaveTextContent('Delete rule "Payment failure alert"?')
    expect(deleteRule).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(deleteRule).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(deleteRule).toHaveBeenCalledWith('rule-1')
    })
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('names automation editor configuration controls', async () => {
    await loadFeatureBundle('automations')

    renderWithProviders(<AutomationsPage />)

    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('Payment failure alert')
    expect(screen.getByRole('combobox', { name: 'Trigger' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Description' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Event pattern' })).toHaveValue('payment.failed')
    expect(screen.getByRole('textbox', { name: 'Conditions (JSON-logic-ish, optional)' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Actions 1' })).toBeInTheDocument()
  })
})
