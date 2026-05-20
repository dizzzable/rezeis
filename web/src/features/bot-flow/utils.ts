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

  // Build edges from NAVIGATE buttons
  const edges: Edge[] = flow.screens.flatMap((screen) =>
    screen.buttons
      .filter((btn) => btn.actionType === 'NAVIGATE' && btn.targetScreenId)
      .map((btn) => {
        const targetScreen = flow.screens.find((s) => s.shortId === btn.targetScreenId)
        if (!targetScreen) return null
        return {
          id: `edge-${btn.id}`,
          source: screen.id,
          sourceHandle: `btn-${btn.id}`,
          target: targetScreen.id,
          targetHandle: `${targetScreen.id}-target`,
          type: 'smoothstep',
          animated: true,
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
