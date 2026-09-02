import { z } from 'zod'

export const PLAN_TYPES = ['TRAFFIC', 'DEVICES', 'BOTH', 'UNLIMITED'] as const
export const PLAN_AVAILABILITIES = ['ALL', 'NEW', 'EXISTING', 'INVITED', 'ALLOWED', 'TRIAL'] as const
export const PLAN_TRAFFIC_STRATEGIES = ['MONTH', 'MONTH_ROLLING', 'NO_RESET', 'DAY', 'WEEK'] as const
/**
 * How a purchase of the plan earns points — `Plan.cashbackMode` on the server.
 * INHERIT follows the global percent from Settings → Points; NONE excludes the
 * plan; PERCENT reads the plan's own `cashbackPercent`; FIXED pays the
 * purchased DURATION's `cashbackPoints` (a year may pay more than a month) and
 * ignores the amount paid.
 */
export const PLAN_CASHBACK_MODES = ['INHERIT', 'NONE', 'PERCENT', 'FIXED'] as const
export type PlanCashbackMode = (typeof PLAN_CASHBACK_MODES)[number]
export const PLAN_CURRENCIES = [
  'USD',
  'RUB',
  'USDT',
  'XTR',
  'TON',
  'BTC',
  'ETH',
  'LTC',
  'BNB',
  'DASH',
  'SOL',
  'XMR',
  'USDC',
  'TRX',
] as const

export const TAG_PATTERN = /^[A-Z0-9_]{0,16}$/
export const TAG_SANITIZE = /[^A-Z0-9_]/g

const PRICE_PATTERN = /^\d+(?:\.\d{1,8})?$/
const INTEGER_PATTERN = /^\d+$/
/** PostgreSQL `integer`, the type of `cashback_points`; the API refuses anything past it. */
const INT4_MAX = 2_147_483_647

export interface PlanFormDraft {
  readonly name: string
  readonly description: string
  readonly tag: string
  readonly icon: string | null
  readonly type: string
  readonly availability: string
  readonly trafficLimitGB: string
  readonly deviceLimit: string
  readonly trafficLimitStrategy: string
  readonly isArchived: boolean
  readonly archivedRenewMode: string
  readonly internalSquads: string[]
  readonly externalSquad: string
  readonly upgradeToPlanIds: string[]
  readonly replacementPlanIds: string[]
  readonly allowedUserIds: string[]
  readonly trialSettings: {
    readonly maxClaims: string
    readonly free: boolean
    readonly availabilityScope: 'ALL' | 'INVITED'
    readonly requireTelegramLink: boolean
  }
  readonly cashbackMode: string
  /** Read under PERCENT only; whatever is left here under another mode is dropped on submit. */
  readonly cashbackPercent: string
  readonly durations: {
    readonly days: string
    /** Read under FIXED only, where empty means 0; dropped on submit under any other mode. */
    readonly cashbackPoints: string
    readonly prices: {
      readonly currency: string
      readonly price: string
    }[]
  }[]
}

export interface PlanFormData {
  readonly name: string
  readonly description?: string
  readonly tag?: string
  readonly icon?: string | null
  readonly type: string
  readonly availability: string
  readonly trafficLimit: number | null
  readonly deviceLimit: number
  readonly trafficLimitStrategy: string
  readonly isArchived?: boolean
  readonly archivedRenewMode?: string
  readonly internalSquads?: string[]
  readonly externalSquad?: string
  readonly upgradeToPlanIds?: string[]
  readonly replacementPlanIds?: string[]
  readonly allowedUserIds?: string[]
  readonly trialSettings?: { maxClaims: number; free: boolean; availabilityScope: 'ALL' | 'INVITED'; requireTelegramLink: boolean }
  readonly cashbackMode: PlanCashbackMode
  /** Set under PERCENT only — `null` otherwise, so a stale percent is never written back. */
  readonly cashbackPercent: number | null
  readonly durations: {
    days: number
    /** Set under FIXED only — `null` otherwise. */
    cashbackPoints: number | null
    prices: { currency: string; price: string }[]
  }[]
}

export interface PlanFormValidationMessages {
  readonly nameRequired: string
  readonly nameTooLong: string
  readonly descriptionTooLong: string
  readonly tagInvalid: string
  readonly iconTooLong: string
  readonly planTypeInvalid: string
  readonly availabilityInvalid: string
  readonly trafficLimitInvalid: string
  readonly deviceLimitInvalid: string
  readonly resetStrategyInvalid: string
  readonly trialMaxClaimsInvalid: string
  readonly durationRequired: string
  readonly durationDaysInvalid: string
  readonly durationDuplicate: string
  readonly trialDurationCount: string
  readonly priceRequired: string
  readonly priceInvalid: string
  readonly currencyInvalid: string
  readonly currencyDuplicate: string
  readonly paidTrialPriceRequired: string
  readonly replacementRequired: string
  readonly allowedUsersRequired: string
  readonly cashbackPercentRange: string
  readonly cashbackPointsRange: string
}

export function createPlanFormSchema(messages: PlanFormValidationMessages) {
  const priceSchema = z.object({
    currency: z.enum(PLAN_CURRENCIES, { error: messages.currencyInvalid }),
    price: z
      .string()
      .trim()
      .min(1, messages.priceInvalid)
      .max(32, messages.priceInvalid)
      .refine((value) => PRICE_PATTERN.test(value), { message: messages.priceInvalid }),
  })

  const durationSchema = z.object({
    days: integerString({ min: 1, message: messages.durationDaysInvalid }),
    cashbackPoints: z.string().trim(),
    prices: z.array(priceSchema).min(1, messages.priceRequired),
  })

  // Both cashback numbers are read only under one mode, so they are checked
  // in `superRefine` rather than on the field: a percent typed under PERCENT
  // and then abandoned for INHERIT must not block a save it no longer takes
  // part in.
  const cashbackRules = {
    percent: integerString({ min: 0, max: 100, message: messages.cashbackPercentRange }),
    points: integerString({ min: 0, max: INT4_MAX, message: messages.cashbackPointsRange }),
  }

  return z
    .object({
      name: z.string().trim().min(1, messages.nameRequired).max(128, messages.nameTooLong),
      description: z.string().trim().max(4096, messages.descriptionTooLong),
      tag: z.string().trim().max(16, messages.tagInvalid).regex(TAG_PATTERN, messages.tagInvalid),
      icon: z.string().trim().max(64, messages.iconTooLong).nullable(),
      type: z.enum(PLAN_TYPES, { error: messages.planTypeInvalid }),
      availability: z.enum(PLAN_AVAILABILITIES, { error: messages.availabilityInvalid }),
      trafficLimitGB: integerString({ min: 0, message: messages.trafficLimitInvalid }),
      deviceLimit: integerString({ min: 0, message: messages.deviceLimitInvalid }),
      trafficLimitStrategy: z.enum(PLAN_TRAFFIC_STRATEGIES, { error: messages.resetStrategyInvalid }),
      isArchived: z.boolean(),
      archivedRenewMode: z.enum(['SELF_RENEW', 'REPLACE_ON_RENEW']),
      internalSquads: z.array(z.string()),
      externalSquad: z.string().trim().max(128, messages.iconTooLong),
      upgradeToPlanIds: z.array(z.string()),
      replacementPlanIds: z.array(z.string()),
      allowedUserIds: z.array(z.string()),
      trialSettings: z.object({
        maxClaims: integerString({ min: 1, max: 100, message: messages.trialMaxClaimsInvalid }),
        free: z.boolean(),
        availabilityScope: z.enum(['ALL', 'INVITED']),
        requireTelegramLink: z.boolean(),
      }),
      cashbackMode: z.enum(PLAN_CASHBACK_MODES),
      cashbackPercent: z.string().trim(),
      durations: z.array(durationSchema).min(1, messages.durationRequired),
    })
    .superRefine((values, ctx) => {
      addDuplicateDurationIssues(values.durations, ctx, messages)
      addDuplicateCurrencyIssues(values.durations, ctx, messages)
      addCashbackIssues(values, ctx, cashbackRules, messages)

      if (
        values.isArchived &&
        values.archivedRenewMode === 'REPLACE_ON_RENEW' &&
        normalizeStringArray(values.replacementPlanIds).length === 0
      ) {
        ctx.addIssue({ code: 'custom', path: ['replacementPlanIds'], message: messages.replacementRequired })
      }

      if (values.availability === 'ALLOWED' && normalizeStringArray(values.allowedUserIds).length === 0) {
        ctx.addIssue({ code: 'custom', path: ['allowedUserIds'], message: messages.allowedUsersRequired })
      }

      if (values.availability === 'TRIAL' && values.durations.length !== 1) {
        ctx.addIssue({ code: 'custom', path: ['durations'], message: messages.trialDurationCount })
      }

      if (values.availability === 'TRIAL' && !values.trialSettings.free && !hasPositivePrice(values.durations)) {
        ctx.addIssue({ code: 'custom', path: ['trialSettings', 'free'], message: messages.paidTrialPriceRequired })
      }
    })
    .transform((values): PlanFormData => {
      const trafficLimitGB = parseInteger(values.trafficLimitGB)
      const internalSquads = normalizeStringArray(values.internalSquads)
      const upgradeToPlanIds = normalizeStringArray(values.upgradeToPlanIds)
      const replacementPlanIds = normalizeStringArray(values.replacementPlanIds)
      const allowedUserIds = normalizeStringArray(values.allowedUserIds)

      return {
        name: values.name,
        description: optionalString(values.description),
        tag: optionalString(values.tag),
        icon: values.icon === null ? null : values.icon || null,
        type: values.type,
        availability: values.availability,
        trafficLimit: trafficLimitGB === 0 ? null : trafficLimitGB,
        deviceLimit: parseInteger(values.deviceLimit),
        trafficLimitStrategy: values.trafficLimitStrategy,
        isArchived: values.isArchived,
        archivedRenewMode: values.isArchived ? values.archivedRenewMode : undefined,
        internalSquads: optionalArray(internalSquads),
        externalSquad: optionalExternalSquad(values.externalSquad),
        upgradeToPlanIds: optionalArray(upgradeToPlanIds),
        replacementPlanIds: values.isArchived ? optionalArray(replacementPlanIds) : undefined,
        allowedUserIds: values.availability === 'ALLOWED' ? optionalArray(allowedUserIds) : undefined,
        trialSettings:
          values.availability === 'TRIAL'
            ? {
                maxClaims: parseInteger(values.trialSettings.maxClaims),
                free: values.trialSettings.free,
                availabilityScope: values.trialSettings.availabilityScope,
                requireTelegramLink: values.trialSettings.requireTelegramLink,
              }
            : undefined,
        // Only the number the mode reads is submitted. The server nulls the
        // other one as well, but a stale value must not even leave the form:
        // an operator reading the request in devtools would see a percent on
        // a FIXED plan and go looking for where it applies.
        cashbackMode: values.cashbackMode,
        cashbackPercent: values.cashbackMode === 'PERCENT' ? parseInteger(values.cashbackPercent) : null,
        durations: values.durations.map((duration) => ({
          days: parseInteger(duration.days),
          cashbackPoints:
            values.cashbackMode === 'FIXED' ? parseCashbackPoints(duration.cashbackPoints) : null,
          prices: duration.prices.map((price) => ({
            currency: price.currency,
            price: price.price,
          })),
        })),
      }
    })
}

export function flattenPlanFormErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const issue of error.issues) {
    const path = issue.path.length === 0 ? 'form' : issue.path.join('.')
    errors[path] ??= issue.message
  }
  return errors
}

function integerString(input: { readonly min: number; readonly max?: number; readonly message: string }) {
  return z
    .string()
    .trim()
    .refine((value) => {
      if (!INTEGER_PATTERN.test(value)) return false
      const numericValue = Number(value)
      return (
        Number.isSafeInteger(numericValue) &&
        numericValue >= input.min &&
        (input.max === undefined || numericValue <= input.max)
      )
    }, { message: input.message })
}

function addDuplicateDurationIssues(
  durations: ReadonlyArray<{ readonly days: string }>,
  ctx: z.RefinementCtx,
  messages: PlanFormValidationMessages,
): void {
  const seen = new Set<number>()
  durations.forEach((duration, index) => {
    if (!INTEGER_PATTERN.test(duration.days)) return
    const days = Number(duration.days)
    if (seen.has(days)) {
      ctx.addIssue({ code: 'custom', path: ['durations', index, 'days'], message: messages.durationDuplicate })
      return
    }
    seen.add(days)
  })
}

function addDuplicateCurrencyIssues(
  durations: ReadonlyArray<{ readonly prices: ReadonlyArray<{ readonly currency: string }> }>,
  ctx: z.RefinementCtx,
  messages: PlanFormValidationMessages,
): void {
  durations.forEach((duration, durationIndex) => {
    const seen = new Set<string>()
    duration.prices.forEach((price, priceIndex) => {
      if (seen.has(price.currency)) {
        ctx.addIssue({
          code: 'custom',
          path: ['durations', durationIndex, 'prices', priceIndex, 'currency'],
          message: messages.currencyDuplicate,
        })
        return
      }
      seen.add(price.currency)
    })
  })
}

/**
 * Validates the cashback number the mode reads, and only that one. INHERIT
 * and NONE read nothing, so under them neither input is checked — and the
 * transform drops whatever they hold.
 */
function addCashbackIssues(
  values: {
    readonly cashbackMode: PlanCashbackMode
    readonly cashbackPercent: string
    readonly durations: ReadonlyArray<{ readonly cashbackPoints: string }>
  },
  ctx: z.RefinementCtx,
  rules: {
    readonly percent: ReturnType<typeof integerString>
    readonly points: ReturnType<typeof integerString>
  },
  messages: PlanFormValidationMessages,
): void {
  if (values.cashbackMode === 'PERCENT' && !rules.percent.safeParse(values.cashbackPercent).success) {
    ctx.addIssue({ code: 'custom', path: ['cashbackPercent'], message: messages.cashbackPercentRange })
  }
  if (values.cashbackMode !== 'FIXED') return
  values.durations.forEach((duration, index) => {
    // Empty is 0 under FIXED: "no points for this duration" is a rule of its
    // own, and the operator must not have to type a zero into every row.
    if (duration.cashbackPoints.length === 0) return
    if (!rules.points.safeParse(duration.cashbackPoints).success) {
      ctx.addIssue({
        code: 'custom',
        path: ['durations', index, 'cashbackPoints'],
        message: messages.cashbackPointsRange,
      })
    }
  })
}

function hasPositivePrice(durations: PlanFormDraft['durations']): boolean {
  return durations.some((duration) =>
    duration.prices.some((price) => PRICE_PATTERN.test(price.price.trim()) && Number(price.price) > 0),
  )
}

function normalizeStringArray(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))]
}

function optionalArray(values: readonly string[]): string[] | undefined {
  return values.length > 0 ? [...values] : undefined
}

function optionalString(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function optionalExternalSquad(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed !== '__none__' ? trimmed : undefined
}

function parseInteger(value: string): number {
  return Number(value.trim())
}

/** Under FIXED an empty box is zero points — see `addCashbackIssues`. */
function parseCashbackPoints(value: string): number {
  const trimmed = value.trim()
  return trimmed.length === 0 ? 0 : parseInteger(trimmed)
}
