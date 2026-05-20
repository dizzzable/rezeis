import { useCallback, useRef } from 'react'
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
import type { BotScreenNodeData } from '../types'

const nodeTypes = { botScreen: BotScreenNode }

interface FlowCanvasProps {
  nodes: Node[]
  edges: Edge[]
  onNodesChange: OnNodesChange
  onEdgesChange: OnEdgesChange
  onConnect: OnConnect
  onNodeClick: (nodeId: string) => void
  onDrop: (position: { x: number; y: number }) => void
}

export function FlowCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodeClick,
  onDrop,
}: FlowCanvasProps) {
  const reactFlowRef = useRef<ReactFlowInstance | null>(null)

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

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={handleNodeClick}
        onInit={(instance) => { reactFlowRef.current = instance }}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        nodeTypes={nodeTypes}
        fitView
        snapToGrid
        snapGrid={[16, 16]}
        deleteKeyCode={['Backspace', 'Delete']}
        className="bg-background"
      >
        <Background gap={16} size={1} className="!bg-muted/20" />
        <Controls className="!bg-card !border-border !shadow-md" />
        <MiniMap
          nodeColor={(node) => {
            const nd = node.data as unknown as BotScreenNodeData
            return nd.isRoot ? '#22c55e' : '#64748b'
          }}
          maskColor="rgba(0,0,0,0.08)"
          className="!bg-card !border-border !shadow-md"
        />
      </ReactFlow>
    </div>
  )
}
