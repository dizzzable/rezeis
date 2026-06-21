/**
 * Pure layout + edge synthesis for the bot-map "Схема" canvas.
 *
 * The backend payload carries NO positions — the canvas is laid out
 * deterministically by node kind into vertical columns:
 *
 *   ┌ reply + graph ┐  ┌ notifications ┐  ┌ mini-app pages ┐
 *   │   x ≈ 0       │  │   x ≈ 380     │  │   x ≈ 760      │
 *   └───────────────┘  └───────────────┘  └────────────────┘
 *
 * Edges are emitted ONLY when both endpoints are real nodes in the
 * payload. Synthetic destinations (callbacks, support chat, raw URLs,
 * "back") never reach a node id, so React Flow would drop them anyway —
 * we filter them up-front to keep the canvas honest and warning-free.
 *
 * Extracted as a pure function so the column/edge logic is unit-testable
 * without mounting React Flow.
 */
import { MarkerType, type Edge, type Node } from '@xyflow/react'

import type { BotMapNode, BotMapPayload } from '../../types'

export type CanvasNode = Node<Record<string, unknown>, string>
export type CanvasEdge = Edge<Record<string, unknown>>

/**
 * Rotating edge palette — mirrors the legacy constructor's `EDGE_COLORS` so the
 * merged module reads the same way. Each emitted edge gets a distinct color so
 * operators can tell which button a path leaves from.
 */
const EDGE_PALETTE = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
  '#14b8a6', // teal
] as const

/** Red used for dangling / unsafe edges, regardless of palette slot. */
export const INVALID_EDGE_COLOR = '#ef4444'

/** Total color pick over the palette (wraps; never throws). */
export function pickEdgeColor(index: number): string {
  const len = EDGE_PALETTE.length
  return EDGE_PALETTE[((index % len) + len) % len]
}

const COLUMN_X = {
  left: 0,
  middle: 380,
  right: 760,
} as const

const ROW_GAP = 140
const COLUMN_TOP = 0

/** Which column a node lands in, by kind. */
function columnFor(node: BotMapNode): keyof typeof COLUMN_X {
  switch (node.kind) {
    case 'reply-keyboard':
    case 'graph-screen':
      return 'left'
    case 'notification':
      return 'middle'
    case 'mini-app-terminal':
      return 'right'
  }
}

export interface CanvasGraph {
  readonly nodes: CanvasNode[]
  readonly edges: CanvasEdge[]
}

/**
 * Builds React Flow nodes (with deterministic positions) and edges from
 * the bot-map payload.
 */
export function buildCanvasGraph(payload: BotMapPayload): CanvasGraph {
  const rowByColumn: Record<keyof typeof COLUMN_X, number> = {
    left: 0,
    middle: 0,
    right: 0,
  }

  const nodes: CanvasNode[] = payload.nodes.map((node) => {
    const column = columnFor(node)
    const row = rowByColumn[column]
    rowByColumn[column] += 1
    return {
      id: node.id,
      type: node.kind,
      position: { x: COLUMN_X[column], y: COLUMN_TOP + row * ROW_GAP },
      data: node as unknown as Record<string, unknown>,
    }
  })

  const nodeIds = new Set(payload.nodes.map((n) => n.id))
  const kindById = new Map(payload.nodes.map((n) => [n.id, n.kind]))

  const edges: CanvasEdge[] = payload.edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map((edge, index) => {
      const reply = kindById.get(edge.source) === 'reply-keyboard'
      // Invalid edges are always red; otherwise a distinct palette color so
      // each button's path reads separately. Reply-keyboard routes (and broken
      // links) are dashed to telegraph "not an explicit NAVIGATE link".
      const color = edge.valid ? pickEdgeColor(index) : INVALID_EDGE_COLOR
      const dashed = reply || !edge.valid
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'destination',
        data: {
          edge: edge as unknown as Record<string, unknown>,
          color,
          dashed,
        },
        animated: edge.valid,
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18 },
      }
    })

  return { nodes, edges }
}
