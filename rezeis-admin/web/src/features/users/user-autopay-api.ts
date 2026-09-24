/**
 * What the user card's «Автосписание» reads (`user-autopay-section.tsx`):
 * `GET /admin/payments/autopay/users/:userId`, and the paths its two buttons
 * post to.
 */

/** `OperatorProviderSubscriptionInterface` on the server. */
export interface AutopayProviderSubscription {
  readonly id: string
  readonly gatewayType: string
  readonly status: string
  readonly amount: string
  readonly currency: string
  readonly intervalUnit: string
  readonly intervalCount: number
  readonly planName: string | null
  readonly subscriptionId: string | null
  readonly nextChargeAt: string | null
  /** A cancel asked for and still waiting for the provider. */
  readonly cancelRequestedBy: 'OPERATOR' | 'REFUND' | null
}

/** `AdminYookassaMethodInterface` on the server. */
export interface AutopayYookassaMethod {
  readonly id: string
  readonly title: string
  readonly methodType: string
  readonly cardLast4: string | null
  readonly autopayEnabled: boolean
}

/** `AdminUserAutopayInterface` on the server. */
export interface UserAutopay {
  readonly providerSubscriptions: ReadonlyArray<AutopayProviderSubscription>
  readonly yookassaMethods: ReadonlyArray<AutopayYookassaMethod>
}

/** Under the users key: a user change, and the operator's cancel answered, read it again. */
export const userAutopayQueryKey = (userId: string) => ['admin', 'users', userId, 'autopay'] as const

export const userAutopayPath = (userId: string) => `/admin/payments/autopay/users/${encodeURIComponent(userId)}`

/**
 * The server's answer, or a failed read: a body of any other shape shows
 * «Не удалось загрузить…» in the card instead of taking the whole user card
 * down with it.
 */
export function readUserAutopay(data: unknown): UserAutopay {
  const body = data as Partial<Record<keyof UserAutopay, unknown>> | null
  if (
    body === null ||
    typeof body !== 'object' ||
    !Array.isArray(body.providerSubscriptions) ||
    !Array.isArray(body.yookassaMethods)
  ) {
    throw new Error('The autopay answer has another shape')
  }
  return body as UserAutopay
}
