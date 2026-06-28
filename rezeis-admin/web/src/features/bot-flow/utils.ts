import type { Node, Edge } from '@xyflow/react'
import {
  replyButtonHandleId,
  resolveReplyButtonColor,
} from './components/reply-keyboard-utils'
import type { MapInfoNodeData } from './components/MapInfoNode'
import { MAP_INFO_NODE_TYPE } from './components/MapInfoNode'
import type { BotMapNode, BotMapEdge } from '@/features/bot-map/types'
import type { BotFlow, BotFlowButton, BotScreenNodeData } from './types'

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
 * Build dotted edges from the pinned reply-keyboard pseudo-node to
 * each screen whose `name` matches a reply-button's `buttonId`.
 *
 * This is the visual companion to reiwa's runtime override matching
 * (`findScreenByName`): when a screen named `help` exists, reiwa
 * renders it instead of the built-in "Поддержка" handler. On the
 * canvas the operator now sees an explicit dashed line connecting
 * the reply-keyboard's "Помощь" button slot to the override screen,
 * so the routing is no longer hidden in code.
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
): Edge[] {
  if (flow === undefined || replyButtons === undefined) return []
  const replyNodeId = '__reply_keyboard__'
  const screenByName = new Map<string, BotFlow['screens'][number]>()
  for (const screen of flow.screens) {
    screenByName.set(screen.name.toLowerCase(), screen)
  }
  const edges: Edge[] = []
  for (const button of replyButtons) {
    if (!button.visible) continue
    const target = screenByName.get(button.buttonId.toLowerCase())
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
 * features/bot-config).
 */
export interface BotButtonLite {
  readonly id: string
  readonly buttonId: string
  readonly label: string
  readonly visible: boolean
}

/**
 * Built-in screens (help / invite / rules) reiwa renders with a single
 * runtime "◀️ В меню" button that returns to the welcome (`menu:main`).
 * That button is not a `BotFlowButton`, so the canvas shows no outgoing edge
 * for these screens. Draw a dashed back-edge from each system screen to the
 * root (welcome) screen so the round-trip routing is visible. Skipped when no
 * root screen exists (reiwa then falls back to the built-in welcome, which has
 * no canvas node).
 */
const SYSTEM_BACK_SCREENS: ReadonlySet<string> = new Set(['help', 'invite', 'rules'])

export function buildSystemScreenBackEdges(
  flow: BotFlow | undefined,
  backLabel: string,
): Edge[] {
  if (flow === undefined) return []
  const root = flow.screens.find((s) => s.isRoot)
  if (root === undefined) return []
  const color = '#94a3b8'
  const edges: Edge[] = []
  for (const screen of flow.screens) {
    if (screen.id === root.id) continue
    if (!SYSTEM_BACK_SCREENS.has(screen.name.trim().toLowerCase())) continue
    edges.push({
      id: `sysback-${screen.id}`,
      source: screen.id,
      sourceHandle: `${screen.id}-source`,
      target: root.id,
      targetHandle: `${root.id}-target`,
      type: 'smoothstep',
      animated: false,
      deletable: false,
      style: { stroke: color, strokeWidth: 1.5, strokeDasharray: '2 4' },
      markerEnd: { type: 'arrowclosed' as const, color },
      label: backLabel,
      labelStyle: { fill: '#ffffff', fontSize: 9, fontWeight: 600 },
      labelBgStyle: { fill: color, fillOpacity: 0.9 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
    } as Edge)
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
