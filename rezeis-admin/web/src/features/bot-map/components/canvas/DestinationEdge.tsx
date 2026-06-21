/**
 * DestinationEdge — custom React Flow edge for the bot-map canvas.
 *
 * Renders a smooth bezier path with a floating label that reuses the
 * same `DestinationBadge` as the list view, so the "where does this
 * button lead" semantics stay identical across tabs. Invalid edges
 * (dangling shortId, unsafe URL, unset target) are drawn red + dashed
 * with a native tooltip carrying the composer's reason.
 */
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'

import type { BotMapEdge, BotMapNode } from '../../types'
import { DestinationBadge } from '../DestinationBadge'

interface DestinationEdgeData extends Record<string, unknown> {
  readonly edge: BotMapEdge
  readonly nodesById?: ReadonlyMap<string, BotMapNode>
}

export function DestinationEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data } = props
  const payload = data as DestinationEdgeData | undefined
  const edge = payload?.edge

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  const invalid = edge ? !edge.valid : false

  return (
    <>
      <BaseEdge
        path={path}
        style={
          invalid
            ? { stroke: 'hsl(var(--destructive))', strokeWidth: 1.5, strokeDasharray: '6 4' }
            : { stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1.5 }
        }
      />
      {edge && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute flex max-w-[200px] items-center gap-1"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title={invalid ? edge.reason : undefined}
          >
            <span className="rounded bg-background/90 px-1 text-[10px] text-muted-foreground shadow-sm">
              {edge.sourceLabel}
            </span>
            <DestinationBadge edge={edge} nodesById={payload?.nodesById} />
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export const BOT_MAP_EDGE_TYPES = {
  destination: DestinationEdge,
} as const
