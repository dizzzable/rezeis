import { sessionApi, type SessionWebAccountEmailVerificationChallenge } from '@/features/session/session-api'
import { getApiErrorMessage } from '@/lib/api'

interface WebAccountVisibilityState {
  readonly canIssueEmailVerification: boolean
  readonly isReadinessPromptVisible: boolean
  readonly visibleEmailVerificationChallenge: SessionWebAccountEmailVerificationChallenge | null
}

interface EmailVerificationChallengeSupportOptions {
  readonly authStatus: 'loading' | 'authenticated' | 'authentication-required' | 'error'
  readonly webAccount: Awaited<ReturnType<typeof sessionApi.getSession>>['webAccount']
  readonly challenge: SessionWebAccountEmailVerificationChallenge | null
  readonly now: number
}

const NON_ACTIONABLE_CHALLENGE_ERROR_MESSAGES = [
  'active email verification challenge not found',
  'webaccount email is already verified',
] as const

export function getWebAccountEmailAddress(webAccount: Awaited<ReturnType<typeof sessionApi.getSession>>['webAccount']): string | null {
  if (webAccount === null) {
    return null
  }
  return webAccount.email ?? webAccount.emailNormalized
}

export function getWebAccountLogin(webAccount: Awaited<ReturnType<typeof sessionApi.getSession>>['webAccount']): string | null {
  if (webAccount === null) {
    return null
  }
  return webAccount.login ?? webAccount.loginNormalized
}

export function getWebAccountVisibilityState({
  webAccount,
  challenge,
  now,
}: {
  readonly webAccount: Awaited<ReturnType<typeof sessionApi.getSession>>['webAccount']
  readonly challenge: SessionWebAccountEmailVerificationChallenge | null
  readonly now: number
}): WebAccountVisibilityState {
  if (webAccount === null) {
    return {
      canIssueEmailVerification: false,
      isReadinessPromptVisible: false,
      visibleEmailVerificationChallenge: null,
    }
  }
  const canIssueEmailVerification: boolean = webAccount.emailVerifiedAt === null && getWebAccountEmailAddress(webAccount) !== null
  const visibleEmailVerificationChallenge: SessionWebAccountEmailVerificationChallenge | null = getVisibleEmailVerificationChallenge({
    challenge,
    webAccount,
    canIssueEmailVerification,
    now,
  })
  return {
    canIssueEmailVerification,
    isReadinessPromptVisible: getIsReadinessPromptVisible({ webAccount, now }),
    visibleEmailVerificationChallenge,
  }
}

export function getSupportedEmailVerificationChallenge({
  authStatus,
  webAccount,
  challenge,
  now,
}: EmailVerificationChallengeSupportOptions): SessionWebAccountEmailVerificationChallenge | null {
  if (authStatus !== 'authenticated' || challenge === null || webAccount === null) {
    return null
  }
  const canIssueEmailVerification: boolean = webAccount.emailVerifiedAt === null && getWebAccountEmailAddress(webAccount) !== null
  return getVisibleEmailVerificationChallenge({
    challenge,
    webAccount,
    canIssueEmailVerification,
    now,
  })
}

export function reconcileSessionAfterEmailVerificationChallenge({
  session,
  challenge,
}: {
  readonly session: Awaited<ReturnType<typeof sessionApi.getSession>> | undefined
  readonly challenge: SessionWebAccountEmailVerificationChallenge
}): Awaited<ReturnType<typeof sessionApi.getSession>> | undefined {
  if (!session || session.webAccount === null || challenge.challengeExpiresAt !== null) {
    return session
  }
  if (challenge.webAccountId === null) {
    return {
      ...session,
      webAccount: null,
    }
  }
  if (challenge.webAccountId !== session.webAccount.id) {
    return session
  }
  if (challenge.emailVerifiedAt !== null) {
    return {
      ...session,
      webAccount: {
        ...session.webAccount,
        emailVerifiedAt: challenge.emailVerifiedAt,
      },
    }
  }
  if (challenge.email === null) {
    return {
      ...session,
      webAccount: {
        ...session.webAccount,
        email: null,
        emailNormalized: null,
      },
    }
  }
  return session
}

export function shouldClearEmailVerificationChallengeForError(error: unknown): boolean {
  const errorMessage: string = getErrorMessage(error)
  return NON_ACTIONABLE_CHALLENGE_ERROR_MESSAGES.some((message) => message === errorMessage)
}

function getVisibleEmailVerificationChallenge({
  challenge,
  webAccount,
  canIssueEmailVerification,
  now,
}: {
  readonly challenge: SessionWebAccountEmailVerificationChallenge | null
  readonly webAccount: NonNullable<Awaited<ReturnType<typeof sessionApi.getSession>>['webAccount']>
  readonly canIssueEmailVerification: boolean
  readonly now: number
}): SessionWebAccountEmailVerificationChallenge | null {
  if (challenge === null || !canIssueEmailVerification || challenge.webAccountId !== webAccount.id) {
    return null
  }
  if (challenge.email !== getWebAccountEmailAddress(webAccount)) {
    return null
  }
  if (challenge.challengeExpiresAt === null) {
    return null
  }
  const challengeExpiresAtTimestamp: number = Date.parse(challenge.challengeExpiresAt)
  if (Number.isNaN(challengeExpiresAtTimestamp) || challengeExpiresAtTimestamp <= now) {
    return null
  }
  return challenge
}

function getErrorMessage(error: unknown): string {
  return getApiErrorMessage(error).trim().toLowerCase()
}

function getIsReadinessPromptVisible({
  webAccount,
  now,
}: {
  readonly webAccount: NonNullable<Awaited<ReturnType<typeof sessionApi.getSession>>['webAccount']>
  readonly now: number
}): boolean {
  if (getWebAccountLogin(webAccount) !== null && !webAccount.requiresPasswordChange && webAccount.credentialsBootstrappedAt !== null) {
    return false
  }
  if (webAccount.linkPromptSnoozeUntil === null) {
    return true
  }
  const snoozeTimestamp: number = Date.parse(webAccount.linkPromptSnoozeUntil)
  return Number.isNaN(snoozeTimestamp) || snoozeTimestamp <= now
}
