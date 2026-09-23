/**
 * What the bot builds by itself, added to the nodes of «Карта бота» from the
 * ONE catalog «Схема» draws from — not a copy of it:
 *   • the bot's screens with no flow block (`SYSTEM_SCREENS`) as
 *     `system-screen` nodes, under the ids their canvas nodes have;
 *   • the main menu named in the operator's language («Главное меню» /
 *     «Main menu»), whatever title the payload carries;
 *   • the system buttons of any node (`systemButtonsOfNode`) — the list
 *     `computeSystemButtons` gives a screen, the main menu's trial button, a
 *     built-in screen's buttons.
 * The rail, the list, the search and the inspector all read the nodes this
 * returns, so a screen on the canvas is a screen in the list.
 */
import { MAIN_MENU_CHIPS, SYSTEM_SCREENS, systemScreenById, systemScreenNodeId } from '@/features/bot-flow/system-screens'
import type { SystemButtonPreview } from '@/features/bot-flow/types'
import { systemButtonsFor } from '@/features/bot-flow/utils'

import type { BotMapNode, SystemScreenMapNode } from '../types'

/** Rail / list group of the `system-screen` nodes. */
export const SYSTEM_SCREEN_GROUP = 'system'

type Translate = (key: string) => string

/** The bot's screens with no flow block, as map nodes titled in the operator's language. */
export function systemScreenMapNodes(t: Translate): SystemScreenMapNode[] {
  return SYSTEM_SCREENS.map((screen) => ({
    id: systemScreenNodeId(screen.id),
    kind: 'system-screen',
    title: t(screen.titleKey),
    group: SYSTEM_SCREEN_GROUP,
    screenId: screen.id,
  }))
}

/** The payload's nodes, the main menu named as the canvas names it, and the no-block screens. */
export function withBuiltInNodes(nodes: ReadonlyArray<BotMapNode>, t: Translate): ReadonlyArray<BotMapNode> {
  return [
    ...nodes.map((node) =>
      node.kind === 'reply-keyboard' ? { ...node, title: t('botStudio.replyKeyboard.nodeTitle') } : node,
    ),
    ...systemScreenMapNodes(t),
  ]
}

/** The buttons the bot adds to what this node shows — in the order «Схема» draws them. */
export function systemButtonsOfNode(node: BotMapNode): readonly SystemButtonPreview[] {
  switch (node.kind) {
    case 'graph-screen':
      return systemButtonsFor(node.title, node.isRoot, node.buttonCount)
    case 'reply-keyboard':
      return MAIN_MENU_CHIPS
    case 'system-screen':
      return systemScreenById(node.screenId)?.buttons ?? []
    case 'notification':
    case 'mini-app-terminal':
      return []
  }
}
