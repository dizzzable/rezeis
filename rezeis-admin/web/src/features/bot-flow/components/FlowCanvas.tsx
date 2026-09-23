import { useCallback, useEffect, useRef } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type Node,
  type Edge,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { BotScreenNode } from './BotScreenNode'
import { ReplyKeyboardNode } from './ReplyKeyboardNode'
import { MapInfoNode } from './MapInfoNode'
import { SystemScreenNode } from './SystemScreenNode'
import type { BotScreenNodeData } from '../types'

const nodeTypes = {
  botScreen: BotScreenNode,
  replyKeyboard: ReplyKeyboardNode,
  mapInfo: MapInfoNode,
  // `SYSTEM_SCREEN_NODE_TYPE` — the bot's screens with no flow block.
  systemScreen: SystemScreenNode,
}

interface FlowCanvasProps {
  nodes: Node[]
  edges: Edge[]
  onNodesChange: OnNodesChange
  onEdgesChange: OnEdgesChange
  onConnect: OnConnect
  onNodeClick: (nodeId: string) => void
  onEdgeClick: (edgeId: string) => void
  onDrop: (position: { x: number; y: number }) => void
  /**
   * When set, the canvas re-centers on this node. `nonce` forces a
   * re-center even when the same node is re-selected from the rail.
   */
  focusNode?: { id: string; nonce: number } | null
}

export function FlowCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodeClick,
  onEdgeClick,
  onDrop,
  focusNode,
}: FlowCanvasProps) {
  const reactFlowRef = useRef<ReactFlowInstance | null>(null)

  // Re-center the viewport on a node selected from the left rail. Keyed on
  // `nonce` so re-selecting the same node still re-centers.
  useEffect(() => {
    if (!focusNode || reactFlowRef.current === null) return
    reactFlowRef.current.fitView({
      nodes: [{ id: focusNode.id }],
      duration: 400,
      maxZoom: 1.2,
      padding: 0.4,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNode?.nonce])

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      const type = event.dataTransfer.getData('application/bot-flow-node')
      if (type !== 'botScreen' || !reactFlowRef.current) return

      const position = reactFlowRef.current.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      })
      onDrop(position)
    },
    [onDrop],
  )

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      onNodeClick(node.id)
    },
    [onNodeClick],
  )

  const handleEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      onEdgeClick(edge.id)
    },
    [onEdgeClick],
  )

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onInit={(instance) => { reactFlowRef.current = instance }}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        nodeTypes={nodeTypes}
        fitView={false}
        snapToGrid
        snapGrid={[16, 16]}
        deleteKeyCode={['Backspace', 'Delete']}
        className="bg-background"
      >
        <Background gap={16} size={1} />
        <Controls className="!bg-card !border !border-border !rounded-lg !shadow-lg [&>button]:!bg-card [&>button]:!border-border [&>button]:!text-foreground [&>button:hover]:!bg-accent" />
        <MiniMap
          nodeColor={(node) => {
            if (node.type === 'replyKeyboard') return '#f59e0b'
            if (node.type === 'systemScreen') return '#8b5cf6'
            if (node.type === 'mapInfo') {
              const md = node.data as unknown as { kind?: string }
              return md.kind === 'notification' ? '#f43f5e' : '#0ea5e9'
            }
            const nd = node.data as unknown as BotScreenNodeData
            return nd.isRoot ? '#22c55e' : '#64748b'
          }}
          maskColor="rgba(0,0,0,0.2)"
          className="!bg-card !border !border-border !rounded-lg"
          style={{ width: 120, height: 80 }}
        />
      </ReactFlow>
    </div>
  )
}
