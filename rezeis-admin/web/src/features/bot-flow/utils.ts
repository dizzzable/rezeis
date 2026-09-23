import type { Node, Edge } from '@xyflow/react'
import {
  menuButtonRoute,
  replyButtonHandleId,
  resolveReplyButtonColor,
  type MenuButtonRouting,
  type RouteContext,
} from './components/reply-keyboard-utils'
import type { MapInfoNodeData } from './components/MapInfoNode'
import { MAP_INFO_NODE_TYPE } from './components/MapInfoNode'
import type { SystemScreenNodeData } from './components/SystemScreenNode'
import type { BotMapNode, BotMapEdge } from '@/features/bot-map/types'
import { SYSTEM_SCREENS, systemScreenNodeId } from './system-screens'
import type { BotFlow, BotFlowButton, BotScreenNodeData, SystemButtonPreview } from './types'

/** Group buttons by row index. */
export function groupButtonsByRow(buttons: BotFlowButton[]): BotFlowButton[][] {
  const rows: Map<number, BotFlowButton[]> = new Map()
  for (const btn of buttons) {
    const row = rows.get(btn.row) ?? []
    row.push(btn)
    rows.set(btn.row, row)
  }
  // Sort rows by index, sort buttons within row by col
  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, btns]) => btns.sort((a, b) => a.col - b.col))
}

/**
 * «◀️ В меню» as reiwa renders it on every screen that offers a way back:
 * `renderSystemButton(t('back_to_menu'), 'back', …)` → `menu:main`.
 */
function backButton(key: string, conditionKey?: string): SystemButtonPreview {
  return {
    key,
    labelKey: 'botFlow.systemButtons.back',
    isBack: true,
    iconKey: 'back',
    textKey: 'back_to_menu',
    ...(conditionKey !== undefined ? { conditionKey } : {}),
  }
}

/**
 * The buttons reiwa adds to a screen at RUNTIME — they are not stored in
 * `bot_flow_buttons`. THE ONE LIST: the canvas chips (`BotScreenNode`), the
 * inspector's «Системные кнопки» (`ScreenEditorPanel`) and the «Список» tab
 * (through `systemButtonsFor`) all read it. The first two used to keep a copy
 * each, and each copy missed buttons the bot shows.
 *
 * Mirrors reiwa, in the order it builds each keyboard:
 *   • `invite` — `src/bot/pages/invite.ts`. ONE screen, TWO keyboards: the
 *     referral hub (share, copy, website link, «👤 Профиль в кабинете»,
 *     «💱 Обменять баллы», back) and, for an active partner, the partner hub
 *     (share, copy, website link, «🤝 Партнёрский кабинет», the exchange while
 *     points remain, back). Listed as one sequence both keyboards are
 *     subsequences of; the conditions say which buttons are whose. The three
 *     cabinet buttons go through `hubButton` → `renderButtonLabel`, so they
 *     have a text key and no icon slot;
 *   • `rules` — `rules.ts`; `help` — `help-callback.ts` (the `/help` command
 *     builds the same three in `help.ts`);
 *   • any other non-root screen with no buttons of its own gets the
 *     `[◀️ В меню]` row of `dynamic-screen.ts`.
 * The `isBack` entry anchors the dashed edge to the root screen.
 */
export function computeSystemButtons(screen: BotFlow['screens'][number]): SystemButtonPreview[] {
  return systemButtonsFor(screen.name, screen.isRoot, screen.buttons.length)
}

/**
 * The same list from what «Список» has of a screen (`GraphScreenMapNode`: its
 * name, whether it is the start screen, how many buttons of its own) — so the
 * list tab reads this list rather than keeping a third copy of it.
 */
export function systemButtonsFor(
  screenName: string,
  isRoot: boolean,
  ownButtonCount: number,
): SystemButtonPreview[] {
  const lower = screenName.trim().toLowerCase()
  if (lower === 'invite') {
    return [
      {
        key: 'invite-share',
        labelKey: 'botFlow.systemButtons.invite.share',
        isBack: false,
        iconKey: 'invite_share',
        textKey: 'invite.share_button',
      },
      {
        key: 'invite-copy',
        labelKey: 'botFlow.systemButtons.invite.copy',
        isBack: false,
        iconKey: 'invite_copy',
        textKey: 'invite.copy_button',
      },
      {
        key: 'invite-copy-web',
        labelKey: 'botFlow.systemButtons.invite.copyWeb',
        isBack: false,
        iconKey: 'invite_copy_web',
        textKey: 'invite.copy_web_button',
        conditionKey: 'botFlow.systemButtons.conditions.webLink',
      },
      {
        key: 'invite-open-cabinet',
        labelKey: 'botFlow.systemButtons.invite.openCabinet',
        isBack: false,
        textKey: 'referral.hub.open_cabinet',
        conditionKey: 'botFlow.systemButtons.conditions.referralCabinet',
      },
      {
        key: 'invite-partner-cabinet',
        labelKey: 'botFlow.systemButtons.invite.partnerCabinet',
        isBack: false,
        textKey: 'partner.hub.open_cabinet',
        conditionKey: 'botFlow.systemButtons.conditions.partnerCabinet',
      },
      {
        key: 'invite-open-exchange',
        labelKey: 'botFlow.systemButtons.invite.openExchange',
        isBack: false,
        textKey: 'referral.hub.open_exchange',
        conditionKey: 'botFlow.systemButtons.conditions.exchange',
      },
      backButton('invite-back'),
    ]
  }
  if (lower === 'rules') {
    return [
      {
        key: 'rules-open',
        labelKey: 'botFlow.systemButtons.rules.open',
        isBack: false,
        iconKey: 'rules_open',
        textKey: 'rules.open_button',
        conditionKey: 'botFlow.systemButtons.conditions.rulesOpen',
      },
      backButton('rules-back'),
    ]
  }
  if (lower === 'help') {
    return [
      {
        key: 'help-open-app',
        labelKey: 'botFlow.systemButtons.help.openApp',
        isBack: false,
        iconKey: 'help_open_app',
        textKey: 'help.open_app_button',
        conditionKey: 'botFlow.systemButtons.conditions.helpOpenApp',
      },
      {
        key: 'help-contact',
        labelKey: 'botFlow.systemButtons.help.contact',
        isBack: false,
        iconKey: 'help_contact',
        textKey: 'help.contact_button',
        conditionKey: 'botFlow.systemButtons.conditions.helpContact',
      },
      backButton('help-back'),
    ]
  }
  // Any other non-root screen with no configured buttons gets a runtime
  // back-to-menu row (see dynamic-screen.ts) — and loses it with the first
  // button the operator adds.
  if (!isRoot && ownButtonCount === 0) {
    return [backButton('auto-back', 'botFlow.systemButtons.conditions.autoBack')]
  }
  return []
}

const EDGE_COLORS = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
  '#14b8a6', // teal
]

/** Convert a BotFlow (from API) into React Flow nodes and edges. */
export function flowToReactFlow(flow: BotFlow): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = flow.screens.map((screen) => ({
    id: screen.id,
    type: 'botScreen',
    position: { x: screen.positionX, y: screen.positionY },
    data: {
      shortId: screen.shortId,
      name: screen.name,
      textRu: screen.textRu,
      textEn: screen.textEn,
      parseMode: screen.parseMode,
      mediaType: screen.mediaType,
      mediaUrl: screen.mediaUrl,
      isRoot: screen.isRoot,
      buttons: groupButtonsByRow(screen.buttons),
      systemButtons: computeSystemButtons(screen),
    } satisfies BotScreenNodeData,
  }))

  // Build edges from NAVIGATE buttons — each gets a unique color
  let edgeIndex = 0
  const edges: Edge[] = flow.screens.flatMap((screen) =>
    screen.buttons
      .filter((btn) => btn.actionType === 'NAVIGATE' && btn.targetScreenId)
      .map((btn) => {
        const targetScreen = flow.screens.find((s) => s.shortId === btn.targetScreenId)
        if (!targetScreen) return null
        const color = EDGE_COLORS[edgeIndex % EDGE_COLORS.length]
        edgeIndex++
        return {
          id: `edge-${btn.id}`,
          source: screen.id,
          sourceHandle: `btn-${btn.id}`,
          target: targetScreen.id,
          targetHandle: `${targetScreen.id}-target`,
          type: 'smoothstep',
          animated: true,
          style: { stroke: color, strokeWidth: 2 },
          markerEnd: { type: 'arrowclosed' as const, color },
        } as Edge
      })
      .filter((e): e is Edge => e !== null),
  )

  return { nodes, edges }
}

/** Convert React Flow nodes back to position updates for the API. */
export function nodesToPositions(nodes: Node[]): Array<{ id: string; x: number; y: number }> {
  return nodes.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y }))
}

/**
 * Build dotted edges from the pinned reply-keyboard pseudo-node (the bot's
 * main menu) to the screen each of its buttons opens — as reiwa routes the
 * tap (`menuButtonRoute`), not as its ID suggests:
 *   • a callback with a built-in ID (`invite` / `rules` / `help`) → the screen
 *     of that name, which reiwa's handler renders (`findScreenByName`);
 *   • a callback that is exactly a screen's shortId → that screen;
 *   • «Экран бота» → the screen it names by shortId;
 *   • «Чат с поддержкой» → the help screen, which reiwa opens (`help`) when
 *     there is no public support @username — unless `supportChat` says the
 *     panel's «Username поддержки» is one, and the button opens only a chat.
 * A button that opens a page or a link has no screen arrow. It used to be
 * drawn by name match alone, so «Пригласить» re-pointed at another screen
 * still arrowed into the invite screen.
 *
 * Why dashed: a regular animated solid edge implies a NAVIGATE
 * `actionType` button drives the link. Reply-keyboard buttons are
 * not BotFlowButtons — they live in the `bot_buttons` table and are
 * routed by reiwa via name-match instead of an explicit
 * `targetScreenId`. The dashed style telegraphs the difference.
 */
export function buildReplyToScreenEdges(
  flow: BotFlow | undefined,
  replyButtons: readonly BotButtonLite[] | undefined,
  supportChat: boolean | null = null,
): Edge[] {
  if (flow === undefined || replyButtons === undefined) return []
  const replyNodeId = '__reply_keyboard__'
  const screenByShortId = new Map<string, BotFlow['screens'][number]>()
  for (const screen of flow.screens) {
    if (!screenByShortId.has(screen.shortId)) screenByShortId.set(screen.shortId, screen)
  }
  // No Mini App catalog: pages draw no screen arrow either way.
  const context: RouteContext = { screens: flow.screens, miniAppRoutes: null, supportChat }
  const edges: Edge[] = []
  for (const button of replyButtons) {
    if (!button.visible) continue
    const route = menuButtonRoute(button, context)
    // A support button's arrow is to where it goes without a chat to open —
    // none when the panel knows it has one.
    const opened = route.kind === 'support' ? route.fallback : route
    const target =
      opened !== null && opened.kind === 'screen' && opened.shortId !== null
        ? screenByShortId.get(opened.shortId)
        : undefined
    if (target === undefined) continue
    const color = resolveReplyButtonColor(button.buttonId)
    edges.push({
      id: `reply-edge-${button.id}`,
      source: replyNodeId,
      sourceHandle: replyButtonHandleId(button.buttonId),
      target: target.id,
      targetHandle: `${target.id}-target`,
      type: 'smoothstep',
      animated: true,
      style: {
        stroke: color,
        strokeWidth: 2,
        strokeDasharray: '6 4',
      },
      markerEnd: { type: 'arrowclosed' as const, color },
      // Reply-keyboard edges are virtual — the user can't delete or
      // re-target them via drag. Mark them undeletable so React Flow
      // doesn't offer a context menu.
      deletable: false,
      // Show button label as edge label so the operator can tell at a
      // glance which reply-button drives which screen.
      label: button.label,
      labelStyle: {
        fill: '#ffffff',
        fontSize: 10,
        fontWeight: 600,
      },
      labelBgStyle: {
        fill: color,
        fillOpacity: 0.95,
      },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
    })
  }
  return edges
}

/**
 * Minimal contract reply edges need from a `BotButton`. Kept narrow
 * so the helper doesn't pull the full `bot-config-api` schema into
 * `utils.ts` (which would create a cycle if utils imported from
 * features/bot-config). The action and its target are part of it: they,
 * not the ID, decide where the bot sends a tap.
 */
export interface BotButtonLite extends MenuButtonRouting {
  readonly id: string
  readonly label: string
  readonly visible: boolean
}

/**
 * Build dashed edges to the root (welcome) screen for every "back to menu"
 * path, so the canvas shows where these return:
 *   1. Explicit stored `BACK` / `START_OVER` buttons — anchored to their own
 *      button chip handle (`btn-<id>`).
 *   2. The runtime-injected back button on built-in screens (help/invite/rules)
 *      and on any non-root screen with no configured buttons — anchored to the
 *      synthetic system-back chip handle (`<screenId>-sysback`).
 * Skipped when no root screen exists (reiwa then falls back to the built-in
 * welcome, which has no canvas node).
 */
export function buildBackToMenuEdges(
  flow: BotFlow | undefined,
  backLabel: string,
): Edge[] {
  if (flow === undefined) return []
  const root = flow.screens.find((s) => s.isRoot)
  if (root === undefined) return []
  const color = '#94a3b8'
  const edges: Edge[] = []
  const makeBackEdge = (
    id: string,
    source: string,
    sourceHandle: string,
    label: string,
  ): Edge =>
    ({
      id,
      source,
      sourceHandle,
      target: root.id,
      targetHandle: `${root.id}-target`,
      type: 'smoothstep',
      animated: false,
      deletable: false,
      style: { stroke: color, strokeWidth: 1.5, strokeDasharray: '2 4' },
      markerEnd: { type: 'arrowclosed' as const, color },
      label,
      labelStyle: { fill: '#ffffff', fontSize: 9, fontWeight: 600 },
      labelBgStyle: { fill: color, fillOpacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
    }) as Edge
  for (const screen of flow.screens) {
    if (screen.id === root.id) continue
    for (const btn of screen.buttons) {
      if (btn.actionType !== 'BACK' && btn.actionType !== 'START_OVER') continue
      edges.push(
        makeBackEdge(
          `backbtn-${btn.id}`,
          screen.id,
          `btn-${btn.id}`,
          btn.labelRu || btn.labelEn || backLabel,
        ),
      )
    }
    if (computeSystemButtons(screen).some((b) => b.isBack)) {
      edges.push(makeBackEdge(`sysback-${screen.id}`, screen.id, `${screen.id}-sysback`, backLabel))
    }
  }
  return edges
}

/**
 * Project the non-graph bot-map nodes (notifications + Mini App terminals)
 * onto the canvas. They carry no DB position, so we lay them out in two
 * fixed columns to the right of the graph: notifications, then Mini App
 * terminals. Read-only `mapInfo` nodes — draggable for viewing convenience
 * but excluded from the position-save (only `botScreen` nodes persist).
 */
const MAP_NODE_X_NOTIFICATION = 1040
const MAP_NODE_X_MINIAPP = 1480
const MAP_NODE_Y_STEP = 150

/** Saved canvas positions for read-only map nodes, keyed by node id. */
export type MapNodePositions = Record<string, { x: number; y: number }>

export function botMapNodesToReactFlow(
  nodes: ReadonlyArray<BotMapNode>,
  savedPositions?: MapNodePositions,
): Node[] {
  const out: Node[] = []
  let notifIndex = 0
  let miniIndex = 0
  for (const node of nodes) {
    if (node.kind === 'notification') {
      const saved = savedPositions?.[node.id]
      out.push({
        id: node.id,
        type: MAP_INFO_NODE_TYPE,
        position: saved ?? { x: MAP_NODE_X_NOTIFICATION, y: notifIndex * MAP_NODE_Y_STEP },
        data: {
          kind: 'notification',
          title: node.title,
          group: node.group,
          status: node.status ?? null,
          subtitle: node.type,
          buttons: node.buttons.map((b) => ({
            labelRu: b.labelRu,
            kind: b.kind,
            target: b.target,
          })),
        } satisfies MapInfoNodeData,
      })
      notifIndex += 1
    } else if (node.kind === 'mini-app-terminal') {
      const saved = savedPositions?.[node.id]
      out.push({
        id: node.id,
        type: MAP_INFO_NODE_TYPE,
        position: saved ?? { x: MAP_NODE_X_MINIAPP, y: miniIndex * MAP_NODE_Y_STEP },
        data: {
          kind: 'mini-app-terminal',
          title: node.title,
          group: node.group,
          status: node.status ?? null,
          subtitle: node.route,
        } satisfies MapInfoNodeData,
      })
      miniIndex += 1
    }
  }
  return out
}

/** Canvas node type of a bot screen with no flow block (`SystemScreenNode`). */
export const SYSTEM_SCREEN_NODE_TYPE = 'systemScreen'

/**
 * The bot's screens with no flow block (`SYSTEM_SCREENS`) as read-only canvas
 * nodes: a column of their own left of the pinned main menu, where no screen
 * is placed by default, or where the operator left each (saved like the map
 * nodes, in `layoutData.mapNodePositions`). Not deletable — the bot sends
 * them whatever the canvas holds.
 */
const SYSTEM_SCREEN_X = -720
const SYSTEM_SCREEN_Y_START = -40
const SYSTEM_SCREEN_Y_STEP = 200

export function systemScreensToReactFlow(savedPositions?: MapNodePositions): Node[] {
  return SYSTEM_SCREENS.map((screen, index) => {
    const id = systemScreenNodeId(screen.id)
    return {
      id,
      type: SYSTEM_SCREEN_NODE_TYPE,
      position: savedPositions?.[id] ?? {
        x: SYSTEM_SCREEN_X,
        y: SYSTEM_SCREEN_Y_START + index * SYSTEM_SCREEN_Y_STEP,
      },
      deletable: false,
      data: { screenId: screen.id } satisfies SystemScreenNodeData,
    }
  })
}

/**
 * Read the persisted map-node positions out of a flow's `layoutData` JSON.
 * Stored under `mapNodePositions` by the bot-flow page's Save action so the
 * read-only notification / Mini App nodes keep the operator's manual layout
 * across reloads (they have no DB row of their own). Tolerant of any
 * malformed shape — returns an empty map rather than throwing.
 */
export function readMapNodePositions(layoutData: unknown): MapNodePositions {
  if (layoutData === null || typeof layoutData !== 'object') return {}
  const raw = (layoutData as Record<string, unknown>).mapNodePositions
  if (raw === null || typeof raw !== 'object') return {}
  const out: MapNodePositions = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value !== null && typeof value === 'object') {
      const { x, y } = value as { x?: unknown; y?: unknown }
      if (typeof x === 'number' && typeof y === 'number') {
        out[id] = { x, y }
      }
    }
  }
  return out
}

/**
 * Build dashed edges from the projected map nodes (notifications / Mini App
 * terminals) to their targets, using the backend-computed bot-map edges.
 * Only edges whose source is a map node and whose endpoints both exist on
 * the canvas are drawn — so an edge into a screen renders, while one into a
 * non-node destination (external URL / chat) is skipped.
 */
export function buildMapEdges(
  edges: ReadonlyArray<BotMapEdge>,
  mapNodeIds: ReadonlySet<string>,
  validNodeIds: ReadonlySet<string>,
): Edge[] {
  const out: Edge[] = []
  let i = 0
  for (const edge of edges) {
    if (!mapNodeIds.has(edge.source)) continue
    if (!validNodeIds.has(edge.target)) continue
    const color = EDGE_COLORS[i % EDGE_COLORS.length]
    i += 1
    // Anchor the edge to the specific button chip it belongs to. Notification
    // button edges carry the stable id `notif-btn:<source>:<index>`, and the
    // chip order in `botMapNodesToReactFlow` matches that index — so the arrow
    // leaves the right button instead of a single shared node handle. The
    // index is the final `:`-segment (the source itself contains colons, e.g.
    // `notif:expires_soon`, so parse from the end).
    let sourceHandle: string | undefined
    if (edge.id.startsWith('notif-btn:')) {
      const idx = Number(edge.id.slice(edge.id.lastIndexOf(':') + 1))
      if (Number.isInteger(idx) && idx >= 0) {
        sourceHandle = `${edge.source}-btn-${idx}`
      }
    }
    out.push({
      id: `map-edge-${edge.id}`,
      source: edge.source,
      ...(sourceHandle !== undefined ? { sourceHandle } : {}),
      target: edge.target,
      targetHandle: `${edge.target}-target`,
      type: 'smoothstep',
      animated: false,
      deletable: false,
      style: { stroke: color, strokeWidth: 2, strokeDasharray: '4 4' },
      markerEnd: { type: 'arrowclosed' as const, color },
      label: edge.sourceLabel,
      labelStyle: { fill: '#ffffff', fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: color, fillOpacity: 0.95 },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
    } as Edge)
  }
  return out
}
