import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithProviders } from '@/test/test-utils'
import { FraudSuppressionPanel } from './fraud-suppression'
import {
  createFraudExemption,
  getPendingFraudCandidates,
  listFraudExemptions,
  revokeFraudExemption,
  type FraudExemption,
  type PendingFraudCandidate,
} from './fraud-api'

/**
 * The operator-facing half of the two gates.
 *
 * The requirement these cover is not "the panel renders" — it is that a
 * suppression cannot be invisible. A detector held back for evidence and a
 * detector silenced by an exemption both look, from the signal queue alone,
 * exactly like a detector with nothing to report; these assertions are what say
 * the difference reaches a human.
 */

vi.mock('./fraud-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fraud-api')>()
  return {
    ...actual,
    getPendingFraudCandidates: vi.fn(),
    listFraudExemptions: vi.fn(),
    createFraudExemption: vi.fn(),
    revokeFraudExemption: vi.fn(),
  }
})

const gathering: PendingFraudCandidate = {
  id: 'pend-1',
  code: 'SUBSCRIPTION_SHARING_HWID',
  conditionKey: 'uuid-1',
  observations: 2,
  requiredObservations: 3,
  severity: 'MEDIUM',
  lastSeverity: 'MEDIUM',
  score: 60,
  title: 'Subscription sharing — device limit exceeded',
  affectedUserIds: ['user-1'],
  heldBy: 'streak',
  exemptionId: null,
  firstSeenAt: '2026-08-06T11:50:00.000Z',
  lastSeenAt: '2026-08-06T12:00:00.000Z',
}

const exempted: PendingFraudCandidate = {
  ...gathering,
  id: 'pend-2',
  conditionKey: 'uuid-2',
  title: 'Subscription sharing — concurrent networks',
  heldBy: 'exemption',
  exemptionId: 'ex-1',
}

const liveExemption: FraudExemption = {
  id: 'ex-1',
  userId: 'user-1',
  codes: ['SUBSCRIPTION_SHARING_HWID'],
  reason: 'verified reseller, ticket 4412',
  expiresAt: '2026-09-01T23:59:59.999Z',
  createdBy: 'admin-1',
  createdByLogin: 'anna',
  revokedAt: null,
  revokedBy: null,
  createdAt: '2026-08-01T10:00:00.000Z',
  active: true,
}

const lapsedExemption: FraudExemption = {
  ...liveExemption,
  id: 'ex-2',
  userId: 'user-2',
  reason: 'temporary allowance for the migration window',
  createdByLogin: 'boris',
  expiresAt: '2026-07-01T23:59:59.999Z',
  active: false,
}

describe('FraudSuppressionPanel', () => {
  beforeEach(() => {
    vi.mocked(getPendingFraudCandidates).mockResolvedValue([gathering, exempted])
    vi.mocked(listFraudExemptions).mockResolvedValue([liveExemption, lapsedExemption])
    vi.mocked(createFraudExemption).mockResolvedValue(liveExemption)
    vi.mocked(revokeFraudExemption).mockResolvedValue({ ...liveExemption, active: false })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows a held candidate with how much evidence it still needs', async () => {
    renderWithProviders(<FraudSuppressionPanel />)

    expect(await screen.findByText('Seen 2/3 runs')).toBeInTheDocument()
    expect(
      screen.getByText('Subscription sharing — device limit exceeded'),
    ).toBeInTheDocument()
  })

  it('shows an exempted candidate as exempt rather than hiding it', async () => {
    // The whole point. A suppression that leaves no trace is how a detector
    // stops detecting without anybody noticing.
    renderWithProviders(<FraudSuppressionPanel />)

    expect(await screen.findByText('Exempt')).toBeInTheDocument()
    expect(
      screen.getByText('Subscription sharing — concurrent networks'),
    ).toBeInTheDocument()
  })

  it('lists exemptions with their codes, expiry, reason and who granted them', async () => {
    renderWithProviders(<FraudSuppressionPanel />)

    expect(await screen.findByText('verified reseller, ticket 4412')).toBeInTheDocument()
    expect(screen.getByText('granted by anna')).toBeInTheDocument()
    expect(screen.getAllByText('SUBSCRIPTION_SHARING_HWID').length).toBeGreaterThan(0)
    // A lapsed one stays readable — it answers "why did we stop seeing signals".
    expect(screen.getByText('expired')).toBeInTheDocument()
  })

  it('will not submit an exemption without an expiry', async () => {
    // Expiry is mandatory on the column, in the DTO and here. This asserts the
    // operator cannot even ask for a permanent blind spot.
    const user = userEvent.setup()
    renderWithProviders(<FraudSuppressionPanel />)

    await user.click(await screen.findByRole('button', { name: 'New exemption' }))
    const dialog = await screen.findByRole('dialog')

    await user.type(within(dialog).getByLabelText('User ID'), 'user-9')
    await user.click(within(dialog).getByLabelText('PROMO_ABUSE'))
    await user.type(within(dialog).getByLabelText('Reason'), 'confirmed by support')

    expect(within(dialog).getByRole('button', { name: 'Grant exemption' })).toBeDisabled()
    expect(createFraudExemption).not.toHaveBeenCalled()
  })

  it('will not submit a blanket exemption with no codes', async () => {
    const user = userEvent.setup()
    renderWithProviders(<FraudSuppressionPanel />)

    await user.click(await screen.findByRole('button', { name: 'New exemption' }))
    const dialog = await screen.findByRole('dialog')

    await user.type(within(dialog).getByLabelText('User ID'), 'user-9')
    await user.type(within(dialog).getByLabelText('Reason'), 'confirmed by support')
    await user.type(within(dialog).getByLabelText('Expires on'), '2026-12-31')

    expect(within(dialog).getByRole('button', { name: 'Grant exemption' })).toBeDisabled()
    expect(createFraudExemption).not.toHaveBeenCalled()
  })

  it('grants a per-code exemption with an expiry and a reason', async () => {
    const user = userEvent.setup()
    renderWithProviders(<FraudSuppressionPanel />)

    await user.click(await screen.findByRole('button', { name: 'New exemption' }))
    const dialog = await screen.findByRole('dialog')

    await user.type(within(dialog).getByLabelText('User ID'), 'user-9')
    await user.click(within(dialog).getByLabelText('PROMO_ABUSE'))
    await user.type(within(dialog).getByLabelText('Reason'), 'confirmed by support')
    await user.type(within(dialog).getByLabelText('Expires on'), '2026-12-31')

    await user.click(within(dialog).getByRole('button', { name: 'Grant exemption' }))

    // First argument only — see the note in the revoke test about the second
    // one TanStack Query supplies.
    await waitFor(() => {
      expect(vi.mocked(createFraudExemption).mock.calls[0]?.[0]).toEqual({
        userId: 'user-9',
        codes: ['PROMO_ABUSE'],
        reason: 'confirmed by support',
        expiresAt: '2026-12-31T23:59:59.999Z',
      })
    })
  })

  it('revokes a live exemption and leaves the lapsed one alone', async () => {
    const user = userEvent.setup()
    renderWithProviders(<FraudSuppressionPanel />)

    const revokeButtons = await screen.findAllByRole('button', { name: 'Revoke' })
    expect(revokeButtons).toHaveLength(1)

    await user.click(revokeButtons[0])
    // The FIRST argument only: TanStack Query v5 invokes `mutationFn(variables,
    // context)`, so a `toHaveBeenCalledWith('ex-1')` here fails on the context
    // it also passes — and would read as "the click did nothing".
    await waitFor(() => {
      expect(vi.mocked(revokeFraudExemption).mock.calls[0]?.[0]).toBe('ex-1')
    })
  })

  it('says so plainly when nothing is being suppressed', async () => {
    vi.mocked(getPendingFraudCandidates).mockResolvedValue([])
    vi.mocked(listFraudExemptions).mockResolvedValue([])

    renderWithProviders(<FraudSuppressionPanel />)

    expect(await screen.findByText('Nothing is being held back right now.')).toBeInTheDocument()
    expect(screen.getByText('No exemptions have been granted.')).toBeInTheDocument()
  })
})
