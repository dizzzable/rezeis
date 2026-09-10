import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { i18n, i18nReady, loadFeatureBundle } from '@/i18n/i18n';
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

/**
 * The sentence a key renders right now — looked up, never restated.
 *
 * Not one string in this file is a claim about wording. They are LOCATORS: find
 * the destructive button, find the dialog it opens, find the field labelled for
 * the screen reader. Typed out, they put a second owner on copy that already has
 * one in `i18n/features/automations-copy-truth.test.ts` — nine sentences over
 * twelve places, so a single label correction turns both cases here red for a
 * reason they have nothing to do with, and the pressure that creates is to
 * loosen the matcher rather than to fix it.
 *
 * `not.toBe(key)` is the half that matters most. i18next answers a miss with the
 * key path, so a RENAMED key would otherwise hand `getByRole` a name nothing on
 * screen carries — and a locator that matches nothing is how an accessibility
 * case stops being an accessibility case without going red anywhere.
 */
function says(key: string, values?: Record<string, unknown>): string {
  const sentence = String(i18n.t(key, values ?? {}))
  expect(sentence, `${key} is missing from the loaded bundles`).not.toBe(key)
  return sentence
}

describe('AutomationsPage accessibility', () => {
  beforeEach(() => {
    vi.mocked(getCatalog).mockResolvedValue({ actionTypes: ['notify_telegram'], coincidentEventGroups: [] })
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
    // `common.cancel` lives in the core locale chunk, not the automations
    // bundle, and it arrives through a dynamic import that nothing here awaited.
    await i18nReady
    await loadFeatureBundle('automations')

    renderWithProviders(<AutomationsPage />)

    await screen.findByDisplayValue('Payment failure alert')
    const destructive = says('automationsPage.editor.delete')
    await user.click(screen.getByRole('button', { name: destructive }))

    const dialog = await screen.findByRole('alertdialog', { name: destructive })
    // The rule's own name, interpolated: "Delete this rule?" on a page listing
    // several is a question an operator cannot answer.
    expect(dialog).toHaveTextContent(
      says('automationsPage.editor.deleteConfirm', { name: 'Payment failure alert' }),
    )
    expect(deleteRule).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: says('common.cancel') }))
    expect(deleteRule).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: destructive }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: destructive }),
    )

    await waitFor(() => {
      expect(deleteRule).toHaveBeenCalledWith('rule-1')
    })
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('names automation editor configuration controls', async () => {
    await i18nReady
    await loadFeatureBundle('automations')

    renderWithProviders(<AutomationsPage />)

    expect(
      await screen.findByRole('textbox', { name: says('automationsPage.config.name') }),
    ).toHaveValue('Payment failure alert')
    expect(
      screen.getByRole('combobox', { name: says('automationsPage.config.trigger') }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('textbox', { name: says('automationsPage.config.description') }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('textbox', { name: says('automationsPage.config.eventPattern') }),
    ).toHaveValue('payment.failed')
    expect(
      screen.getByRole('textbox', { name: says('automationsPage.config.conditionsLabel') }),
    ).toBeInTheDocument()
    // Composed exactly as the page composes it — heading plus a 1-based index —
    // rather than as the finished string, so the index stays part of the claim.
    expect(
      screen.getByRole('combobox', { name: `${says('automationsPage.actions.heading')} 1` }),
    ).toBeInTheDocument()
  })
})
