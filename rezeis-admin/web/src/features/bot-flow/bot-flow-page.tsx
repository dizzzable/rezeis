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
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
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
import { Workflow, Plus, Check, Save, Type, Upload, RefreshCw, Image as ImageIcon, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

import { BotTextsTab } from '@/features/bot-config/bot-texts-tab'
import BotBannerTab from '@/features/bot-config/bot-banner-tab'
import { ReplyKeyboardEditorPanel } from '@/features/bot-config/reply-keyboard-editor-panel'
import {
  BOT_CONFIG_KEYS,
  botConfigApi,
} from '@/features/bot-config/bot-config-api'

import { FlowCanvas } from './components/FlowCanvas'
import { ScreenEditorPanel } from './components/ScreenEditorPanel'
import {
  REPLY_KEYBOARD_NODE_ID,
  REPLY_KEYBOARD_NODE_TYPE,
  type ReplyKeyboardNodeData,
} from './components/ReplyKeyboardNode'
import { buildReplyToScreenEdges, buildMapEdges, buildSystemScreenBackEdges, botMapNodesToReactFlow, flowToReactFlow, nodesToPositions, readMapNodePositions, type MapNodePositions } from './utils'
import type { BotFlow, BotFlowScreen } from './types'

import { MAP_INFO_NODE_TYPE } from './components/MapInfoNode'

import { NodeRail } from '@/features/bot-map/components/NodeRail'
import { NotificationEditor } from '@/features/bot-map/components/inspector/NotificationEditor'
import { MiniAppTerminalView } from '@/features/bot-map/components/inspector/MiniAppTerminalView'
import { BOT_MAP_QUERY_KEY, fetchBotMap } from '@/features/bot-map/bot-map-api'
import type { BotMapNode } from '@/features/bot-map/types'

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
  const [railQuery, setRailQuery] = useState('')
  // Nonce-tagged focus target — set when the operator picks a node from the
  // left rail, so the canvas re-centers (even on the same node twice).
  const [focusNode, setFocusNode] = useState<{ id: string; nonce: number } | null>(null)

  // Sheet drawers for global resources
  const [textsOpen, setTextsOpen] = useState(false)
  const [bannerOpen, setBannerOpen] = useState(false)

  // Right inspector collapse — the operator can hide the screen/notification
  // editor (like the left rail) to get the full canvas width while arranging
  // blocks. Selecting a node re-opens it.
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false)

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

  // Unified node list for the left rail — graph screens, main menu,
  // notifications, and Mini App pages. Driven by the same composer the
  // "Список" tab uses so every reachable surface is selectable here.
  const { data: botMap } = useQuery({
    queryKey: BOT_MAP_QUERY_KEY,
    queryFn: fetchBotMap,
  })
  const botMapNodes = useMemo<ReadonlyArray<BotMapNode>>(
    () => botMap?.nodes ?? [],
    [botMap],
  )

  // Project the non-graph bot-map nodes (notifications + Mini App terminals)
  // onto the canvas so a selected event screen is visible and its links to
  // graph screens are drawn. Manual positions saved by the operator live in
  // `flow.layoutData.mapNodePositions` (these nodes have no DB row of their
  // own) and take precedence over the auto two-column fallback. Memoised so
  // the node-sync effect only re-runs when the payload actually changes.
  const savedMapPositions = useMemo<MapNodePositions>(
    () => readMapNodePositions(flow?.layoutData ?? null),
    [flow?.layoutData],
  )
  const mapNodes = useMemo<Node[]>(
    () => botMapNodesToReactFlow(botMapNodes, savedMapPositions),
    [botMapNodes, savedMapPositions],
  )

  // Load the operator-uploaded welcome banner so we can render it as
  // a thumbnail on the pinned reply-keyboard pseudo-node. The same
  // query is used by the BotBannerTab drawer; TanStack Query
  // deduplicates them under the shared key.
  const { data: botTexts } = useQuery({
    queryKey: ['bot-texts'] as const,
    queryFn: async (): Promise<readonly { key: string; value: string }[]> => {
      const { data } = await api.get<readonly { key: string; value: string }[]>(
        '/admin/bot-config/texts',
      )
      return data
    },
  })
  const bannerUrl = useMemo<string | null>(() => {
    const row = botTexts?.find((r) => r.key === 'bot.banner_url')
    const value = row?.value.trim() ?? ''
    return value.length > 0 ? value : null
  }, [botTexts])

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
      data: {
        buttons: replyButtons,
        bannerUrl,
      } satisfies ReplyKeyboardNodeData,
    } satisfies Node
  }, [replyButtons, bannerUrl])

  // Sync React Flow state — preserve local positions so an in-flight drag
  // is not undone when the server returns the same positionX/Y. Reuses the
  // merge logic from Wave 3 of the bot-flow refactor.
    /* eslint-disable react-hooks/set-state-in-effect */
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

      // Append the read-only map nodes (notifications + Mini App terminals),
      // preserving any local drag position from the previous render.
      for (const mn of mapNodes) {
        const existing = previousById.get(mn.id)
        merged.push(existing ? { ...existing, data: mn.data } : mn)
      }
      return merged
    })

    const validNodeIds = new Set<string>([
      ...incoming.map((n) => n.id),
      ...(replyNode ? [REPLY_KEYBOARD_NODE_ID] : []),
      ...mapNodes.map((n) => n.id),
    ])
    const mapNodeIds = new Set<string>(mapNodes.map((n) => n.id))
    setEdges([
      ...incomingEdges,
      ...buildReplyToScreenEdges(flow, replyButtons),
      ...buildMapEdges(botMap?.edges ?? [], mapNodeIds, validNodeIds),
      ...buildSystemScreenBackEdges(flow, t('botFlow.systemBackEdge')),
    ])
    // We deliberately exclude `replyNode` identity from this deps list:
    // the merge above always picks the latest reference via the closure,
    // and recomputing the entire flow because the buttons list got a new
    // reference would yank the user's selection mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectedGraph, replyButtons, mapNodes, botMap?.edges])
    /* eslint-enable react-hooks/set-state-in-effect */

  // Separate effect to refresh just the reply-node data on bot-button
    // mutations without reprojecting the whole flow.
  /* eslint-disable react-hooks/set-state-in-effect */
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
  /* eslint-enable react-hooks/set-state-in-effect */

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

  // Read-only map nodes (notifications / Mini App terminals) have no DB row,
  // so their manual positions are persisted into the flow's `layoutData` JSON
  // (merged, never clobbering other layout keys) and re-applied on next load.
  const saveLayoutMutation = useMutation({
    mutationFn: async (mapNodePositions: MapNodePositions) => {
      if (!flow) return
      const base =
        flow.layoutData !== null && typeof flow.layoutData === 'object'
          ? (flow.layoutData as Record<string, unknown>)
          : {}
      await api.put(`/admin/bot-flows/${flow.id}/layout`, {
        layoutData: { ...base, mapNodePositions },
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bot-flow', 'draft', FLOW_NAME] })
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

  const fetchBlocksMutation = useMutation({
    mutationFn: async (): Promise<{ added: number }> => {
      const { data } = await api.post<{ added: number }>(
        `/admin/bot-flows/${flow?.id}/standard-blocks`,
      )
      return data
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['bot-flow'] })
      if (data.added > 0) {
        toast.success(t('botStudio.toolbar.fetchBlocksAdded', { count: data.added }))
      } else {
        toast.success(t('botStudio.toolbar.fetchBlocksNone'))
      }
    },
    onError: () => {
      toast.error(t('botStudio.toolbar.fetchBlocksError'))
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

      // Read-only map nodes (notifications / Mini App terminals) can't
      // originate editable flow edges — drop the optimistic edge and bail.
      if (!flow.screens.some((s) => s.id === connection.source)) {
        toast.error(t('botFlow.mapNode.cannotConnectInfo'))
        setEdges((eds) =>
          eds.filter(
            (e) => e.source !== connection.source || e.target !== connection.target,
          ),
        )
        return
      }

      const targetScreen = flow.screens.find((s) => s.id === connection.target)
      if (!targetScreen) {
        // Drop landed on something that isn't an editable screen — discard the
        // optimistic edge so no phantom link lingers on the canvas.
        setEdges((eds) =>
          eds.filter(
            (e) => e.source !== connection.source || e.target !== connection.target,
          ),
        )
        return
      }

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
    setInspectorCollapsed(false)
  }, [])

  // Rail selection: drive the same selection model + sync canvas highlight
  // for nodes that exist on the canvas (graph screens / reply pseudo-node).
  const handleSelectNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId)
    setInspectorCollapsed(false)
    setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === nodeId })))
    // Re-center the canvas on the picked node so a selected notification /
    // Mini App screen (which lives off to the side) comes into view.
    setFocusNode({ id: nodeId, nonce: Date.now() })
  }, [])

  const handleEdgeClick = useCallback(
    (edgeId: string) => {
      // Only NAVIGATE-button edges are editable. Reply-keyboard, system
      // back, and bot-map edges are virtual (deletable:false) — ignore clicks
      // on them so a stray click can't blank a virtual link or PUT to a
      // non-existent button id.
      if (!edgeId.startsWith('edge-')) return
      const buttonId = edgeId.replace('edge-', '')
      if (!buttonId) return

      // Capture the current target before removing it so the deletion can be
      // undone — the operator clicks an arrow to delete it, and a mis-click
      // should be recoverable without redrawing by hand.
      const deletedEdge = edges.find((e) => e.id === edgeId)
      const restoreShortId =
        flow?.screens.find((s) => s.id === deletedEdge?.target)?.shortId ?? null

      setEdges((eds) => eds.filter((e) => e.id !== edgeId))
      api
        .put(`/admin/bot-flows/buttons/${buttonId}`, { targetScreenId: null })
        .then(() => {
          queryClient.invalidateQueries({ queryKey: ['bot-flow', 'draft', FLOW_NAME] })
          if (restoreShortId) {
            toast.success(t('botFlow.edgeDeleted'), {
              action: {
                label: t('botFlow.undo'),
                onClick: () => {
                  api
                    .put(`/admin/bot-flows/buttons/${buttonId}`, {
                      actionType: 'NAVIGATE',
                      targetScreenId: restoreShortId,
                    })
                    .then(() => {
                      queryClient.invalidateQueries({
                        queryKey: ['bot-flow', 'draft', FLOW_NAME],
                      })
                      toast.success(t('botFlow.edgeRestored'))
                    })
                    .catch(() => toast.error(t('botFlow.connectionError')))
                },
              },
            })
          } else {
            toast.success(t('botFlow.edgeDeleted'))
          }
        })
        .catch(() => {
          toast.error(t('botFlow.connectionError'))
          queryClient.invalidateQueries({ queryKey: ['bot-flow', 'draft', FLOW_NAME] })
        })
    },
    [t, queryClient, edges, flow],
  )

  const handleDrop = useCallback(
    (position: { x: number; y: number }) => {
      if (!flow) return
      createScreenMutation.mutate(position)
    },
    [flow, createScreenMutation],
  )

  const handleCreateScreenFromPalette = useCallback(() => {
    if (!flow) return
    const nextIndex = flow.screens.length
    createScreenMutation.mutate({ x: 120 + nextIndex * 32, y: 120 + nextIndex * 32 })
  }, [flow, createScreenMutation])

  const handleSave = useCallback(() => {
    if (!flow) return
    // Graph screens persist to their own DB rows; the read-only map nodes
    // (notifications / Mini App terminals) persist into the flow layout JSON.
    // Both are saved together so a single "Save positions" keeps the entire
    // arranged canvas — not just the screen blocks.
    const positions = nodesToPositions(nodes.filter((n) => n.type === 'botScreen'))
    const mapPositions: MapNodePositions = {}
    for (const n of nodes) {
      if (n.type === MAP_INFO_NODE_TYPE) {
        mapPositions[n.id] = { x: n.position.x, y: n.position.y }
      }
    }
    const hasMapPositions = Object.keys(mapPositions).length > 0
    Promise.all([
      positions.length > 0 ? savePositionsMutation.mutateAsync(positions) : Promise.resolve(),
      hasMapPositions ? saveLayoutMutation.mutateAsync(mapPositions) : Promise.resolve(),
    ])
      .then(() => toast.success(t('botFlow.saved')))
      .catch(() => toast.error(t('botFlow.connectionError')))
  }, [flow, nodes, savePositionsMutation, saveLayoutMutation, t])

  // ── Right inspector router ─────────────────────────────────────────────────
  const selectedScreen = useMemo<BotFlowScreen | null>(() => {
    if (!flow || !selectedNodeId || selectedNodeId === REPLY_KEYBOARD_NODE_ID) return null
    return flow.screens.find((s) => s.id === selectedNodeId) ?? null
  }, [flow, selectedNodeId])

  const showReplyInspector = selectedNodeId === REPLY_KEYBOARD_NODE_ID

  // Notification / Mini App nodes aren't on the bot-flow canvas — they live
  // only in the unified bot-map list. When one is selected, open its bot-map
  // inspector in the right pane instead of the screen editor.
  const selectedMapNode = useMemo<BotMapNode | null>(() => {
    if (selectedNodeId === null) return null
    return botMapNodes.find((n) => n.id === selectedNodeId) ?? null
  }, [botMapNodes, selectedNodeId])
  const showNotificationInspector =
    !showReplyInspector && selectedMapNode?.kind === 'notification'
  const showTerminalInspector =
    !showReplyInspector && selectedMapNode?.kind === 'mini-app-terminal'

  // Whether the right inspector has any panel to show for the current
  // selection — drives the collapse strip vs full-panel rendering.
  const anyInspectorActive =
    showReplyInspector ||
    (selectedScreen !== null && !showReplyInspector) ||
    showNotificationInspector ||
    showTerminalInspector

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
            onClick={() => fetchBlocksMutation.mutate()}
            disabled={fetchBlocksMutation.isPending || !flow}
            title={t('botStudio.toolbar.fetchBlocksHint')}
            aria-label={t('botStudio.toolbar.fetchBlocksAria')}
          >
            <RefreshCw
              className={`mr-1.5 h-3.5 w-3.5 ${
                fetchBlocksMutation.isPending ? 'animate-spin' : ''
              }`}
              aria-hidden
            />
            {t('botStudio.toolbar.fetchBlocks')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setTextsOpen(true)}>
            <Type className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {t('botStudio.toolbar.texts')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setBannerOpen(true)}>
            <ImageIcon className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {t('botStudio.toolbar.banner')}
          </Button>
          {hasScreens && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleSave}
                disabled={savePositionsMutation.isPending || saveLayoutMutation.isPending}
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
        {/* Left palette + unified node list */}
        <div className="flex w-60 shrink-0 flex-col overflow-hidden border-r">
          <div className="shrink-0 border-b px-2 pb-1.5 pt-2">
            <button
              type="button"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/bot-flow-node', 'botScreen')
                e.dataTransfer.effectAllowed = 'move'
              }}
              onClick={handleCreateScreenFromPalette}
              disabled={!flow || createScreenMutation.isPending}
              aria-label={t('botFlow.newScreenAria')}
              title={t('botFlow.newScreenHint')}
              className="flex w-full cursor-grab items-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-left transition-colors hover:border-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-3 w-3 text-muted-foreground" aria-hidden />
              <span className="text-[11px] font-medium">{t('botFlow.newScreen')}</span>
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <NodeRail
              nodes={botMapNodes}
              selectedId={selectedNodeId}
              onSelect={handleSelectNode}
              query={railQuery}
              onQueryChange={setRailQuery}
            />
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
              focusNode={focusNode}
            />
          </ReactFlowProvider>
        </div>

        {/* Right inspector — collapsible like the left rail. When collapsed,
            a thin strip with an expand button stays so the operator can bring
            the editor back without re-selecting the node. */}
        {anyInspectorActive && inspectorCollapsed && (
          <div className="flex w-9 shrink-0 flex-col items-center border-l pt-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setInspectorCollapsed(false)}
              aria-label={t('botStudio.inspector.expand')}
              title={t('botStudio.inspector.expand')}
            >
              <PanelRightOpen className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        )}
        {showReplyInspector && !inspectorCollapsed && (
          <InspectorShell
            width="w-80"
            collapseLabel={t('botStudio.inspector.collapse')}
            onCollapse={() => setInspectorCollapsed(true)}
          >
            <div className="p-3">
              <ReplyKeyboardEditorPanel />
            </div>
          </InspectorShell>
        )}
        {selectedScreen && !showReplyInspector && !inspectorCollapsed && (
          <InspectorShell
            width="w-80"
            collapseLabel={t('botStudio.inspector.collapse')}
            onCollapse={() => setInspectorCollapsed(true)}
          >
            <div className="p-3">
              <ScreenEditorPanel screen={selectedScreen} flowName={FLOW_NAME} />
            </div>
          </InspectorShell>
        )}
        {showNotificationInspector && selectedMapNode?.kind === 'notification' && !inspectorCollapsed && (
          <InspectorShell
            width="w-96"
            collapseLabel={t('botStudio.inspector.collapse')}
            onCollapse={() => setInspectorCollapsed(true)}
          >
            <div className="p-4">
              <NotificationEditor node={selectedMapNode} />
            </div>
          </InspectorShell>
        )}
        {showTerminalInspector && selectedMapNode?.kind === 'mini-app-terminal' && !inspectorCollapsed && (
          <InspectorShell
            width="w-96"
            collapseLabel={t('botStudio.inspector.collapse')}
            onCollapse={() => setInspectorCollapsed(true)}
          >
            <div className="p-4">
              <MiniAppTerminalView node={selectedMapNode} />
            </div>
          </InspectorShell>
        )}
      </div>

      {/* Sheet drawers — global texts & banner */}
      <Sheet open={textsOpen} onOpenChange={setTextsOpen}>
        <SheetContent side="right" className="w-full max-w-5xl overflow-y-auto sm:max-w-5xl">
          <SheetHeader>
            <SheetTitle>{t('botStudio.toolbar.texts')}</SheetTitle>
            <SheetDescription>{t('botStudio.drawers.textsDescription')}</SheetDescription>
          </SheetHeader>
          <div className="mt-4">
            <BotTextsTab />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={bannerOpen} onOpenChange={setBannerOpen}>
        <SheetContent side="right" className="w-full max-w-xl overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{t('botStudio.toolbar.banner')}</SheetTitle>
            <SheetDescription>{t('botStudio.drawers.bannerDescription')}</SheetDescription>
          </SheetHeader>
          <div className="mt-4">
            <BotBannerTab />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}

/**
 * Right-inspector container with a collapse affordance. Keeps the per-panel
 * width and scroll behaviour, adds a sticky header carrying the collapse
 * button so the operator can hide the editor (like the left rail) and reclaim
 * canvas width while arranging blocks.
 */
function InspectorShell({
  width,
  collapseLabel,
  onCollapse,
  children,
}: {
  width: string
  collapseLabel: string
  onCollapse: () => void
  children: ReactNode
}) {
  return (
    <div className={cn('flex shrink-0 flex-col overflow-hidden border-l', width)}>
      <div className="flex shrink-0 justify-end border-b px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onCollapse}
          aria-label={collapseLabel}
          title={collapseLabel}
        >
          <PanelRightClose className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">{children}</div>
    </div>
  )
}
