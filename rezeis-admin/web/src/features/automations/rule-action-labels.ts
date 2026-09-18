import type { TFunction } from 'i18next'

/**
 * The operator's name for each action type, shared by the editor, the run
 * dialog and the run results — one table, so an action reads the same wherever
 * it is named.
 */
export const ACTION_LABEL_KEYS: Readonly<Record<string, string>> = {
  notify_telegram: 'automationsPage.actionTypes.notify_telegram',
  webhook_post: 'automationsPage.actionTypes.webhook_post',
  block_ip: 'automationsPage.actionTypes.block_ip',
  block_user: 'automationsPage.actionTypes.block_user',
  show_hint: 'automationsPage.actionTypes.show_hint',
  show_hint_to_audience: 'automationsPage.actionTypes.show_hint_to_audience',
  system_event: 'automationsPage.actionTypes.system_event',
}

/** The label of an action type, or the type itself for one the panel has no name for. */
export function actionLabel(t: TFunction, type: string): string {
  const key = ACTION_LABEL_KEYS[type]
  return key === undefined ? type : String(t(key))
}
