/**
 * Bot Studio
 * ==========
 * Single-canvas editor for the entire user-facing bot surface:
 *
 *   • Inline-keyboard graph: every screen is a node, every NAVIGATE
 *     button is a handle, every cross-screen link is an edge. The
 *     existing `botFlow` table backs this layer.
 *
 *   • Global reply-keyboard: pinned pseudo-node at the top-left of the
 *     canvas, distinct visually (dashed amber border + global badge),
 *     non-draggable, non-deletable. Selecting it opens the dedicated
 *     ReplyKeyboardEditorPanel in the right inspector. Backed by the
 *     `botButton` table via /admin/bot-config/buttons.
 *
 *   • Global resources: emojis & copy texts live behind toolbar buttons
 *     that open a Sheet drawer with full CRUD. They are not rendered on
 *     the canvas because they have no spatial meaning.
 *
 * Rationale
 * ---------
 * Reply-keyboard and inline-keyboard are independent Telegram concepts
 * with different lifetimes and semantics; merging them into a single
 * node tree would lie about the data model. Yet operators want a single
 * place to manage everything user-visible — hence the pinned pseudo-node
 * pattern. The id `__reply_keyboard__` is a sentinel: any code path that
 * touches it routes to the bot-config endpoints, never to bot-flows.
 *
 * Position-merge effect (lines below) is the same pattern Wave 4 of the
 * earlier rewrite arrived at: keep React Flow's local positions sticky
 * across refetches so a drag in flight is not yanked back when the
 * server returns the unchanged positionX/Y. We extend it with a sentinel
 * filter so the pinned reply-node never gets a server-side override.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { Workflow, Plus, Check, Save, Smile, Type, Upload, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

import { BotEmojisTab } from '@/features/bot-config/bot-emojis-tab'
import { BotTextsTab } from '@/features/bot-config/bot-texts-tab'
import { ReplyKeyboardEditorPanel } from '@/features/bot-config/reply-keyboard-editor-panel'
import {
  BOT_CONFIG_KEYS,
  type BotButton,
  botConfigApi,
} from '@/features/bot-config/bot-config-api'

import { FlowCanvas } from './components/FlowCanvas'
import { ScreenEditorPanel } from './components/ScreenEditorPanel'
import {
  REPLY_KEYBOARD_NODE_ID,
  REPLY_KEYBOARD_NODE_TYPE,
  type ReplyKeyboardNodeData,
} from './components/ReplyKeyboardNode'
import { flowToReactFlow, nodesToPositions } from './utils'
import type { BotFlow, BotFlowScreen } from './types'

const FLOW_NAME = 'Main Flow'

/**
 * Pinned position for the reply-keyboard pseudo-node. We keep it just to
 * the left of the typical screen origin so it's the first thing the
 * operator sees on canvas open without overlapping with screens.
 */
const REPLY_NODE_POSITION = { x: -360, y: -40 } as const

export default function BotFlowPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  // Sheet drawers for global resources
  const [emojisOpen, setEmojisOpen] = useState(false)
  const [textsOpen, setTextsOpen] = useState(false)

  // ── Load draft flow + reply-keyboard buttons in parallel ───────────────────
  const { data: flow, isLoading: flowLoading } = useQuery<BotFlow>({
    queryKey: ['bot-flow', 'draft', FLOW_NAME],
    queryFn: async () =>
      (await api.get(`/admin/bot-flows/draft/${encodeURIComponent(FLOW_NAME)}`)).data,
  })

  const { data: replyButtons } = useQuery({
    queryKey: BOT_CONFIG_KEYS.buttons,
    queryFn: botConfigApi.listButtons,
  })

  // ── Project flow + reply-keyboard into React Flow node graph ───────────────
  // Memoise so the effect below only fires when something actually changes.
  const projectedGraph = useMemo(() => {
    if (!flow) return null
    return flowToReactFlow(flow)
  }, [flow])

  const replyNode: Node | null = useMemo(() => {
    if (!replyButtons) return null
    return {
      id: REPLY_KEYBOARD_NODE_ID,
      type: REPLY_KEYBOARD_NODE_TYPE,
      position: REPLY_NODE_POSITION,
      // Pinned-node contract: never moves with the rest of the canvas
      // and the user cannot drag it. Selection still works (so clicking
      // it opens the right inspector); it just stays put.
      draggable: false,
      deletable: false,
      data: { buttons: replyButtons } satisfies ReplyKeyboardNodeData,
    } satisfies Node
  }, [replyButtons])

  // Sync React Flow state — preserve local positions so an in-flight drag
  // is not undone when the server returns the same positionX/Y. Reuses the
  // merge logic from Wave 3 of the bot-flow refactor.
  useEffect(() => {
    if (!projectedGraph) return
    const { nodes: incoming, edges: incomingEdges } = projectedGraph

    setNodes((current) => {
      // Carry over local positions from the previous render keyed by id.
      const previousById = new Map(current.map((node) => [node.id, node]))
      const merged: Node[] = incoming.map((node) => {
        const existing = previousById.get(node.id)
        if (existing) return { ...existing, data: node.data }
        return node
      })

      if (replyNode) {
        // Preserve any in-flight selection on the pinned node so clicking
        // it once does not get undone by the next refetch.
        const existing = previousById.get(REPLY_KEYBOARD_NODE_ID)
        merged.unshift(existing ? { ...existing, data: replyNode.data } : replyNode)
      }
      return merged
    })

    setEdges(incomingEdges)
    // We deliberately exclude `replyNode` identity from this deps list:
    // the merge above always picks the latest reference via the closure,
    // and recomputing the entire flow because the buttons list got a new
    // reference would yank the user's selection mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectedGraph])

  // Separate effect to refresh just the reply-node data on bot-button
  // mutations without reprojecting the whole flow.
  useEffect(() => {
    if (!replyNode) return
    setNodes((current) => {
      const idx = current.findIndex((n) => n.id === REPLY_KEYBOARD_NODE_ID)
      if (idx === -1) return [replyNode, ...current]
      const next = current.slice()
      next[idx] = { ...next[idx], data: replyNode.data }
      return next
    })
  }, [replyNode])

  // ── Mutations ──────────────────────────────────────────────────────────────
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
      // The pinned reply-keyboard node has no row in the bot-flow tables;
      // it must never reach the positions endpoint. Server would 404 and
      // (worse) the partial save would skip our real screen positions.
      const filtered = positions.filter((p) => p.id !== REPLY_KEYBOARD_NODE_ID)
      if (filtered.length === 0) return
      await api.put('/admin/bot-flows/screens/positions', { positions: filtered })
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

  const refreshBotMutation = useMutation({
    mutationFn: async (): Promise<{ ok: boolean }> => {
      const { data } = await api.post<{ ok: boolean }>(
        '/admin/bot-config/refresh-bot',
      )
      return data
    },
    onSuccess: (data) => {
      if (data.ok) {
        toast.success(t('botStudio.toolbar.refreshBotSuccess'))
      } else {
        toast.error(t('botStudio.toolbar.refreshBotUnreachable'))
      }
    },
    onError: () => {
      toast.error(t('botStudio.toolbar.refreshBotError'))
    },
  })

  // ── Handlers ───────────────────────────────────────────────────────────────
  const onNodesChange: OnNodesChange = useCallback((changes) => {
    setNodes((nds) => applyNodeChanges(changes, nds))
  }, [])

  const onEdgesChange: OnEdgesChange = useCallback((changes) => {
    setEdges((eds) => applyEdgeChanges(changes, eds))
  }, [])

  const onConnect: OnConnect = useCallback(
    (connection) => {
      setEdges((eds) =>
        addEdge({ ...connection, type: 'smoothstep', animated: true }, eds),
      )

      // Reject any attempt to connect to/from the pinned reply-keyboard
      // node. Telegram's reply keyboard is global — it does not link to
      // a specific screen, so an edge here would be meaningless.
      if (
        connection.source === REPLY_KEYBOARD_NODE_ID ||
        connection.target === REPLY_KEYBOARD_NODE_ID
      ) {
        toast.error(t('botStudio.replyKeyboard.cannotConnect'))
        setEdges((eds) =>
          eds.filter(
            (e) => e.source !== connection.source || e.target !== connection.target,
          ),
        )
        return
      }

      if (!flow || !connection.source || !connection.target) return

      const targetScreen = flow.screens.find((s) => s.id === connection.target)
      if (!targetScreen) return

      if (connection.sourceHandle?.startsWith('btn-')) {
        const buttonId = connection.sourceHandle.replace('btn-', '')
        api
          .put(`/admin/bot-flows/buttons/${buttonId}`, {
            actionType: 'NAVIGATE',
            targetScreenId: targetScreen.shortId,
          })
          .then(() => {
            queryClient.invalidateQueries({ queryKey: ['bot-flow', 'draft', FLOW_NAME] })
          })
          .catch(() => {
            toast.error(t('botFlow.connectionError'))
            setEdges((eds) =>
              eds.filter(
                (e) =>
                  e.source !== connection.source || e.sourceHandle !== connection.sourceHandle,
              ),
            )
          })
      } else {
        api
          .post('/admin/bot-flows/buttons', {
            screenId: connection.source,
            labelRu: targetScreen.name,
            labelEn: targetScreen.name,
            actionType: 'NAVIGATE',
            targetScreenId: targetScreen.shortId,
          })
          .then(() => {
            queryClient.invalidateQueries({ queryKey: ['bot-flow', 'draft', FLOW_NAME] })
          })
          .catch(() => {
            toast.error(t('botFlow.connectionError'))
            setEdges((eds) =>
              eds.filter((e) => e.source !== connection.source || e.target !== connection.target),
            )
          })
      }
    },
    [flow, queryClient, t],
  )

  const handleNodeClick = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId)
  }, [])

  const handleEdgeClick = useCallback(
    (edgeId: string) => {
      const buttonId = edgeId.replace('edge-', '')
      if (!buttonId) return
      setEdges((eds) => eds.filter((e) => e.id !== edgeId))
      api
        .put(`/admin/bot-flows/buttons/${buttonId}`, { targetScreenId: null })
        .then(() => {
          queryClient.invalidateQueries({ queryKey: ['bot-flow', 'draft', FLOW_NAME] })
          toast.success(t('botFlow.edgeDeleted'))
        })
        .catch(() => {
          toast.error(t('botFlow.connectionError'))
          queryClient.invalidateQueries({ queryKey: ['bot-flow', 'draft', FLOW_NAME] })
        })
    },
    [t, queryClient],
  )

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

  // ── Right inspector router ─────────────────────────────────────────────────
  const selectedScreen = useMemo<BotFlowScreen | null>(() => {
    if (!flow || !selectedNodeId || selectedNodeId === REPLY_KEYBOARD_NODE_ID) return null
    return flow.screens.find((s) => s.id === selectedNodeId) ?? null
  }, [flow, selectedNodeId])

  const showReplyInspector = selectedNodeId === REPLY_KEYBOARD_NODE_ID

  // Save / Publish only make sense once at least one bot-flow screen exists.
  // The reply-keyboard pseudo-node persists every edit immediately via the
  // bot-config endpoints; emojis & texts in their drawers do the same. So
  // when the operator hasn't created any screens yet (or only has the
  // pinned reply node selected on a screen-less canvas), hiding the
  // graph-only buttons removes the misleading "Publish required at least
  // one start screen" error path.
  const hasScreens = (flow?.screens.length ?? 0) > 0

  if (flowLoading) {
    return (
      <div className="flex h-[calc(100vh-8rem)] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center justify-between border-b px-4 py-2">
        <div className="flex items-center gap-2">
          <Workflow className="h-4 w-4 text-muted-foreground" aria-hidden />
          <span className="text-sm font-medium">{t('botFlow.title')}</span>
          {flow && (
            <span className="text-xs text-muted-foreground">
              v{flow.version} · {flow.status.toLowerCase()}
            </span>
          )}
          {showReplyInspector && (
            <span className="ml-2 inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
              <Check className="h-3 w-3" aria-hidden />
              {t('botStudio.toolbar.autoSaved')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => refreshBotMutation.mutate()}
            disabled={refreshBotMutation.isPending}
            title={t('botStudio.toolbar.refreshBotHint')}
            aria-label={t('botStudio.toolbar.refreshBotAria')}
          >
            <RefreshCw
              className={`mr-1.5 h-3.5 w-3.5 ${
                refreshBotMutation.isPending ? 'animate-spin' : ''
              }`}
              aria-hidden
            />
            {t('botStudio.toolbar.refreshBot')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEmojisOpen(true)}>
            <Smile className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {t('botStudio.toolbar.emojis')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setTextsOpen(true)}>
            <Type className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {t('botStudio.toolbar.texts')}
          </Button>
          {hasScreens && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleSave}
                disabled={savePositionsMutation.isPending}
                title={t('botStudio.toolbar.saveHint')}
              >
                <Save className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                {t('botStudio.toolbar.savePositions')}
              </Button>
              <Button
                size="sm"
                onClick={() => publishMutation.mutate()}
                disabled={publishMutation.isPending}
                title={t('botStudio.toolbar.publishHint')}
              >
                <Upload className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                {t('botStudio.toolbar.publishFlow')}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Canvas + Sidebar */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left palette + screen list */}
        <div className="flex w-52 shrink-0 flex-col overflow-hidden border-r">
          <div className="shrink-0 border-b px-2 pb-1.5 pt-2">
            <div
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/bot-flow-node', 'botScreen')
                e.dataTransfer.effectAllowed = 'move'
              }}
              className="flex cursor-grab items-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 transition-colors hover:border-primary hover:bg-primary/5"
            >
              <Plus className="h-3 w-3 text-muted-foreground" aria-hidden />
              <span className="text-[11px] font-medium">{t('botFlow.newScreen')}</span>
            </div>
          </div>
          <div className="flex-1 space-y-0.5 overflow-y-auto px-1.5 py-1.5">
            <p className="mb-1 px-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
              {t('botStudio.palette.global')}
            </p>
            <button
              onClick={() => {
                setSelectedNodeId(REPLY_KEYBOARD_NODE_ID)
                setNodes((nds) =>
                  nds.map((n) => ({ ...n, selected: n.id === REPLY_KEYBOARD_NODE_ID })),
                )
              }}
              className={`w-full truncate rounded px-1.5 py-1 text-left text-[11px] transition-colors ${
                showReplyInspector
                  ? 'bg-accent text-accent-foreground'
                  : 'text-foreground/80 hover:bg-muted'
              }`}
            >
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden />
                <span className="truncate">{t('botStudio.replyKeyboard.nodeTitle')}</span>
              </span>
            </button>

            <p className="mb-1 mt-2 px-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
              {t('botFlow.palette')}
            </p>
            {flow?.screens
              .slice()
              .sort((a, b) => (a.isRoot ? -1 : b.isRoot ? 1 : 0))
              .map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setSelectedNodeId(s.id)
                    setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === s.id })))
                  }}
                  className={`w-full truncate rounded px-1.5 py-1 text-left text-[11px] transition-colors ${
                    selectedNodeId === s.id
                      ? 'bg-accent text-accent-foreground'
                      : 'text-foreground/80 hover:bg-muted'
                  }`}
                >
                  <span className="flex items-center gap-1">
                    {s.isRoot && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                        aria-hidden
                      />
                    )}
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

        {/* Right inspector */}
        {showReplyInspector && (
          <div className="w-80 shrink-0 overflow-y-auto overflow-x-hidden border-l">
            <div className="p-3">
              <ReplyKeyboardEditorPanel />
            </div>
          </div>
        )}
        {selectedScreen && !showReplyInspector && (
          <div className="w-80 shrink-0 overflow-y-auto overflow-x-hidden border-l">
            <div className="p-3">
              <ScreenEditorPanel screen={selectedScreen} flowName={FLOW_NAME} />
            </div>
          </div>
        )}
      </div>

      {/* Sheet drawers — global emojis & texts */}
      <Sheet open={emojisOpen} onOpenChange={setEmojisOpen}>
        <SheetContent side="right" className="w-full max-w-2xl overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>{t('botStudio.toolbar.emojis')}</SheetTitle>
            <SheetDescription>{t('botStudio.drawers.emojisDescription')}</SheetDescription>
          </SheetHeader>
          <div className="mt-4">
            <BotEmojisTab />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={textsOpen} onOpenChange={setTextsOpen}>
        <SheetContent side="right" className="w-full max-w-3xl overflow-y-auto sm:max-w-3xl">
          <SheetHeader>
            <SheetTitle>{t('botStudio.toolbar.texts')}</SheetTitle>
            <SheetDescription>{t('botStudio.drawers.textsDescription')}</SheetDescription>
          </SheetHeader>
          <div className="mt-4">
            <BotTextsTab />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
