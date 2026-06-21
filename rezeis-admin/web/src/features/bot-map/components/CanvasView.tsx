/**
 * CanvasView — the "Схема" tab. A *contained* React Flow canvas that
 * renders the very same `BotMapPayload` nodes + edges as the list, with
 * custom node cards per kind and a destination edge that mirrors the
 * list's badges. Layout is deterministic (see buildCanvasGraph) — the
 * payload carries no positions.
 *
 * Clicking a node calls `onSelect`, which lifts selection up to the
 * shell so the shared InspectorRouter opens the exact same editor as
 * the list view.
 */
import { useMemo } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type NodeMouseHandler,
} from '@xyflow/react'

import type { BotMapNode, BotMapPayload } from '../types'
import { buildCanvasGraph, type CanvasEdge } from './canvas/build-canvas-graph'
import { BOT_MAP_EDGE_TYPES } from './canvas/DestinationEdge'
import { BOT_MAP_NODE_TYPES } from './canvas/node-types'

import '@xyflow/react/dist/style.css'

interface CanvasViewProps {
  readonly payload: BotMapPayload
  readonly selectedId: string | null
  readonly onSelect: (id: string) => void
}

export function CanvasView({ payload, selectedId, onSelect }: CanvasViewProps) {
  const nodesById = useMemo(() => {
    const map = new Map<string, BotMapNode>()
    for (const node of payload.nodes) map.set(node.id, node)
    return map
  }, [payload.nodes])

  const { nodes, edges } = useMemo(() => {
    const graph = buildCanvasGraph(payload)
    const enrichedNodes = graph.nodes.map((node) => ({
      ...node,
      selected: node.id === selectedId,
    }))
    const enrichedEdges: CanvasEdge[] = graph.edges.map((edge) => ({
      ...edge,
      data: { ...edge.data, nodesById },
    }))
    return { nodes: enrichedNodes, edges: enrichedEdges }
  }, [payload, selectedId, nodesById])

  const handleNodeClick: NodeMouseHandler = (_event, node) => {
    onSelect(node.id)
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={BOT_MAP_NODE_TYPES}
      edgeTypes={BOT_MAP_EDGE_TYPES}
      onNodeClick={handleNodeClick}
      fitView
      proOptions={{ hideAttribution: true }}
      minZoom={0.2}
      maxZoom={1.5}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
    >
      <Background gap={16} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable className="hidden! md:block!" />
    </ReactFlow>
  )
}
