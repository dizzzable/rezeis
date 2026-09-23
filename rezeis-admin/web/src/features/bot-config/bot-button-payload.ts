import type { BotButtonAction } from './bot-config-api'

/**
 * A button ID the bot can send as callback data — what the create form takes,
 * and what the server does (`BUTTON_ID_REGEX`, `bot-buttons.service.ts`;
 * `test/mini-app-page-picker-saves.spec.ts` holds the two equal). This file
 * imports nothing at run time: that spec loads it as it is.
 */
export const BUTTON_ID_PATTERN = /^[a-z0-9._-]+$/i

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
