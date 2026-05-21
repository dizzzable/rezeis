import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usersApi } from '@/features/users/users-api'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    delete: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
  },
}))

const mockedGet = vi.mocked(api.get)
const mockedDelete = vi.mocked(api.delete)
const mockedPost = vi.mocked(api.post)
const mockedPatch = vi.mocked(api.patch)

describe('usersApi linked web-account actions', () => {
  beforeEach(() => {
    mockedGet.mockReset()
    mockedDelete.mockReset()
    mockedPost.mockReset()
    mockedPatch.mockReset()
  })

  it('routes activity transactions through bounded admin users wrapper params', async () => {
    mockedGet.mockResolvedValue({
      data: {
        data: {
          items: [
            {
              id: 'tx-1',
              paymentId: 'pay-1',
              userId: 'user-1',
              subscriptionId: 'sub-1',
              status: 'COMPLETED',
              purchaseType: 'RENEW',
              channel: 'WEB',
              gatewayType: 'YOOKASSA',
              currency: 'USD',
              amount: '19.00',
              createdAt: '2026-04-24T10:45:00.000Z',
              updatedAt: '2026-04-24T10:46:00.000Z',
            },
          ],
          total: 1,
          page: 1,
          limit: 5,
        },
      },
    })

    const result = await usersApi.listUserActivityTransactions({
      values: { userId: '', telegramId: '', email: '', login: 'support-user', referralCode: '' },
      limit: 5,
      page: 2,
    })

    expect(mockedGet).toHaveBeenCalledWith('/admin/users/activity/transactions', {
      params: {
        userId: undefined,
        telegramId: undefined,
        email: undefined,
        login: 'support-user',
        referralCode: undefined,
        limit: 5,
        page: 2,
      },
    })
    expect(result.items).toHaveLength(1)
    expect(result.total).toBe(1)
  })

  it('routes users queue pagination through bounded cursor params', async () => {
    mockedGet.mockResolvedValue({
      data: {
        data: {
          queue: 'invited',
          limit: 50,
          hasMore: true,
          nextCursor: 'next-cursor',
          items: [],
        },
      },
    })

    const result = await usersApi.listUsers({ queue: 'invited', cursor: 'current-cursor' })

    expect(mockedGet).toHaveBeenCalledWith('/admin/users', {
      params: {
        queue: 'invited',
        limit: undefined,
        cursor: 'current-cursor',
      },
    })
    expect(result.nextCursor).toBe('next-cursor')
  })

  it('omits empty users queue cursor params from the request', async () => {
    mockedGet.mockResolvedValue({
      data: {
        queue: 'recentRegistered',
        limit: 50,
        hasMore: false,
        nextCursor: null,
        items: [],
      },
    })

    await usersApi.listUsers({ queue: 'recentRegistered', cursor: null })

    expect(mockedGet).toHaveBeenCalledWith('/admin/users', {
      params: {
        queue: 'recentRegistered',
        limit: undefined,
        cursor: undefined,
      },
    })
  })

  it('routes activity notifications through bounded admin users wrapper params', async () => {
    mockedGet.mockResolvedValue({
      data: {
        data: {
          items: [
            {
              id: 'notification-1',
              userId: 'user-1',
              type: 'EMAIL_VERIFICATION',
              title: 'Verification email sent',
              message: 'The verification email was sent to support@example.com.',
              isRead: false,
              readAt: null,
              readSource: null,
              createdAt: '2026-04-24T10:47:00.000Z',
            },
          ],
          total: 1,
          page: 1,
          limit: 5,
        },
      },
    })

    const result = await usersApi.listUserActivityNotifications({
      values: { userId: 'user-1', telegramId: '', email: '', login: '', referralCode: '' },
      limit: 5,
      page: 3,
    })

    expect(mockedGet).toHaveBeenCalledWith('/admin/users/activity/notifications', {
      params: {
        userId: 'user-1',
        telegramId: undefined,
        email: undefined,
        login: undefined,
        referralCode: undefined,
        limit: 5,
        page: 3,
      },
    })
    expect(result.items).toHaveLength(1)
    expect(result.total).toBe(1)
  })

  it('routes accept-rules through admin users wrapper params', async () => {
    mockedPatch.mockResolvedValue({
      data: {
        data: {
          id: 'user-1',
          telegramId: null,
          username: 'support-user',
          name: 'Support User',
          email: 'support@example.com',
          role: 'USER',
          language: 'ru',
          personalDiscount: 0,
          purchaseDiscount: 0,
          points: 0,
          maxSubscriptions: 1,
          isBlocked: false,
          isBotBlocked: false,
          isRulesAccepted: true,
          createdAt: '2026-04-24T10:00:00.000Z',
          updatedAt: '2026-04-24T10:05:00.000Z',
          webAccount: null,
        },
      },
    })

    await usersApi.acceptRules({ userId: 'user-1' })

    expect(mockedPatch).toHaveBeenCalledWith('/admin/users/session/rules-acceptance', undefined, {
      params: { userId: 'user-1' },
    })
  })

  it('routes snooze-link-prompt through admin users wrapper params', async () => {
    mockedPatch.mockResolvedValue({
      data: {
        data: {
          id: 'user-1',
          telegramId: null,
          username: 'support-user',
          name: 'Support User',
          email: 'support@example.com',
          role: 'USER',
          language: 'ru',
          personalDiscount: 0,
          purchaseDiscount: 0,
          points: 0,
          maxSubscriptions: 1,
          isBlocked: false,
          isBotBlocked: false,
          isRulesAccepted: false,
          createdAt: '2026-04-24T10:00:00.000Z',
          updatedAt: '2026-04-24T10:05:00.000Z',
          webAccount: null,
        },
      },
    })

    await usersApi.snoozeWebAccountLinkPrompt({ userId: 'user-1' })

    expect(mockedPatch).toHaveBeenCalledWith('/admin/users/session/web-account-link-prompt-snooze', undefined, {
      params: { userId: 'user-1' },
    })
  })

  it('routes email-verification challenge through admin users wrapper query params', async () => {
    mockedPatch.mockResolvedValue({
      data: {
        data: {
          webAccountId: 'web-1',
          email: 'support@example.com',
          challengeExpiresAt: '2026-04-24T10:15:00.000Z',
        },
      },
    })

    await usersApi.issueWebAccountEmailVerificationChallenge({ userId: 'user-1' })

    expect(mockedPatch).toHaveBeenCalledWith('/admin/users/session/web-account-email-verification-challenge', undefined, {
      params: { userId: 'user-1' },
    })
  })

  it('routes search through admin users wrapper with referralCode query params', async () => {
    mockedGet.mockResolvedValue({
      data: {
        data: {
          session: {
            id: 'user-1',
            telegramId: null,
            username: null,
            name: null,
            email: null,
            role: 'USER',
            language: 'en',
            personalDiscount: 0,
            purchaseDiscount: 0,
            points: 0,
            maxSubscriptions: 1,
            isBlocked: false,
            isBotBlocked: false,
            isRulesAccepted: true,
            createdAt: '2026-04-24T10:00:00.000Z',
            updatedAt: '2026-04-24T10:05:00.000Z',
            webAccount: null,
          },
          subscription: null,
          identityDiagnostics: {
            lookup: {
              requestedIdentifier: {
                type: 'referralCode',
                value: 'REF-42',
              },
              resolvedBy: 'referralCode',
              resolvedViaLinkedWebAccount: false,
            },
            linkedWebAccount: {
              status: 'absent',
              hasLinkedWebAccount: false,
              emailVerified: null,
              credentialsBootstrapped: null,
              requiresPasswordChange: null,
              mismatchFlags: {
                sessionEmailVsWebAccountEmail: false,
                requestedEmailVsSessionEmail: false,
                requestedEmailVsWebAccountEmail: false,
                requestedLoginVsWebAccountLogin: false,
              },
              guidance: ['no_linked_web_account'],
            },
          },
        },
      },
    })

    const result = await usersApi.searchUser({ userId: '', telegramId: '', email: '', login: '', referralCode: 'REF-42' })

    expect(mockedGet).toHaveBeenCalledWith('/admin/users/search', {
      params: {
        userId: undefined,
        telegramId: undefined,
        email: undefined,
        login: undefined,
        referralCode: 'REF-42',
      },
    })
    expect(result.identityDiagnostics).toEqual({
      lookup: {
        requestedIdentifier: {
          type: 'referralCode',
          value: 'REF-42',
        },
        resolvedBy: 'referralCode',
        resolvedViaLinkedWebAccount: false,
      },
      linkedWebAccount: {
        status: 'absent',
        hasLinkedWebAccount: false,
        emailVerified: null,
        credentialsBootstrapped: null,
        requiresPasswordChange: null,
        mismatchFlags: {
          sessionEmailVsWebAccountEmail: false,
          requestedEmailVsSessionEmail: false,
          requestedEmailVsWebAccountEmail: false,
          requestedLoginVsWebAccountLogin: false,
        },
        guidance: ['no_linked_web_account'],
      },
    })
  })

  it('routes selected subscription workbench through bounded admin users params', async () => {
    mockedGet.mockResolvedValue({
      data: {
        data: {
          checkedAt: '2026-04-24T12:00:00.000Z',
          subscription: {
            id: 'subscription-1',
            status: 'ACTIVE',
            isTrial: false,
            plan: {
              name: 'Premium',
              type: 'TRAFFIC',
            },
            trafficLimit: 2048,
            deviceLimit: 3,
            startedAt: '2026-04-01T00:00:00.000Z',
            expiresAt: '2026-05-01T00:00:00.000Z',
            createdAt: '2026-04-01T00:00:00.000Z',
            updatedAt: '2026-04-16T00:00:00.000Z',
            isCurrentCandidate: true,
            riskLevel: 'OK',
            markers: [
              {
                code: 'SUBSCRIPTION_STABLE',
                severity: 'INFO',
                message: 'No immediate subscription risk marker is raised.',
              },
            ],
          },
          ownership: {
            belongsToUser: true,
            status: 'ACTIVE',
          },
          entitlement: {
            isActiveCandidate: true,
            isExpired: false,
            isUpcoming: false,
            riskLevel: 'OK',
            markers: [
              {
                code: 'SELECTED_SUBSCRIPTION_READY',
                severity: 'INFO',
                message: 'Selected subscription is ready for support review.',
              },
            ],
          },
          capacity: {
            trafficLimit: 2048,
            deviceLimit: 3,
          },
          nextActions: [
            {
              code: 'OPEN_ACCESS_DIAGNOSTICS',
              label: 'Review backend-owned access diagnostics before taking support action.',
              target: 'ACCESS_DIAGNOSTICS',
            },
          ],
        },
      },
    })

    const result = await usersApi.getSelectedSubscriptionWorkbench({
      userId: 'user-1',
      subscriptionId: 'subscription-1',
    })

    expect(mockedGet).toHaveBeenCalledWith('/admin/users/subscriptions/selected', {
      params: {
        userId: 'user-1',
        subscriptionId: 'subscription-1',
      },
    })
    expect(result.subscription.id).toBe('subscription-1')
    expect(JSON.stringify(result)).not.toContain('configUrl')
    expect(JSON.stringify(result)).not.toContain('remnawaveData')
    expect(JSON.stringify(result)).not.toContain('uuid')
  })

  it('routes device provisioning challenge reads and issues without exposing secrets', async () => {
    mockedGet.mockResolvedValueOnce({
      data: {
        data: {
          userId: 'user-1',
          subscriptionId: 'subscription-1',
          activeChallenge: {
            id: 'challenge-1',
            status: 'PENDING',
            reason: 'support-confirmed-stale-device',
            expiresAt: '2026-04-24T12:15:00.000Z',
            consumedAt: null,
            revokedAt: null,
            attemptsLeft: 5,
            createdAt: '2026-04-24T12:00:00.000Z',
            updatedAt: '2026-04-24T12:00:00.000Z',
          },
          items: [],
        },
      },
    })
    mockedPost.mockResolvedValueOnce({
      data: {
        data: {
          id: 'challenge-1',
          status: 'PENDING',
          reason: 'support-confirmed-stale-device',
          expiresAt: '2026-04-24T12:15:00.000Z',
          consumedAt: null,
          revokedAt: null,
          attemptsLeft: 5,
          createdAt: '2026-04-24T12:00:00.000Z',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
      },
    })
    mockedPatch.mockResolvedValueOnce({
      data: {
        data: {
          id: 'challenge-1',
          status: 'REVOKED',
          reason: 'support-confirmed-stale-device',
          expiresAt: '2026-04-24T12:15:00.000Z',
          consumedAt: null,
          revokedAt: '2026-04-24T12:05:00.000Z',
          attemptsLeft: 5,
          createdAt: '2026-04-24T12:00:00.000Z',
          updatedAt: '2026-04-24T12:05:00.000Z',
        },
      },
    })

    const listResult = await usersApi.listDeviceProvisioningChallenges({
      userId: 'user-1',
      subscriptionId: 'subscription-1',
    })
    const issueResult = await usersApi.issueDeviceProvisioningChallenge({
      userId: 'user-1',
      subscriptionId: 'subscription-1',
      reason: 'support-confirmed-stale-device',
    })
    const revokeResult = await usersApi.revokeDeviceProvisioningChallenge({
      userId: 'user-1',
      subscriptionId: 'subscription-1',
      challengeId: 'challenge-1',
    })

    expect(mockedGet).toHaveBeenCalledWith('/admin/users/device-provisioning-challenges', {
      params: {
        userId: 'user-1',
        subscriptionId: 'subscription-1',
      },
    })
    expect(mockedPost).toHaveBeenCalledWith(
      '/admin/users/device-provisioning-challenges',
      { reason: 'support-confirmed-stale-device' },
      {
        params: {
          userId: 'user-1',
          subscriptionId: 'subscription-1',
        },
      },
    )
    expect(mockedPatch).toHaveBeenCalledWith(
      '/admin/users/device-provisioning-challenges/challenge-1/revoke',
      undefined,
      {
        params: {
          userId: 'user-1',
          subscriptionId: 'subscription-1',
        },
      },
    )
    expect(listResult.activeChallenge?.id).toBe('challenge-1')
    expect(issueResult.id).toBe('challenge-1')
    expect(revokeResult.status).toBe('REVOKED')
    expect(JSON.stringify(issueResult)).not.toContain('challengeHash')
    expect(JSON.stringify(issueResult)).not.toContain('idempotencyKey')
    expect(JSON.stringify(issueResult)).not.toContain('hwid')
    expect(JSON.stringify(issueResult)).not.toContain('userUuid')
  })

  it('routes selected-subscription mutation drafts without echoing operator notes or keys', async () => {
    mockedPost.mockResolvedValueOnce({
      data: {
        data: {
          requestId: 'audit-1',
          action: 'RENEW',
          status: 'PLANNED',
          executionEnabled: false,
          reasonRequired: true,
          reasonProvided: true,
          idempotencyKeyPresent: true,
          createdAt: '2026-04-24T12:00:00.000Z',
        },
      },
    })

    const result = await usersApi.createSelectedSubscriptionMutationRequest({
      userId: 'user-1',
      subscriptionId: 'subscription-1',
      action: 'RENEW',
      reason: 'support renewal case',
      idempotencyKey: 'renew-1',
    })

    expect(mockedPost).toHaveBeenCalledWith(
      '/admin/users/subscriptions/selected/mutation-requests',
      {
        action: 'RENEW',
        reason: 'support renewal case',
        idempotencyKey: 'renew-1',
      },
      {
        params: {
          userId: 'user-1',
          subscriptionId: 'subscription-1',
        },
      },
    )
    expect(result.reasonRequired).toBe(true)
    expect(result.reasonProvided).toBe(true)
    expect(result.idempotencyKeyPresent).toBe(true)
    expect(JSON.stringify(result)).not.toContain('support renewal case')
    expect(JSON.stringify(result)).not.toContain('renew-1')
  })

  it('routes selected-subscription device reads and revokes with opaque device refs', async () => {
    mockedGet.mockResolvedValueOnce({
      data: {
        data: {
          devices: [
            {
              deviceRef: 'device-ref-1',
              deviceName: 'Support Laptop',
              platform: 'macOS',
              osVersion: '14.4',
              appVersion: '1.2.3',
              userAgent: 'RezeisApp/1.2.3',
              ipAddress: '203.0.113.10',
              lastSeenAt: '2026-04-24T10:00:00.000Z',
              createdAt: '2026-04-22T08:30:00.000Z',
            },
          ],
          deviceCount: 1,
          deviceLimit: 3,
          isLimitReached: false,
          blockedMessage: null,
          maxDevicesMessage: null,
        },
      },
    })
    mockedDelete.mockResolvedValueOnce({
      data: {
        data: {
          devices: [],
          deviceCount: 0,
          deviceLimit: 3,
          isLimitReached: false,
          blockedMessage: null,
          maxDevicesMessage: null,
        },
      },
    })

    const listResult = await usersApi.listSelectedSubscriptionDevices({
      userId: 'user-1',
      subscriptionId: 'subscription-1',
    })
    const revokeResult = await usersApi.revokeSelectedSubscriptionDevice({
      userId: 'user-1',
      subscriptionId: 'subscription-1',
      deviceRef: 'device-ref-1',
    })

    expect(mockedGet).toHaveBeenCalledWith('/admin/users/subscriptions/selected/devices', {
      params: {
        userId: 'user-1',
        subscriptionId: 'subscription-1',
      },
    })
    expect(mockedDelete).toHaveBeenCalledWith('/admin/users/subscriptions/selected/devices/device-ref-1', {
      params: {
        userId: 'user-1',
        subscriptionId: 'subscription-1',
      },
    })
    expect(listResult.devices[0]?.deviceRef).toBe('device-ref-1')
    expect(revokeResult?.deviceCount).toBe(0)
    expect(JSON.stringify(listResult)).not.toContain('hwid')
  })

  it('routes block and unblock moderation through bounded admin users paths', async () => {
    mockedPatch.mockResolvedValueOnce({
      data: {
        userId: 'user-1',
        isBlocked: true,
        changed: true,
        action: 'BLOCK_USER',
        checkedAt: '2026-04-24T12:00:00.000Z',
      },
    })
    mockedPatch.mockResolvedValueOnce({
      data: {
        userId: 'user-1',
        isBlocked: false,
        changed: true,
        action: 'UNBLOCK_USER',
        checkedAt: '2026-04-24T12:01:00.000Z',
      },
    })

    await usersApi.setUserBlockedState({ userId: 'user-1', isBlocked: true, reason: 'support case' })
    await usersApi.setUserBlockedState({ userId: 'user-1', isBlocked: false })

    expect(mockedPatch).toHaveBeenNthCalledWith(1, '/admin/users/user-1/block', { reason: 'support case' })
    expect(mockedPatch).toHaveBeenNthCalledWith(2, '/admin/users/user-1/unblock', {})
  })
})
