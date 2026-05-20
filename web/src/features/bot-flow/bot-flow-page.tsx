import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  type Node,
  type Edge,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  ReactFlowProvider,
} from '@xyflow/react'
import { Workflow, Plus, Save, Upload } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { FadeIn } from '@/lib/motion'
import { FlowCanvas } from './components/FlowCanvas'
import { ScreenEditorPanel } from './components/ScreenEditorPanel'
import { flowToReactFlow, nodesToPositions } from './utils'
import type { BotFlow, BotFlowScreen } from './types'

const FLOW_NAME = 'Main Flow'

export default function BotFlowPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  // ── Load draft flow ─────────────────────────────────────────────────────────
  const { data: flow, isLoading } = useQuery<BotFlow>({
    queryKey: ['bot-flow', 'draft', FLOW_NAME],
    queryFn: async () => (await api.get(`/admin/bot-flows/draft/${encodeURIComponent(FLOW_NAME)}`)).data,
  })

  // Sync React Flow state when flow data loads
  useEffect(() => {
    if (!flow) return
    const { nodes: n, edges: e } = flowToReactFlow(flow)
    setNodes(n)
    setEdges(e)
  }, [flow])

  // ── Mutations ───────────────────────────────────────────────────────────────
  const createScreenMutation = useMutation({
    mutationFn: async (position: { x: number; y: number }) => {
      const res = await api.post('/admin/bot-flows/screens', {
        flowId: flow?.id,
        positionX: position.x,
        positionY: position.y,
        isRoot: (flow?.screens.length ?? 0) === 0,
      })
      return res.data as BotFlowScreen
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bot-flow', 'draft', FLOW_NAME] })
      toast.success(t('botFlow.screenCreated'))
    },
  })

  const savePositionsMutation = useMutation({
    mutationFn: async (positions: Array<{ id: string; x: number; y: number }>) => {
      await api.put('/admin/bot-flows/screens/positions', { positions })
    },
  })

  const publishMutation = useMutation({
    mutationFn: async () => {
      await api.post(`/admin/bot-flows/${flow?.id}/publish`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bot-flow'] })
      toast.success(t('botFlow.published'))
    },
    onError: () => {
      toast.error(t('botFlow.publishError'))
    },
  })

  // ── Handlers ────────────────────────────────────────────────────────────────
  const onNodesChange: OnNodesChange = useCallback((changes) => {
    setNodes((nds) => applyNodeChanges(changes, nds))
  }, [])

  const onEdgesChange: OnEdgesChange = useCallback((changes) => {
    setEdges((eds) => applyEdgeChanges(changes, eds))
  }, [])

  const onConnect: OnConnect = useCallback((connection) => {
    setEdges((eds) => addEdge({ ...connection, type: 'smoothstep', animated: true }, eds))

    // Auto-create a NAVIGATE button when connecting from a new source handle
    // If sourceHandle starts with "btn-" it's an existing button — just update its target
    // If it's a generic handle, create a new button
    if (!flow || !connection.source || !connection.target) return

    const targetScreen = flow.screens.find((s) => s.id === connection.target)
    if (!targetScreen) return

    if (connection.sourceHandle?.startsWith('btn-')) {
      // Existing button — update its targetScreenId
      const buttonId = connection.sourceHandle.replace('btn-', '')
      api.put(`/admin/bot-flows/buttons/${buttonId}`, {
        actionType: 'NAVIGATE',
        targetScreenId: targetScreen.shortId,
      }).then(() => {
        queryClient.invalidateQueries({ queryKey: ['bot-flow', 'draft', FLOW_NAME] })
      }).catch(() => {
        toast.error(t('botFlow.connectionError', 'Failed to save connection'))
        // Remove the optimistic edge
        setEdges((eds) => eds.filter((e) => e.source !== connection.source || e.sourceHandle !== connection.sourceHandle))
      })
    } else {
      // New connection from node target handle — create a new NAVIGATE button on source screen
      api.post('/admin/bot-flows/buttons', {
        screenId: connection.source,
        labelRu: targetScreen.name,
        labelEn: targetScreen.name,
        actionType: 'NAVIGATE',
        targetScreenId: targetScreen.shortId,
      }).then(() => {
        queryClient.invalidateQueries({ queryKey: ['bot-flow', 'draft', FLOW_NAME] })
      }).catch(() => {
        toast.error(t('botFlow.connectionError', 'Failed to save connection'))
        setEdges((eds) => eds.filter((e) => e.source !== connection.source || e.target !== connection.target))
      })
    }
  }, [flow, queryClient])

  const handleNodeClick = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId)
  }, [])

  const handleDrop = useCallback(
    (position: { x: number; y: number }) => {
      if (!flow) return
      createScreenMutation.mutate(position)
    },
    [flow, createScreenMutation],
  )

  const handleSave = useCallback(() => {
    if (!flow) return
    const positions = nodesToPositions(nodes)
    savePositionsMutation.mutate(positions, {
      onSuccess: () => toast.success(t('botFlow.saved')),
    })
  }, [flow, nodes, savePositionsMutation, t])

  if (isLoading) {
    return (
      <div className="flex h-[calc(100vh-8rem)] items-center justify-center">
        <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Toolbar */}
      <FadeIn>
        <div className="flex items-center justify-between border-b px-4 py-2">
          <div className="flex items-center gap-2">
            <Workflow className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">{t('botFlow.title')}</h1>
            {flow && (
              <span className="text-xs text-muted-foreground">
                v{flow.version} · {flow.status.toLowerCase()}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleSave} disabled={savePositionsMutation.isPending}>
              <Save className="h-3.5 w-3.5 mr-1.5" />
              {t('botFlow.save')}
            </Button>
            <Button size="sm" onClick={() => publishMutation.mutate()} disabled={publishMutation.isPending}>
              <Upload className="h-3.5 w-3.5 mr-1.5" />
              {t('botFlow.publish')}
            </Button>
          </div>
        </div>
      </FadeIn>

      {/* Canvas + Sidebar */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar — node palette */}
        <div className="w-48 border-r p-3 space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {t('botFlow.palette')}
          </p>
          <div
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/bot-flow-node', 'botScreen')
              e.dataTransfer.effectAllowed = 'move'
            }}
            className="flex items-center gap-2 rounded-lg border border-dashed p-2.5 cursor-grab hover:border-primary hover:bg-primary/5 transition-colors"
          >
            <Plus className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs font-medium">{t('botFlow.newScreen')}</span>
          </div>
        </div>

        {/* Canvas */}
        <div className="flex-1">
          <ReactFlowProvider>
            <FlowCanvas
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={handleNodeClick}
              onDrop={handleDrop}
            />
          </ReactFlowProvider>
        </div>

        {/* Right panel — screen editor */}
        {selectedNodeId && flow && (() => {
          const selectedScreen = flow.screens.find((s) => s.id === selectedNodeId)
          if (!selectedScreen) return null
          return (
            <div className="w-80 border-l p-4 overflow-y-auto">
              <ScreenEditorPanel screen={selectedScreen} flowName={FLOW_NAME} />
            </div>
          )
        })()}
      </div>
    </div>
  )
}
