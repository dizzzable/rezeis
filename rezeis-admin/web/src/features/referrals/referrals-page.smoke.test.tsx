// TODO(rezeis-rebuild): Re-enable once the matching backend contract is rebuilt under the new schema.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ReferralsPage from '@/features/referrals/referrals-page'
import { referralsAdminApi } from '@/features/referrals/referrals-api'
import { renderWithProviders } from '@/test/test-utils'

const expectFormValuesNotToContain = (container: HTMLElement, rawValue: string) => {
  const formControls = Array.from(container.querySelectorAll('input, textarea, select'))
  for (const control of formControls) {
    expect((control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value).not.toContain(rawValue)
  }
}

const expectSensitiveStringAbsent = (container: HTMLElement, rawValue: string) => {
  expect(container).not.toHaveTextContent(rawValue)
  expect(container.querySelector(`a[href*="${rawValue}"]`)).not.toBeInTheDocument()
  expectFormValuesNotToContain(container, rawValue)
}

function mockLoadedReferralSnapshot(userId: string): void {
  vi.spyOn(referralsAdminApi, 'getSummary').mockResolvedValue({
    userId,
    referralCode: 'REF-CODE',
    referralPointsBalance: 42,
    activeInvitesCount: 1,
    totalReferrals: 3,
    qualifiedReferrals: 1,
    issuedRewardsCount: 1,
    pendingRewardsCount: 1,
    totalRewardAmount: 100,
  })
  vi.spyOn(referralsAdminApi, 'listInvites').mockResolvedValue([
    { id: 'invite-error-1', inviterId: userId, token: 'TOKEN-ERROR-1', expiresAt: '2026-04-30T00:00:00Z', revokedAt: null, createdAt: '2026-04-20T00:00:00Z' },
  ])
  vi.spyOn(referralsAdminApi, 'listRewards').mockResolvedValue([
    { id: 'reward-error-1', referralId: 'referral-error-1', userId, type: 'GIFT', amount: 1, isIssued: false, createdAt: '2026-04-20T00:00:00Z' },
  ])
  vi.spyOn(referralsAdminApi, 'listQualificationAudit').mockResolvedValue([])
  vi.spyOn(referralsAdminApi, 'getExchangePolicy').mockResolvedValue({ exchangeEnabled: true, giftPromocodeEnabled: true, allowedPlanIds: ['raw-plan-error-id-001'], allowedDurationDays: [7, 30], codePrefix: 'REF', costPerDay: 10 })
}
describe.skip('referrals page smoke', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('hydrates from the route userId and completes create/revoke invite workflow', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    const summarySpy = vi
      .spyOn(referralsAdminApi, 'getSummary')
      .mockResolvedValueOnce({
        userId,
        referralCode: 'REF-CODE',
        referralPointsBalance: 42,
        activeInvitesCount: 1,
        totalReferrals: 3,
        qualifiedReferrals: 1,
        issuedRewardsCount: 1,
        pendingRewardsCount: 0,
        totalRewardAmount: 100,
      })
      .mockResolvedValue({
        userId,
        referralCode: 'REF-CODE',
        referralPointsBalance: 42,
        activeInvitesCount: 1,
        totalReferrals: 3,
        qualifiedReferrals: 1,
        issuedRewardsCount: 1,
        pendingRewardsCount: 0,
        totalRewardAmount: 100,
      })
      .mockResolvedValueOnce({
        userId,
        referralCode: 'REF-CODE',
        referralPointsBalance: 42,
        activeInvitesCount: 2,
        totalReferrals: 3,
        qualifiedReferrals: 1,
        issuedRewardsCount: 1,
        pendingRewardsCount: 0,
        totalRewardAmount: 100,
      })
      .mockResolvedValueOnce({
        userId,
        referralCode: 'REF-CODE',
        referralPointsBalance: 42,
        activeInvitesCount: 1,
        totalReferrals: 3,
        qualifiedReferrals: 1,
        issuedRewardsCount: 1,
        pendingRewardsCount: 0,
        totalRewardAmount: 100,
      })
    const invitesSpy = vi
      .spyOn(referralsAdminApi, 'listInvites')
      .mockResolvedValueOnce([
        {
          id: 'invite-1',
          inviterId: userId,
          token: 'TOKEN1234',
          expiresAt: '2026-04-30T00:00:00Z',
          revokedAt: null,
          createdAt: '2026-04-20T00:00:00Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'invite-1',
          inviterId: userId,
          token: 'TOKEN1234',
          expiresAt: '2026-04-30T00:00:00Z',
          revokedAt: null,
          createdAt: '2026-04-20T00:00:00Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'invite-1',
          inviterId: userId,
          token: 'TOKEN1234',
          expiresAt: '2026-04-30T00:00:00Z',
          revokedAt: null,
          createdAt: '2026-04-20T00:00:00Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'invite-2',
          inviterId: userId,
          token: 'TOKEN5678',
          expiresAt: '2026-05-01T00:00:00Z',
          revokedAt: null,
          createdAt: '2026-04-21T00:00:00Z',
        },
        {
          id: 'invite-1',
          inviterId: userId,
          token: 'TOKEN1234',
          expiresAt: '2026-04-30T00:00:00Z',
          revokedAt: null,
          createdAt: '2026-04-20T00:00:00Z',
        },
      ])
      .mockResolvedValue([
        {
          id: 'invite-2',
          inviterId: userId,
          token: 'TOKEN5678',
          expiresAt: '2026-05-01T00:00:00Z',
          revokedAt: '2026-04-26T12:00:00Z',
          createdAt: '2026-04-21T00:00:00Z',
        },
        {
          id: 'invite-1',
          inviterId: userId,
          token: 'TOKEN1234',
          expiresAt: '2026-04-30T00:00:00Z',
          revokedAt: null,
          createdAt: '2026-04-20T00:00:00Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'invite-2',
          inviterId: userId,
          token: 'TOKEN5678',
          expiresAt: '2026-05-01T00:00:00Z',
          revokedAt: '2026-04-26T12:00:00Z',
          createdAt: '2026-04-21T00:00:00Z',
        },
        {
          id: 'invite-1',
          inviterId: userId,
          token: 'TOKEN1234',
          expiresAt: '2026-04-30T00:00:00Z',
          revokedAt: null,
          createdAt: '2026-04-20T00:00:00Z',
        },
      ])
    const rewardsSpy = vi.spyOn(referralsAdminApi, 'listRewards').mockResolvedValue([
      {
        id: 'reward-1',
        referralId: 'referral-1',
        userId,
        type: 'POINTS',
        amount: 100,
        isIssued: true,
        createdAt: '2026-04-20T00:00:00Z',
      },
      {
        id: 'reward-2',
        referralId: 'referral-1',
        userId,
        type: 'GIFT',
        amount: 1,
        isIssued: false,
        createdAt: '2026-04-20T00:00:00Z',
      },
    ])
    const issueRewardSpy = vi.spyOn(referralsAdminApi, 'issueReward').mockResolvedValue({
      id: 'reward-2',
      referralId: 'referral-1',
      userId,
      type: 'GIFT',
      amount: 1,
      isIssued: true,
      createdAt: '2026-04-20T00:00:00Z',
      status: 'ISSUED',
      reason: null,
    })
    const qualificationAuditSpy = vi.spyOn(referralsAdminApi, 'listQualificationAudit').mockResolvedValue([
        { action: 'QUALIFY_REFERRALS_FROM_COMPLETED_PURCHASE', referredUserId: userId, transactionId: 'raw-transaction-id-001', purchaseChannel: 'WEB', qualifiedReferralCount: 1, rewardsIssuedCount: 1, totalRewardAmount: 100, createdAt: '2026-04-20T00:00:00Z' },
      ])
    vi.spyOn(referralsAdminApi, 'getExchangePolicy').mockResolvedValue({ exchangeEnabled: true, giftPromocodeEnabled: true, allowedPlanIds: ['raw-plan-id-001'], allowedDurationDays: [7, 30], codePrefix: 'REF', costPerDay: 10 })
    const updateExchangeSpy = vi.spyOn(referralsAdminApi, 'updateExchangePolicy').mockResolvedValue({ exchangeEnabled: true, giftPromocodeEnabled: true, allowedPlanIds: ['raw-plan-id-001', 'raw-plan-id-002'], allowedDurationDays: [14, 30], codePrefix: 'GIFT', costPerDay: 12 })
    const createInviteSpy = vi.spyOn(referralsAdminApi, 'createInvite').mockResolvedValue({
      id: 'invite-2',
      inviterId: userId,
      token: 'TOKEN5678',
      expiresAt: '2026-05-01T00:00:00Z',
      revokedAt: null,
      createdAt: '2026-04-21T00:00:00Z',
    })
    const revokeInviteSpy = vi.spyOn(referralsAdminApi, 'revokeInvite').mockResolvedValue({
      id: 'invite-2',
      inviterId: userId,
      token: 'TOKEN5678',
      expiresAt: '2026-05-01T00:00:00Z',
      revokedAt: '2026-04-26T12:00:00Z',
      createdAt: '2026-04-21T00:00:00Z',
    })

    const { container } = renderWithProviders(<ReferralsPage />, {
      route: `/growth/referrals?userId=${userId}`,
    })

    await waitFor(() => {
      expect(summarySpy).toHaveBeenCalledWith(userId)
      expect(invitesSpy).toHaveBeenCalledWith(userId)
      expect(rewardsSpy).toHaveBeenCalledWith(userId)
      expect(qualificationAuditSpy).toHaveBeenCalledWith(userId)
    })

    expect(await screen.findByRole('heading', { name: 'Referral Program' })).toBeInTheDocument()
    expect(screen.getByDisplayValue(userId)).toBeInTheDocument()
    expect(screen.getByText('REF-CODE')).toBeInTheDocument()
    expect(screen.queryByText('TOKEN1234')).not.toBeInTheDocument()
    expect(screen.getByText('Invite token hidden')).toBeInTheDocument()
    expect(screen.getByText('POINTS • 100')).toBeInTheDocument()
    expect(screen.getByText('GIFT • 1')).toBeInTheDocument()
    expect(screen.getByText('QUALIFY_REFERRALS_FROM_COMPLETED_PURCHASE')).toBeInTheDocument()
    expect(screen.queryByText('raw-transaction-id-001')).not.toBeInTheDocument()
    expect(container).not.toHaveTextContent('raw-plan-id-001')
    expect(screen.queryByDisplayValue('raw-plan-id-001')).not.toBeInTheDocument()
    expectFormValuesNotToContain(container, 'raw-plan-id-001')
    expectFormValuesNotToContain(container, 'raw-plan-id-002')
    expect(container.querySelector(`a[href*="${userId}"]`)).not.toBeInTheDocument()
    expect(container.querySelector('a[href*="raw-plan-id-001"]')).not.toBeInTheDocument()

    expect(screen.getByRole('button', { name: 'Save exchange settings' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Issue reward' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Create invite' })).toBeDisabled()
    fireEvent.click(screen.getByLabelText('Referral actions mode'))

    fireEvent.change(screen.getByPlaceholderText('Cost per day'), { target: { value: '12' } })
    fireEvent.change(screen.getByPlaceholderText('Code prefix'), { target: { value: 'GIFT' } })
    fireEvent.change(screen.getByPlaceholderText('Allowed durations, comma-separated'), { target: { value: '14,30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save exchange settings' }))
    expect(updateExchangeSpy).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Confirm referral action' })).toBeInTheDocument()
    expect(container).not.toHaveTextContent('raw-plan-id-002')
    expect(screen.queryByDisplayValue('raw-plan-id-001,raw-plan-id-002')).not.toBeInTheDocument()
    expectFormValuesNotToContain(container, 'raw-plan-id-001')
    expectFormValuesNotToContain(container, 'raw-plan-id-002')
    expect(container.querySelector('a[href*="raw-plan-id-001"]')).not.toBeInTheDocument()
    expect(container.querySelector('a[href*="raw-plan-id-002"]')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))
    await waitFor(() => {
      expect(updateExchangeSpy.mock.calls[0]?.[0]).toEqual({ costPerDay: 12, codePrefix: 'GIFT', allowedDurationDays: [14, 30] })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Issue reward' }))
    expect(issueRewardSpy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))
    await waitFor(() => {
      expect(issueRewardSpy).toHaveBeenCalledWith('reward-2')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }))
    expect(createInviteSpy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))

    await waitFor(() => {
      expect(createInviteSpy).toHaveBeenCalledWith(userId)
      expect(screen.queryByText('TOKEN5678')).not.toBeInTheDocument()
    })

    const newInviteCard = screen.getAllByText('Invite token hidden')[0]?.closest('div.rounded-2xl')
    expect(newInviteCard).not.toBeNull()
    fireEvent.click(within(newInviteCard as HTMLElement).getByRole('button', { name: 'Revoke invite' }))
    expect(revokeInviteSpy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))

    await waitFor(() => {
      expect(revokeInviteSpy).toHaveBeenCalled()
      expect(screen.getByText('Revoked')).toBeInTheDocument()
    })
  })

  it('keeps requests idle when the route userId is invalid', async () => {
    const summarySpy = vi.spyOn(referralsAdminApi, 'getSummary').mockResolvedValue({
      userId: 'unused',
      referralCode: 'REF-CODE',
      referralPointsBalance: 42,
      activeInvitesCount: 1,
      totalReferrals: 3,
      qualifiedReferrals: 1,
      issuedRewardsCount: 1,
      pendingRewardsCount: 0,
      totalRewardAmount: 100,
    })
    const invitesSpy = vi.spyOn(referralsAdminApi, 'listInvites').mockResolvedValue([])
    const rewardsSpy = vi.spyOn(referralsAdminApi, 'listRewards').mockResolvedValue([
      {
        id: 'reward-1',
        referralId: 'referral-1',
        userId: 'unused',
        type: 'POINTS',
        amount: 100,
        isIssued: true,
        createdAt: '2026-04-20T00:00:00Z',
      },
    ])

    renderWithProviders(<ReferralsPage />, {
      route: '/growth/referrals?userId=not-a-uuid',
    })

    expect(await screen.findByText('Referral workflow could not resolve this user ID')).toBeInTheDocument()
    expect(summarySpy).not.toHaveBeenCalled()
    expect(invitesSpy).not.toHaveBeenCalled()
    expect(rewardsSpy).not.toHaveBeenCalled()
  })

  it('hides raw referral snapshot load errors behind bounded copy', async () => {
    const rawSnapshotError = 'raw-referral-snapshot-error user-secret-snapshot-001 raw-invite-token-snapshot-001'
    const userId = '22222222-2222-4222-8222-222222222222'
    vi.spyOn(referralsAdminApi, 'getSummary').mockRejectedValue(new Error(rawSnapshotError))
    vi.spyOn(referralsAdminApi, 'listInvites').mockResolvedValue([])
    vi.spyOn(referralsAdminApi, 'listRewards').mockResolvedValue([])
    vi.spyOn(referralsAdminApi, 'listQualificationAudit').mockResolvedValue([])
    vi.spyOn(referralsAdminApi, 'getExchangePolicy').mockResolvedValue({ exchangeEnabled: false, giftPromocodeEnabled: false, allowedPlanIds: [], allowedDurationDays: [], codePrefix: 'REF', costPerDay: 0 })

    const { container } = renderWithProviders(<ReferralsPage />, { route: `/growth/referrals?userId=${userId}` })

    expect(await screen.findByText('Unable to load referral snapshot.')).toBeInTheDocument()
    expectSensitiveStringAbsent(container, rawSnapshotError)
    expectSensitiveStringAbsent(container, 'user-secret-snapshot-001')
    expectSensitiveStringAbsent(container, 'raw-invite-token-snapshot-001')
  })

  it('hides raw referral mutation errors behind bounded copy', async () => {
    const userId = '33333333-3333-4333-8333-333333333333'
    const rawCreateError = 'raw-create-invite-error raw-invite-token-create-001 user-secret-create-001'
    const rawRevokeError = 'raw-revoke-invite-error raw-invite-token-revoke-001 user-secret-revoke-001'
    const rawRewardError = 'raw-issue-reward-error raw-reward-id-001 user-secret-reward-001'
    const rawPolicyError = 'raw-update-policy-error raw-plan-error-id-001 user-secret-policy-001'

    mockLoadedReferralSnapshot(userId)
    vi.spyOn(referralsAdminApi, 'createInvite').mockRejectedValue(new Error(rawCreateError))
    vi.spyOn(referralsAdminApi, 'revokeInvite').mockRejectedValue(new Error(rawRevokeError))
    vi.spyOn(referralsAdminApi, 'issueReward').mockRejectedValue(new Error(rawRewardError))
    vi.spyOn(referralsAdminApi, 'updateExchangePolicy').mockRejectedValue(new Error(rawPolicyError))

    const { container } = renderWithProviders(<ReferralsPage />, { route: `/growth/referrals?userId=${userId}` })

    expect(await screen.findByRole('heading', { name: 'Referral Program' })).toBeInTheDocument()
    fireEvent.click(await screen.findByLabelText('Referral actions mode'))

    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))
    expect(await screen.findByText('Unable to create referral invite.')).toBeInTheDocument()

    const inviteCard = screen.getAllByText('Invite token hidden')[0]?.closest('div.rounded-2xl')
    expect(inviteCard).not.toBeNull()
    fireEvent.click(within(inviteCard as HTMLElement).getByRole('button', { name: 'Revoke invite' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))
    await waitFor(() => expect(referralsAdminApi.revokeInvite).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'Issue reward' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))
    await waitFor(() => expect(referralsAdminApi.issueReward).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText('Cost per day'), { target: { value: '12' } })
    fireEvent.change(screen.getByPlaceholderText('Code prefix'), { target: { value: 'GIFT' } })
    fireEvent.change(screen.getByPlaceholderText('Allowed durations, comma-separated'), { target: { value: '14,30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save exchange settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))
    await waitFor(() => expect(referralsAdminApi.updateExchangePolicy).toHaveBeenCalled())

    expect(screen.getByText('Unable to create referral invite.')).toBeInTheDocument()
    expect(await screen.findByText('Unable to revoke referral invite.')).toBeInTheDocument()
    expect(await screen.findByText('Unable to issue referral reward.')).toBeInTheDocument()
    expect(await screen.findByText('Unable to save referral exchange policy.')).toBeInTheDocument()

    for (const value of [rawCreateError, rawRevokeError, rawRewardError, rawPolicyError, 'raw-invite-token-create-001', 'raw-invite-token-revoke-001', 'raw-reward-id-001', 'user-secret-create-001', 'user-secret-revoke-001', 'user-secret-reward-001', 'user-secret-policy-001']) {
      expectSensitiveStringAbsent(container, value)
    }
  })
})
