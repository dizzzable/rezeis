import type { Node, Edge } from '@xyflow/react'
import type { BotFlow, BotFlowButton, BotFlowScreen, BotScreenNodeData } from './types'

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
