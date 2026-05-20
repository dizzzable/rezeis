// TODO(rezeis-rebuild): Re-enable once the matching backend contract is rebuilt under the new schema.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PartnersPage from '@/features/partners/partners-page'
import { partnersAdminApi } from '@/features/partners/partners-api'
import { i18n } from '@/i18n/i18n'
import { renderWithProviders } from '@/test/test-utils'

function expectSensitiveStringAbsent(container: HTMLElement, value: string): void {
  expect(container).not.toHaveTextContent(value)
  expect(container.querySelector(`a[href*="${value}"]`)).not.toBeInTheDocument()

  const controls = Array.from(container.querySelectorAll('input, textarea, select'))
  for (const control of controls) {
    const field = control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    expect(field.value).not.toContain(value)
  }
}
describe.skip('partners page smoke', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    await i18n.changeLanguage('en')
    window.history.pushState({}, '', '/')
  })

  it('renders translated partner workflow, sends the typed create payload, and gates actions by status', async () => {
    await i18n.changeLanguage('en')

    const summarySpy = vi.spyOn(partnersAdminApi, 'getSummary').mockResolvedValue({
      userId: 'user-1',
      partnerId: 'partner-1',
      balance: 1000,
      totalEarned: 5000,
      totalWithdrawn: 2500,
      referralsCount: 5,
      level2ReferralsCount: 2,
      level3ReferralsCount: 1,
      isActive: true,
    })
    const earningsSpy = vi.spyOn(partnersAdminApi, 'listEarnings').mockResolvedValue([
      {
        id: 'earning-1',
        partnerId: 'raw-partner-1',
        referralTelegramId: '777000',
        level: 'LEVEL_1',
        paymentAmount: 1000,
        percent: '10.00',
        earnedAmount: 100,
        sourceTransactionId: 'raw-source-transaction-1',
        description: 'First payment',
        createdAt: '2026-04-20T00:00:00Z',
      },
    ])
    const withdrawalsSpy = vi.spyOn(partnersAdminApi, 'listWithdrawals').mockResolvedValue([
      {
        id: 'raw-withdrawal-1',
        partnerId: 'raw-partner-1',
        amount: 300,
        requestedAmount: '300',
        requestedCurrency: 'USDT',
        quoteRate: '1',
        quoteSource: 'MANUAL_BASELINE',
        status: 'PENDING',
        method: 'USDT',
        requisites: 'raw-wallet-secret-1',
        adminComment: null,
        processedBy: null,
        createdAt: '2026-04-20T00:00:00Z',
        updatedAt: '2026-04-20T00:00:00Z',
      },
      {
        id: 'raw-withdrawal-2',
        partnerId: 'raw-partner-1',
        amount: 450,
        requestedAmount: '450',
        requestedCurrency: 'USDT',
        quoteRate: '1',
        quoteSource: 'MANUAL_BASELINE',
        status: 'PROCESSING',
        method: 'BANK',
        requisites: 'raw-iban-secret-1',
        adminComment: 'raw-backend-comment-1',
        processedBy: 'raw-admin-1',
        createdAt: '2026-04-21T00:00:00Z',
        updatedAt: '2026-04-21T00:00:00Z',
      },
    ])
    vi.spyOn(partnersAdminApi, 'listWithdrawalAuditEvents').mockResolvedValue([{ action: 'CREATE_PARTNER_WITHDRAWAL_REQUEST', withdrawalId: 'raw-withdrawal-audit-1', partnerId: 'raw-partner-audit-1', balanceReserved: true, balanceRefunded: null, createdAt: '2026-04-20T00:00:00.000Z' }])
    const createSpy = vi.spyOn(partnersAdminApi, 'createWithdrawal').mockResolvedValue({
      id: 'withdrawal-3',
      partnerId: 'partner-1',
      amount: 275,
      requestedAmount: '275',
      requestedCurrency: 'EUR',
      quoteRate: '0.9',
      quoteSource: 'MANUAL_BASELINE',
      status: 'PENDING',
      method: 'SEPA',
      requisites: 'DE123',
      adminComment: null,
      processedBy: null,
      createdAt: '2026-04-22T00:00:00Z',
      updatedAt: '2026-04-22T00:00:00Z',
    })
    const approveSpy = vi.spyOn(partnersAdminApi, 'approveWithdrawal').mockResolvedValue({
      id: 'raw-withdrawal-1',
      partnerId: 'raw-partner-1',
      amount: 300,
      requestedAmount: '300',
      requestedCurrency: 'USDT',
      quoteRate: '1',
      quoteSource: 'MANUAL_BASELINE',
      status: 'PROCESSING',
      method: 'USDT',
      requisites: 'raw-wallet-secret-1',
      adminComment: null,
      processedBy: 'raw-admin-1',
      createdAt: '2026-04-20T00:00:00Z',
      updatedAt: '2026-04-20T00:00:00Z',
    })
    const completeSpy = vi.spyOn(partnersAdminApi, 'completeWithdrawal').mockResolvedValue({
      id: 'raw-withdrawal-2',
      partnerId: 'raw-partner-1',
      amount: 450,
      requestedAmount: '450',
      requestedCurrency: 'USDT',
      quoteRate: '1',
      quoteSource: 'MANUAL_BASELINE',
      status: 'COMPLETED',
      method: 'BANK',
      requisites: 'raw-iban-secret-1',
      adminComment: 'settled',
      processedBy: 'raw-admin-1',
      createdAt: '2026-04-21T00:00:00Z',
      updatedAt: '2026-04-22T00:00:00Z',
    })

    const { container } = renderWithProviders(<PartnersPage />)

    expect(screen.getByText('Partner workflow is waiting for a user')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('User UUID'), { target: { value: 'user-1' } })
    fireEvent.change(screen.getByLabelText('Requested amount'), { target: { value: '275' } })
    fireEvent.change(screen.getByLabelText('Requested currency'), { target: { value: 'EUR' } })
    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'SEPA' } })
    fireEvent.change(screen.getByLabelText('Requisites'), { target: { value: 'DE123' } })

    expect(screen.getByRole('button', { name: 'Create withdrawal' })).toBeDisabled()
    fireEvent.click(screen.getByLabelText('Partner actions mode'))
    fireEvent.click(screen.getByRole('button', { name: 'Create withdrawal' }))
    expect(createSpy).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Confirm partner action' })).toBeInTheDocument()
    expect(screen.getByText('Selected user hidden')).toBeInTheDocument()
    expect(screen.getByText('Configured — value hidden')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))

    await waitFor(() =>
      expect(createSpy).toHaveBeenCalledWith({
        userId: 'user-1',
        requestedAmount: 275,
        requestedCurrency: 'EUR',
        method: 'SEPA',
        requisites: 'DE123',
      }),
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Load partner state' })).toBeEnabled()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Load partner state' }))

    await waitFor(() => {
      expect(summarySpy).toHaveBeenCalledWith('user-1')
      expect(earningsSpy).toHaveBeenCalledWith('user-1')
      expect(withdrawalsSpy).toHaveBeenCalledWith('user-1')
    })

    expect(await screen.findByRole('heading', { name: 'Partner Program' })).toBeInTheDocument()
    expect(screen.getByText('5000')).toBeInTheDocument()
    expect(screen.getByText('LEVEL_1 • +100')).toBeInTheDocument()
    expect(screen.getByText('Pending • 300 USDT')).toBeInTheDocument()
    expect(screen.getByText('Processing • 450 USDT')).toBeInTheDocument()
    expect(screen.getAllByText('Configured — value hidden').length).toBeGreaterThanOrEqual(1)

    for (const value of ['raw-wallet-secret-1', 'raw-iban-secret-1', 'raw-backend-comment-1', 'raw-admin-1', 'raw-withdrawal-1', 'raw-withdrawal-2', 'raw-partner-1', 'raw-withdrawal-audit-1', 'raw-partner-audit-1', 'raw-source-transaction-1']) {
      expectSensitiveStringAbsent(container, value)
    }

    const pendingRow = screen.getByTestId('withdrawal-row-0')
    const processingRow = screen.getByTestId('withdrawal-row-1')

    expect(within(pendingRow).getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(within(pendingRow).getByRole('button', { name: 'Reject' })).toBeInTheDocument()
    expect(within(pendingRow).queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument()
    expect(within(processingRow).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(within(processingRow).getByRole('button', { name: 'Complete' })).toBeInTheDocument()

    fireEvent.change(within(pendingRow).getByLabelText('Admin comment'), { target: { value: 'approved' } })
    fireEvent.change(within(processingRow).getByLabelText('Admin comment'), { target: { value: 'settled' } })

    fireEvent.click(within(pendingRow).getByRole('button', { name: 'Approve' }))
    expect(approveSpy).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Confirm partner action' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))
    await waitFor(() => expect(approveSpy).toHaveBeenCalledWith('raw-withdrawal-1', 'approved'))
    expect(await screen.findByText('Processing • 300 USDT')).toBeInTheDocument()

    fireEvent.click(within(processingRow).getByRole('button', { name: 'Complete' }))
    expect(completeSpy).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Confirm partner action' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))
    await waitFor(() => expect(completeSpy).toHaveBeenCalledWith('raw-withdrawal-2', 'settled'))
    expect(await screen.findByText('Completed • 450 USDT')).toBeInTheDocument()
  })

  it('keeps comments isolated per row and shows translated workflow copy', async () => {
    await i18n.changeLanguage('ru')

    vi.spyOn(partnersAdminApi, 'getSummary').mockResolvedValue({
      userId: 'user-2',
      partnerId: 'partner-2',
      balance: 0,
      totalEarned: 0,
      totalWithdrawn: 0,
      referralsCount: 0,
      level2ReferralsCount: 0,
      level3ReferralsCount: 0,
      isActive: false,
    })
    vi.spyOn(partnersAdminApi, 'listEarnings').mockResolvedValue([])
    vi.spyOn(partnersAdminApi, 'listWithdrawals').mockResolvedValue([
      {
        id: 'withdrawal-a',
        partnerId: 'partner-2',
        amount: 100,
        requestedAmount: '100',
        requestedCurrency: 'USDT',
        quoteRate: '1',
        quoteSource: null,
        status: 'PENDING',
        method: 'USDT',
        requisites: 'wallet-a',
        adminComment: null,
        processedBy: null,
        createdAt: '2026-04-20T00:00:00Z',
        updatedAt: '2026-04-20T00:00:00Z',
      },
      {
        id: 'withdrawal-b',
        partnerId: 'partner-2',
        amount: 200,
        requestedAmount: '200',
        requestedCurrency: 'USDT',
        quoteRate: '1',
        quoteSource: null,
        status: 'REJECTED',
        method: 'USDT',
        requisites: 'wallet-b',
        adminComment: 'duplicate',
        processedBy: 'admin-2',
        createdAt: '2026-04-21T00:00:00Z',
        updatedAt: '2026-04-21T00:00:00Z',
      },
    ])
    vi.spyOn(partnersAdminApi, 'listWithdrawalAuditEvents').mockResolvedValue([])

    renderWithProviders(<PartnersPage />)

    expect(screen.getByText('Партнёрский сценарий ждёт пользователя')).toBeInTheDocument()
    expect(screen.getByText('Сначала выберите пользователя, чтобы создать новую заявку на вывод из существующего admin seam.')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('UUID пользователя'), { target: { value: 'user-2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Загрузить партнёрское состояние' }))

    expect(await screen.findByRole('heading', { name: 'Партнёрская программа' })).toBeInTheDocument()
    expect(screen.getByText('История начислений пока пуста')).toBeInTheDocument()

    const firstRow = screen.getByTestId('withdrawal-row-0')
    const secondRow = screen.getByTestId('withdrawal-row-1')

    fireEvent.change(within(firstRow).getByLabelText('Комментарий администратора'), { target: { value: 'только первая строка' } })

    expect(within(firstRow).getByDisplayValue('только первая строка')).toBeInTheDocument()
    expect(within(secondRow).queryByDisplayValue('только первая строка')).not.toBeInTheDocument()
    expect(within(secondRow).getByText('Эта отклонённая заявка уже закрыта для изменений в этом bounded workflow.')).toBeInTheDocument()
  })

  it('hydrates from user search handoff and links back to the user cockpit', async () => {
    await i18n.changeLanguage('en')
    const summarySpy = vi.spyOn(partnersAdminApi, 'getSummary').mockResolvedValue({
      userId: 'user-2',
      partnerId: 'partner-2',
      balance: 125,
      totalEarned: 200,
      totalWithdrawn: 75,
      referralsCount: 2,
      level2ReferralsCount: 0,
      level3ReferralsCount: 0,
      isActive: true,
    })
    const earningsSpy = vi.spyOn(partnersAdminApi, 'listEarnings').mockResolvedValue([])
    const withdrawalsSpy = vi.spyOn(partnersAdminApi, 'listWithdrawals').mockResolvedValue([])
    vi.spyOn(partnersAdminApi, 'listWithdrawalAuditEvents').mockResolvedValue([])

    const { container } = renderWithProviders(<PartnersPage />, { route: '/growth/partners?userId=user-2' })

    expect(screen.getByDisplayValue('user-2')).toBeInTheDocument()
    expect(screen.getByText('Opened from user search. Keep withdrawal handling status-gated and return to the full support cockpit when done.')).toBeInTheDocument()
    expect(container.querySelector('a[href*="user-2"]')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Load partner state' }))

    await waitFor(() => {
      expect(summarySpy).toHaveBeenCalledWith('user-2')
      expect(earningsSpy).toHaveBeenCalledWith('user-2')
      expect(withdrawalsSpy).toHaveBeenCalledWith('user-2')
    })
    expect(await screen.findByText('125')).toBeInTheDocument()
  })

  it('hides raw partner load and mutation errors behind bounded copy', async () => {
    await i18n.changeLanguage('en')
    const rawLoadError = 'raw-partner-load-error raw-wallet-load-001 raw-partner-secret-load-001'
    const rawCreateError = 'raw-partner-create-error raw-wallet-create-001 raw-partner-secret-create-001'
    const rawApproveError = 'raw-partner-approve-error raw-withdrawal-approve-001 raw-admin-secret-approve-001'
    const rawRejectError = 'raw-partner-reject-error raw-withdrawal-reject-001 raw-admin-secret-reject-001'
    const rawCompleteError = 'raw-partner-complete-error raw-withdrawal-complete-001 raw-admin-secret-complete-001'

    const summarySpy = vi.spyOn(partnersAdminApi, 'getSummary')
      .mockRejectedValueOnce(new Error(rawLoadError))
      .mockResolvedValue({
        userId: 'user-error',
        partnerId: 'raw-partner-error-001',
        balance: 1000,
        totalEarned: 5000,
        totalWithdrawn: 2500,
        referralsCount: 5,
        level2ReferralsCount: 2,
        level3ReferralsCount: 1,
        isActive: true,
      })
    vi.spyOn(partnersAdminApi, 'listEarnings').mockResolvedValue([])
    vi.spyOn(partnersAdminApi, 'listWithdrawals').mockResolvedValue([
      { id: 'raw-withdrawal-approve-001', partnerId: 'raw-partner-error-001', amount: 300, requestedAmount: '300', requestedCurrency: 'USDT', quoteRate: '1', quoteSource: 'MANUAL_BASELINE', status: 'PENDING', method: 'USDT', requisites: 'raw-wallet-approve-001', adminComment: null, processedBy: null, createdAt: '2026-04-20T00:00:00Z', updatedAt: '2026-04-20T00:00:00Z' },
      { id: 'raw-withdrawal-complete-001', partnerId: 'raw-partner-error-001', amount: 450, requestedAmount: '450', requestedCurrency: 'USDT', quoteRate: '1', quoteSource: 'MANUAL_BASELINE', status: 'PROCESSING', method: 'BANK', requisites: 'raw-wallet-complete-001', adminComment: 'raw-backend-comment-error-001', processedBy: 'raw-admin-error-001', createdAt: '2026-04-21T00:00:00Z', updatedAt: '2026-04-21T00:00:00Z' },
    ])
    vi.spyOn(partnersAdminApi, 'listWithdrawalAuditEvents').mockResolvedValue([{ action: 'CREATE_PARTNER_WITHDRAWAL_REQUEST', withdrawalId: 'raw-withdrawal-audit-error-001', partnerId: 'raw-partner-audit-error-001', balanceReserved: true, balanceRefunded: null, createdAt: '2026-04-20T00:00:00.000Z' }])
    vi.spyOn(partnersAdminApi, 'createWithdrawal').mockRejectedValue(new Error(rawCreateError))
    vi.spyOn(partnersAdminApi, 'approveWithdrawal').mockRejectedValue(new Error(rawApproveError))
    vi.spyOn(partnersAdminApi, 'rejectWithdrawal').mockRejectedValue(new Error(rawRejectError))
    vi.spyOn(partnersAdminApi, 'completeWithdrawal').mockRejectedValue(new Error(rawCompleteError))

    const { container } = renderWithProviders(<PartnersPage />)

    fireEvent.change(screen.getByLabelText('User UUID'), { target: { value: 'user-error' } })
    fireEvent.click(screen.getByRole('button', { name: 'Load partner state' }))
    expect(await screen.findByText('Unable to load partner state.')).toBeInTheDocument()
    expectSensitiveStringAbsent(container, rawLoadError)
    expectSensitiveStringAbsent(container, 'raw-wallet-load-001')
    expectSensitiveStringAbsent(container, 'raw-partner-secret-load-001')

    fireEvent.change(screen.getByLabelText('Requested amount'), { target: { value: '275' } })
    fireEvent.change(screen.getByLabelText('Requested currency'), { target: { value: 'EUR' } })
    fireEvent.change(screen.getByLabelText('Method'), { target: { value: 'SEPA' } })
    fireEvent.change(screen.getByLabelText('Requisites'), { target: { value: 'DE123' } })
    fireEvent.click(screen.getByLabelText('Partner actions mode'))
    fireEvent.click(screen.getByRole('button', { name: 'Create withdrawal' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))
    expect(await screen.findByText('Unable to create partner withdrawal.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Load partner state' }))
    await waitFor(() => expect(summarySpy).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Pending • 300 USDT')).toBeInTheDocument()
    expect(await screen.findByText('Processing • 450 USDT')).toBeInTheDocument()

    const pendingRow = screen.getByTestId('withdrawal-row-0')
    const processingRow = screen.getByTestId('withdrawal-row-1')

    fireEvent.click(within(pendingRow).getByRole('button', { name: 'Approve' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))
    expect(await screen.findByText('Unable to approve partner withdrawal.')).toBeInTheDocument()

    fireEvent.click(within(pendingRow).getByRole('button', { name: 'Reject' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))
    expect(await screen.findByText('Unable to reject partner withdrawal.')).toBeInTheDocument()

    fireEvent.click(within(processingRow).getByRole('button', { name: 'Complete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))
    expect(await screen.findByText('Unable to complete partner withdrawal.')).toBeInTheDocument()

    for (const value of [rawCreateError, rawApproveError, rawRejectError, rawCompleteError, 'raw-wallet-create-001', 'raw-partner-secret-create-001', 'raw-admin-secret-approve-001', 'raw-admin-secret-reject-001', 'raw-admin-secret-complete-001', 'raw-wallet-approve-001', 'raw-wallet-complete-001', 'raw-backend-comment-error-001', 'raw-admin-error-001', 'raw-withdrawal-audit-error-001', 'raw-partner-audit-error-001']) {
      expectSensitiveStringAbsent(container, value)
    }
  })
})
