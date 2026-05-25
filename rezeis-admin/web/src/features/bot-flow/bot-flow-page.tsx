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

  // Sync React Flow state when flow data loads — preserve local positions
  // TODO: refactor — move this merge into a derived selector instead of an effect.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!flow) return
    const { nodes: newNodes, edges: e } = flowToReactFlow(flow)

    // Merge: keep local positions if node already exists, use API positions only for new nodes
    setNodes((currentNodes) => {
      if (currentNodes.length === 0) return newNodes
      const currentMap = new Map(currentNodes.map((n) => [n.id, n]))
      return newNodes.map((n) => {
        const existing = currentMap.get(n.id)
        if (existing) {
          // Keep local position, update data only
          return { ...existing, data: n.data }
        }
        return n
      })
    })
    setEdges(e)
  }, [flow])
  /* eslint-enable react-hooks/set-state-in-effect */

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
        toast.error(t('botFlow.connectionError'))
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
        toast.error(t('botFlow.connectionError'))
        setEdges((eds) => eds.filter((e) => e.source !== connection.source || e.target !== connection.target))
      })
    }
  }, [flow, queryClient, t])

  const handleNodeClick = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId)
  }, [])

  const handleEdgeClick = useCallback((edgeId: string) => {
    // Find the button ID from edge ID (format: "edge-{buttonId}")
    const buttonId = edgeId.replace('edge-', '')
    if (!buttonId) return

    // Remove edge visually
    setEdges((eds) => eds.filter((e) => e.id !== edgeId))
    // Clear the button's targetScreenId
    api.put(`/admin/bot-flows/buttons/${buttonId}`, {
      targetScreenId: null,
    }).then(() => {
      queryClient.invalidateQueries({ queryKey: ['bot-flow', 'draft', FLOW_NAME] })
      toast.success(t('botFlow.edgeDeleted'))
    }).catch(() => {
      toast.error(t('botFlow.connectionError'))
      // Re-fetch to restore edge
      queryClient.invalidateQueries({ queryKey: ['bot-flow', 'draft', FLOW_NAME] })
    })
  }, [t, queryClient])

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
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b px-4 py-2 shrink-0">
        <div className="flex items-center gap-2">
          <Workflow className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{t('botFlow.title')}</span>
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

      {/* Canvas + Sidebar */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar — screen list + add */}
        <div className="w-52 border-r flex flex-col overflow-hidden shrink-0">
          <div className="px-2 pt-2 pb-1.5 border-b shrink-0">
            <div
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/bot-flow-node', 'botScreen')
                e.dataTransfer.effectAllowed = 'move'
              }}
              className="flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 cursor-grab hover:border-primary hover:bg-primary/5 transition-colors"
            >
              <Plus className="h-3 w-3 text-muted-foreground" />
              <span className="text-[11px] font-medium">{t('botFlow.newScreen')}</span>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-1.5 py-1.5 space-y-0.5">
            <p className="text-[9px] font-medium text-muted-foreground uppercase tracking-wider px-1 mb-1">
              {t('botFlow.palette')}
            </p>
            {flow?.screens
              .sort((a, b) => (a.isRoot ? -1 : b.isRoot ? 1 : 0))
              .map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setSelectedNodeId(s.id)
                    setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === s.id })))
                  }}
                  className={`w-full text-left rounded px-1.5 py-1 text-[11px] transition-colors truncate ${
                    selectedNodeId === s.id
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-muted text-foreground/80'
                  }`}
                >
                  <span className="flex items-center gap-1">
                    {s.isRoot && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />}
                    <span className="truncate">{s.name}</span>
                  </span>
                </button>
              ))}
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
              onEdgeClick={handleEdgeClick}
              onDrop={handleDrop}
            />
          </ReactFlowProvider>
        </div>

        {/* Right panel — screen editor */}
        {selectedNodeId && flow && (() => {
          const selectedScreen = flow.screens.find((s) => s.id === selectedNodeId)
          if (!selectedScreen) return null
          return (
            <div className="w-80 shrink-0 border-l overflow-y-auto overflow-x-hidden">
              <div className="p-3">
                <ScreenEditorPanel screen={selectedScreen} flowName={FLOW_NAME} />
              </div>
            </div>
          )
        })()}
      </div>
    </div>
  )
}
