// TODO(rezeis-rebuild): Re-enable once the matching backend contract is rebuilt under the new schema.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PromocodesPage from '@/features/promocodes/promocodes-page'
import { promocodesApi } from '@/features/promocodes/promocodes-api'
import { i18n } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  message: vi.fn(),
  success: vi.fn(),
}))

vi.mock('sonner', () => ({ toast: toastMock }))

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn()
}

afterEach(() => {
  vi.restoreAllMocks()
  toastMock.error.mockReset()
  toastMock.message.mockReset()
  toastMock.success.mockReset()
})

function expectSensitivePromocodeValueAbsent(container: HTMLElement, value: string): void {
  expect(container).not.toHaveTextContent(value)
  expect(container.querySelector(`a[href*="${value}"]`)).not.toBeInTheDocument()
  for (const control of Array.from(container.querySelectorAll('input, textarea, select'))) {
    expect((control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value).not.toContain(value)
  }
}

function expectSensitivePromocodeValueAbsentFromToasts(value: string): void {
  const allToastCalls = [
    ...toastMock.error.mock.calls,
    ...toastMock.message.mock.calls,
    ...toastMock.success.mock.calls,
  ]
  for (const call of allToastCalls) {
    const serialized = JSON.stringify(call)
    expect(serialized).not.toContain(value)
  }
}

function unlockPromoActions(): void {
  fireEvent.click(screen.getByRole('switch', { name: 'Promo actions mode' }))
}

function confirmPromoAction(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Confirm promo action' }))
}
describe.skip('promocodes page smoke', () => {
  it('renders promo codes and activation queries safely', async () => {
    await i18n.changeLanguage('en')
    const listPromocodesSpy = vi.spyOn(promocodesApi, 'listPromocodes').mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 50,
    })
    const listActivationsSpy = vi.spyOn(promocodesApi, 'listActivations').mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 50,
    })

    renderWithProviders(<PromocodesPage />)

    expect(await screen.findByRole('heading', { name: 'Promo Codes' })).toBeInTheDocument()
    await waitFor(() => {
      expect(listPromocodesSpy).toHaveBeenCalledTimes(1)
      expect(listActivationsSpy).toHaveBeenCalledTimes(1)
    })
    expect(screen.getByText('No promo codes found.')).toBeInTheDocument()
  })

  it('submits operator activation from the activations tab', async () => {
    await i18n.changeLanguage('en')
    vi.spyOn(promocodesApi, 'listPromocodes').mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 50,
    })
    vi.spyOn(promocodesApi, 'listActivations').mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 50,
    })
    const activatePromocodeSpy = vi.spyOn(promocodesApi, 'activatePromocode').mockResolvedValue({
      success: true,
      code: 'PROMO42',
      message: 'Activation completed with raw backend success secret',
      reward: null,
      nextStep: 'NONE',
      availableSubscriptions: [],
      errorCode: null,
    })

    renderWithProviders(<PromocodesPage />)

    fireEvent.click(await screen.findByRole('tab', { name: 'Activations' }))
    expect(await screen.findByText('Operator activation')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('user_123'), { target: { value: 'user-42' } })
    fireEvent.change(screen.getByPlaceholderText('PROMO2024'), { target: { value: 'promo42' } })
    expect(screen.getByRole('button', { name: 'Activate promo code' })).toBeDisabled()
    unlockPromoActions()
    fireEvent.click(screen.getByRole('button', { name: 'Activate promo code' }))

    expect(screen.getByRole('dialog')).toHaveTextContent('Activate promo code')
    expect(activatePromocodeSpy).not.toHaveBeenCalled()
    confirmPromoAction()

    await waitFor(() => {
      expect(activatePromocodeSpy).toHaveBeenCalledTimes(1)
      expect(activatePromocodeSpy).toHaveBeenCalledWith({
        userId: 'user-42',
        code: 'PROMO42',
      })
    })

    expect(await screen.findByText('Activation completed', { selector: 'p.text-sm.font-medium' })).toBeInTheDocument()
    expect(screen.getByText('Activation completed. Backend message hidden.', { selector: 'p.text-sm.text-muted-foreground' })).toBeInTheDocument()
    expect(screen.queryByText('Activation completed with raw backend success secret')).not.toBeInTheDocument()
    expect(screen.getByText('No further action')).toBeInTheDocument()
    expect(toastMock.success).toHaveBeenCalledWith('Activation completed. Backend message hidden.')
    for (const value of ['Activation completed with raw backend success secret', 'PROMO42', 'user-42']) {
      expectSensitivePromocodeValueAbsentFromToasts(value)
    }
  })

  it('supports subscription follow-up submit with the bounded backend subscription payload', async () => {
    await i18n.changeLanguage('en')
    vi.spyOn(promocodesApi, 'listPromocodes').mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 50,
    })
    vi.spyOn(promocodesApi, 'listActivations').mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 50,
    })
    const activatePromocodeSpy = vi.spyOn(promocodesApi, 'activatePromocode')
      .mockResolvedValueOnce({
        success: false,
        code: 'PROMO42',
        message: 'Select a subscription with raw subscription secret',
        reward: null,
        nextStep: 'SELECT_SUBSCRIPTION',
        availableSubscriptions: [
          { id: 'sub-1', planId: 'plan-1', planName: 'Primary plan' },
          { id: 'sub-2', planId: 'plan-2', planName: 'Backup plan' },
        ],
        errorCode: 'PROMOCODE_SUBSCRIPTION_REQUIRED',
      })
      .mockResolvedValueOnce({
        success: true,
        code: 'PROMO42',
        message: 'Activation completed with raw backend secret',
        reward: null,
        nextStep: 'NONE',
        availableSubscriptions: [],
        errorCode: null,
      })

    renderWithProviders(<PromocodesPage />)

    fireEvent.click(await screen.findByRole('tab', { name: 'Activations' }))
    expect(await screen.findByText('Operator activation')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('user_123'), { target: { value: 'user-42' } })
    fireEvent.change(screen.getByPlaceholderText('PROMO2024'), { target: { value: 'promo42' } })
    unlockPromoActions()
    fireEvent.click(screen.getByRole('button', { name: 'Activate promo code' }))
    expect(activatePromocodeSpy).not.toHaveBeenCalled()
    confirmPromoAction()

    expect(await screen.findByText('Target subscription')).toBeInTheDocument()
    expect(screen.getByText('Action required', { selector: 'p.text-sm.font-medium' })).toBeInTheDocument()
    expect(screen.getByText('Activation requires subscription selection. Backend message hidden.', { selector: 'p.text-sm.text-muted-foreground' })).toBeInTheDocument()
    expect(screen.queryByText('Select a subscription with raw subscription secret')).not.toBeInTheDocument()
    expect(toastMock.message).toHaveBeenCalledWith('Action required', {
      description: 'Activation requires subscription selection. Backend message hidden.',
    })
    for (const value of ['Select a subscription with raw subscription secret', 'PROMO42', 'sub-1', 'sub-2']) {
      expectSensitivePromocodeValueAbsentFromToasts(value)
    }

    const subscriptionTrigger = document.getElementById('operator-activation-subscription') as HTMLElement
    subscriptionTrigger.focus()
    fireEvent.keyDown(subscriptionTrigger, { key: 'ArrowDown', code: 'ArrowDown' })
    const listbox = await screen.findByRole('listbox')
    fireEvent.click(within(listbox).getByText('Primary plan'))
    fireEvent.click(screen.getByRole('button', { name: 'Complete activation' }))
    expect(activatePromocodeSpy).toHaveBeenCalledTimes(1)
    confirmPromoAction()

    await waitFor(() => {
      expect(activatePromocodeSpy).toHaveBeenCalledTimes(2)
      expect(activatePromocodeSpy.mock.calls[1]?.[0]).toEqual({
        userId: 'user-42',
        code: 'PROMO42',
        targetSubscriptionId: 'sub-1',
      })
    })

    expect(await screen.findByText('Activation completed', { selector: 'p.text-sm.font-medium' })).toBeInTheDocument()
    expect(screen.getByText('Activation completed. Backend message hidden.', { selector: 'p.text-sm.text-muted-foreground' })).toBeInTheDocument()
    expect(screen.queryByText('Activation completed with raw backend secret')).not.toBeInTheDocument()
    expect(screen.getByText('No further action')).toBeInTheDocument()
    expect(toastMock.success).toHaveBeenCalledWith('Activation completed. Backend message hidden.')
    for (const value of ['Activation completed with raw backend secret', 'Select a subscription with raw subscription secret', 'PROMO42', 'sub-1']) {
      expectSensitivePromocodeValueAbsentFromToasts(value)
    }
  })

  it('clears stale follow-up state when the operator changes the request after a subscription-required response', async () => {
    await i18n.changeLanguage('en')
    vi.spyOn(promocodesApi, 'listPromocodes').mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 50,
    })
    vi.spyOn(promocodesApi, 'listActivations').mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 50,
    })
    const activatePromocodeSpy = vi.spyOn(promocodesApi, 'activatePromocode').mockResolvedValue({
      success: false,
      code: 'PROMO42',
        message: 'Select a subscription with raw stale secret',
      reward: null,
      nextStep: 'SELECT_SUBSCRIPTION',
      availableSubscriptions: [
        { id: 'sub-1', planId: 'plan-1', planName: 'Primary plan' },
      ],
      errorCode: 'PROMOCODE_SUBSCRIPTION_REQUIRED',
    })

    renderWithProviders(<PromocodesPage />)

    fireEvent.click(await screen.findByRole('tab', { name: 'Activations' }))
    fireEvent.change(screen.getByPlaceholderText('user_123'), { target: { value: 'user-42' } })
    fireEvent.change(screen.getByPlaceholderText('PROMO2024'), { target: { value: 'promo42' } })
    unlockPromoActions()
    fireEvent.click(screen.getByRole('button', { name: 'Activate promo code' }))
    confirmPromoAction()

    expect(await screen.findByText('Target subscription')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Complete activation' })).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('PROMO2024'), { target: { value: 'promo43' } })

    await waitFor(() => {
      expect(screen.queryByText('Target subscription')).not.toBeInTheDocument()
    })
    expect(screen.queryByText('Action required')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Activate promo code' })).toBeEnabled()
    expect(activatePromocodeSpy).toHaveBeenCalledTimes(1)
  })

  it('renders terminal NONE failures as failures without keeping follow-up state', async () => {
    await i18n.changeLanguage('en')
    vi.spyOn(promocodesApi, 'listPromocodes').mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 50,
    })
    vi.spyOn(promocodesApi, 'listActivations').mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 50,
    })
    const activatePromocodeSpy = vi.spyOn(promocodesApi, 'activatePromocode').mockResolvedValue({
      success: false,
      code: 'PROMO42',
        message: 'Activation rejected with raw backend secret',
      reward: null,
      nextStep: 'NONE',
      availableSubscriptions: [],
      errorCode: 'PROMOCODE_NOT_APPLICABLE',
    })

    renderWithProviders(<PromocodesPage />)

    fireEvent.click(await screen.findByRole('tab', { name: 'Activations' }))
    fireEvent.change(screen.getByPlaceholderText('user_123'), { target: { value: 'user-42' } })
    fireEvent.change(screen.getByPlaceholderText('PROMO2024'), { target: { value: 'promo42' } })
    unlockPromoActions()
    fireEvent.click(screen.getByRole('button', { name: 'Activate promo code' }))
    confirmPromoAction()

    await waitFor(() => {
      expect(activatePromocodeSpy).toHaveBeenCalledWith({
        userId: 'user-42',
        code: 'PROMO42',
      })
    })

    expect(await screen.findByText('Activation failed')).toBeInTheDocument()
    expect(screen.getByText('Activation failed. Backend message hidden.')).toBeInTheDocument()
    expect(screen.queryByText('Activation rejected with raw backend secret')).not.toBeInTheDocument()
    expect(screen.getByText('No further action')).toBeInTheDocument()
    expect(screen.queryByText('Target subscription')).not.toBeInTheDocument()
    expect(screen.getByText('Error code: PROMOCODE_NOT_APPLICABLE')).toBeInTheDocument()
    expect(toastMock.error).toHaveBeenCalledWith('Activation failed. Backend message hidden.')
    for (const value of ['Activation rejected with raw backend secret', 'PROMO42', 'user-42']) {
      expectSensitivePromocodeValueAbsentFromToasts(value)
    }
  })

  it('uses generic bounded copy for promo query and mutation errors', async () => {
    await i18n.changeLanguage('en')
    const rawPromoError = 'raw promo list backend error RAWCODE-ERR-001 raw-user-error-001'
    const rawActivationListError = 'raw activation list backend error raw-activation-error-001'
    vi.spyOn(promocodesApi, 'listPromocodes').mockRejectedValue(new Error(rawPromoError))
    vi.spyOn(promocodesApi, 'listActivations').mockRejectedValue(new Error(rawActivationListError))

    const failedQueryRender = renderWithProviders(<PromocodesPage />)

    expect(await screen.findByText('Unable to load promo codes.')).toBeInTheDocument()
    expect(await screen.findByText('Unable to load promo activations.')).toBeInTheDocument()
    for (const value of [rawPromoError, rawActivationListError, 'RAWCODE-ERR-001', 'raw-user-error-001', 'raw-activation-error-001']) {
      expectSensitivePromocodeValueAbsent(failedQueryRender.container, value)
    }

    failedQueryRender.unmount()
    vi.restoreAllMocks()
    toastMock.error.mockReset()

    const promo = {
      id: 'promo-error-id-001',
      code: 'RAWCODE-ERROR-001',
      codeNormalized: 'RAWCODE-ERROR-001',
      isActive: true,
      availability: 'ALL' as const,
      rewardType: 'DURATION' as const,
      rewardValue: 30,
      maxActivations: 5,
      activationsCount: 1,
      remainingUses: 4,
      allowedUserIds: [],
      allowedPlanIds: [],
      expiresAt: null,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }
    vi.spyOn(promocodesApi, 'listPromocodes').mockResolvedValue({ data: [promo], total: 1, page: 1, limit: 50 })
    vi.spyOn(promocodesApi, 'listActivations').mockResolvedValue({ data: [], total: 0, page: 1, limit: 50 })
    vi.spyOn(promocodesApi, 'togglePromocode').mockRejectedValue(new Error('raw toggle backend error RAWCODE-ERR-002'))
    vi.spyOn(promocodesApi, 'deletePromocode').mockRejectedValue(new Error('raw delete backend error RAWCODE-ERR-003'))
    vi.spyOn(promocodesApi, 'updatePromocode').mockRejectedValue(new Error('raw save backend error RAWCODE-ERR-004'))
    vi.spyOn(promocodesApi, 'activatePromocode').mockRejectedValue(new Error('raw activate backend error RAWCODE-ERR-005 raw-subscription-error-001'))

    const mutationRender = renderWithProviders(<PromocodesPage />)
    expect(await screen.findByText('Promo code hidden')).toBeInTheDocument()
    unlockPromoActions()

    fireEvent.click(screen.getByRole('button', { name: 'Toggle promo status' }))
    confirmPromoAction()
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Unable to toggle promo code status.'))

    fireEvent.click(screen.getByRole('button', { name: 'Delete promo code' }))
    confirmPromoAction()
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Unable to delete promo code.'))

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Save changes' }))
    confirmPromoAction()
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Unable to save promo code.'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.click(await screen.findByRole('tab', { name: 'Activations' }))
    fireEvent.change(screen.getByPlaceholderText('user_123'), { target: { value: 'user-error-1' } })
    fireEvent.change(screen.getByPlaceholderText('PROMO2024'), { target: { value: 'rawcode-error-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Activate promo code' }))
    confirmPromoAction()
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Unable to activate promo code.'))

    for (const value of ['raw toggle backend error', 'raw delete backend error', 'raw save backend error', 'raw activate backend error', 'RAWCODE-ERR-002', 'RAWCODE-ERR-003', 'RAWCODE-ERR-004', 'RAWCODE-ERR-005', 'raw-subscription-error-001']) {
      expectSensitivePromocodeValueAbsent(mutationRender.container, value)
    }
    for (const call of toastMock.error.mock.calls) {
      expect(call.join(' ')).not.toContain('RAWCODE-ERR')
      expect(call.join(' ')).not.toContain('raw-subscription-error-001')
      expect(call.join(' ')).not.toContain('raw backend')
    }
  })

  it('hides raw promo codes and subscription identifiers in catalog and activation history', async () => {
    await i18n.changeLanguage('en')
    const expiringSoon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
    vi.spyOn(promocodesApi, 'listPromocodes').mockResolvedValue({
      data: [
        {
          id: 'promo-id-001',
          code: 'RAWCODE-SENSITIVE-001',
          codeNormalized: 'RAWCODE-SENSITIVE-001',
          isActive: true,
          availability: 'ALLOWED',
          rewardType: 'DURATION',
          rewardValue: 30,
          maxActivations: 5,
          activationsCount: 1,
          remainingUses: 4,
          allowedUserIds: ['raw-user-id-sensitive-001'],
          allowedPlanIds: ['raw-plan-id-sensitive-001'],
          expiresAt: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
        {
          id: 'promo-id-002',
          code: 'RAWCODE-SENSITIVE-002',
          codeNormalized: 'RAWCODE-SENSITIVE-002',
          isActive: false,
          availability: 'NEW',
          rewardType: 'TRAFFIC',
          rewardValue: 1000000000,
          maxActivations: 1,
          activationsCount: 1,
          remainingUses: 0,
          allowedUserIds: [],
          allowedPlanIds: [],
          expiresAt: expiringSoon,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      total: 2,
      page: 1,
      limit: 50,
    })
    vi.spyOn(promocodesApi, 'listActivations').mockResolvedValue({
      data: [
        {
          id: 'activation-id-001',
          code: 'RAWCODE-SENSITIVE-001',
          userId: 'raw-user-id-sensitive-001',
          promoCodeId: 'promo-id-001',
          rewardType: 'DURATION',
          rewardValue: 30,
          rewardSnapshot: { rawRewardSecret: 'raw-reward-snapshot-sensitive-001' },
          promoCodeSnapshot: { rawCode: 'raw-snapshot-code-sensitive-001' },
          targetSubscriptionId: 'raw-subscription-id-sensitive-001',
          targetSubscriptionSnapshot: { rawSubscriptionUuid: 'raw-subscription-snapshot-sensitive-001' },
          activatedAt: '2025-01-02T00:00:00.000Z',
          user: null,
        },
      ],
      total: 1,
      page: 1,
      limit: 50,
    })

    renderWithProviders(<PromocodesPage />)

    expect(await screen.findByText('Promo campaign insights')).toBeInTheDocument()
    expect(screen.getByText('Total promos')).toBeInTheDocument()
    expect(screen.getByText('Active promos')).toBeInTheDocument()
    expect(screen.getByText('Inactive promos')).toBeInTheDocument()
    expect(screen.getByText('Exhausted promos')).toBeInTheDocument()
    expect(screen.getByText('Expiring in 7 days')).toBeInTheDocument()
    expect(screen.getByText('Subscription-targeted activations')).toBeInTheDocument()
    expect((await screen.findAllByText('Promo code hidden')).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('DURATION').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('TRAFFIC').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('ALLOWED').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('NEW').length).toBeGreaterThanOrEqual(1)
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0])
    expect(await screen.findByRole('dialog', { name: 'Edit promo code' })).toBeInTheDocument()
    expect(screen.queryByText('Edit promo code: RAWCODE-SENSITIVE-001')).not.toBeInTheDocument()
    expect(screen.getByDisplayValue('RAWCODE-SENSITIVE-001')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit promo code' })).not.toBeInTheDocument()
    })
    fireEvent.click(await screen.findByRole('tab', { name: 'Activations' }))
    expect(await screen.findByText('Activation History')).toBeInTheDocument()

    expect(screen.getAllByText('Promo code hidden').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('User hidden')).toBeInTheDocument()
    expect(screen.getByText('Extends subscription duration')).toBeInTheDocument()
    expect(screen.getByText('Activation snapshots captured')).toBeInTheDocument()
    expect(screen.getByText('User reference hidden')).toBeInTheDocument()
    expect(screen.getByText('Target subscription hidden')).toBeInTheDocument()
    expect(screen.queryByText('RAWCODE-SENSITIVE-001')).not.toBeInTheDocument()
    expect(screen.queryByText('RAWCODE-SENSITIVE-002')).not.toBeInTheDocument()
    expect(screen.queryByText('raw-user-id-sensitive-001')).not.toBeInTheDocument()
    expect(screen.queryByText('activation-id-001')).not.toBeInTheDocument()
    expect(screen.queryByText('raw-plan-id-sensitive-001')).not.toBeInTheDocument()
    expect(screen.queryByText('raw-subscription-id-sensitive-001')).not.toBeInTheDocument()
    expect(screen.queryByText('raw-reward-snapshot-sensitive-001')).not.toBeInTheDocument()
    expect(screen.queryByText('raw-snapshot-code-sensitive-001')).not.toBeInTheDocument()
    expect(screen.queryByText('raw-subscription-snapshot-sensitive-001')).not.toBeInTheDocument()
  })
})
