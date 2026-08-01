import type { BotButtonAction } from './bot-config-api'

/**
 * Resolve the pair `{ actionType, actionTarget }` to send to the API.
 * Empty / whitespace target is normalised to `null`; CALLBACK and
 * SUPPORT_URL always reset target to `null` regardless of UI state so
 * stale typing doesn't leak through after switching action kinds.
 */
export function buildActionPayload(
  actionType: BotButtonAction,
  actionTarget: string,
): { actionType: BotButtonAction; actionTarget: string | null } {
  if (actionType === 'CALLBACK' || actionType === 'SUPPORT_URL') {
    return { actionType, actionTarget: null }
  }

  const trimmed = actionTarget.trim()
  return { actionType, actionTarget: trimmed.length > 0 ? trimmed : null }
}
