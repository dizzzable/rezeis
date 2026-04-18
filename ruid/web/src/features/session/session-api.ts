import { z } from 'zod'
import { api } from '@/lib/api'

const EMAIL_VERIFICATION_CODE_PATTERN: RegExp = /^\d{6}$/

const sessionWebAccountSchema = z.object({
  id: z.string(),
  login: z.string().nullable(),
  loginNormalized: z.string().nullable(),
  email: z.string().nullable(),
  emailNormalized: z.string().nullable(),
  emailVerifiedAt: z.string().datetime().nullable(),
  requiresPasswordChange: z.boolean(),
  linkPromptSnoozeUntil: z.string().datetime().nullable(),
  credentialsBootstrappedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

const sessionSchema = z.object({
  id: z.string(),
  telegramId: z.string().nullable(),
  username: z.string().nullable(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  role: z.enum(['DEV', 'ADMIN', 'USER']),
  language: z.enum(['EN', 'RU']),
  personalDiscount: z.number(),
  purchaseDiscount: z.number(),
  points: z.number(),
  maxSubscriptions: z.number(),
  isBlocked: z.boolean(),
  isBotBlocked: z.boolean(),
  isRulesAccepted: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  webAccount: sessionWebAccountSchema.nullable(),
})

const sessionWebAccountPasswordInputSchema = z.object({
  login: z.string().trim().min(1).max(255),
  password: z.string().min(8).max(128),
})

const sessionWebAccountEmailVerificationChallengeSchema = z.object({
  webAccountId: z.string().nullable(),
  email: z.string().nullable(),
  challengeExpiresAt: z.string().datetime().nullable(),
  emailVerifiedAt: z.string().datetime().nullable(),
})

const sessionWebAccountEmailVerificationCompletionInputSchema = z.object({
  code: z.string().regex(EMAIL_VERIFICATION_CODE_PATTERN, 'code must be a 6-digit numeric string'),
})

type SessionData = z.infer<typeof sessionSchema>
export type SessionWebAccountPasswordInput = z.infer<typeof sessionWebAccountPasswordInputSchema>
export type SessionWebAccountEmailVerificationChallenge = z.infer<typeof sessionWebAccountEmailVerificationChallengeSchema>
export type SessionWebAccountEmailVerificationCompletionInput = z.infer<typeof sessionWebAccountEmailVerificationCompletionInputSchema>

export const sessionApi = {
  async getSession(): Promise<SessionData> {
    const response = await api.get('/session')
    return sessionSchema.parse(response.data)
  },
  async acceptRules(): Promise<SessionData> {
    const response = await api.patch('/session/rules-acceptance')
    return sessionSchema.parse(response.data)
  },
  async snoozeWebAccountLinkPrompt(): Promise<SessionData> {
    const response = await api.patch('/session/web-account-link-prompt-snooze')
    return sessionSchema.parse(response.data)
  },
  async handoffWebAccountPassword(input: SessionWebAccountPasswordInput): Promise<SessionData> {
    const payload: SessionWebAccountPasswordInput = sessionWebAccountPasswordInputSchema.parse(input)
    const response = await api.patch('/session/web-account-password', payload)
    return sessionSchema.parse(response.data)
  },
  async issueWebAccountEmailVerificationChallenge(): Promise<SessionWebAccountEmailVerificationChallenge> {
    const response = await api.patch('/session/web-account-email-verification-challenge')
    return sessionWebAccountEmailVerificationChallengeSchema.parse(response.data)
  },
  async completeWebAccountEmailVerification(input: SessionWebAccountEmailVerificationCompletionInput): Promise<SessionData> {
    const payload: SessionWebAccountEmailVerificationCompletionInput = sessionWebAccountEmailVerificationCompletionInputSchema.parse(input)
    const response = await api.patch('/session/web-account-email-verification-completion', payload)
    return sessionSchema.parse(response.data)
  },
}
