/**
 * ListView — default representation of the "Карта бота".
 *
 * Renders every node from the rail as a clickable card showing its
 * title, status, and outgoing edges (text + destination badge). The
 * canvas tab in Wave 3 uses the same data; this is a strict superset
 * of "what the operator needs to know", just laid out vertically.
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

import type { BotMapEdge, BotMapNode, BotMapPayload } from '../types'
import { groupNodes } from '../utils/group-nodes'
import { DestinationBadge } from './DestinationBadge'

interface ListViewProps {
  readonly payload: BotMapPayload
  readonly visibleNodes: ReadonlyArray<BotMapNode>
  readonly selectedId: string | null
  readonly onSelect: (nodeId: string) => void
}

export function ListView({ payload, visibleNodes, selectedId, onSelect }: ListViewProps) {
  const { t } = useTranslation()
  const groups = useMemo(() => groupNodes(visibleNodes), [visibleNodes])
  const edgesBySource = useMemo(() => indexEdgesBySource(payload.edges), [payload.edges])
  const nodesById = useMemo(() => indexNodesById(payload.nodes), [payload.nodes])

  return (
    <ScrollArea className="h-full">
      <div className="space-y-6 p-3">
        {groups.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t('botMapPage.rail.empty')}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.key} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {/* `nsSeparator: false` — see NodeRail: a ':' in the group
                    key is not a namespace. */}
                {t(`botMapPage.rail.groups.${group.key}` as never, {
                  defaultValue: group.key,
                  nsSeparator: false,
                })}
              </h3>
              <ul className="space-y-2">
                {group.nodes.map((node) => (
                  <li key={node.id}>
                    <NodeCard
                      node={node}
                      edges={edgesBySource.get(node.id) ?? []}
                      nodesById={nodesById}
                      selected={node.id === selectedId}
                      onSelect={onSelect}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </ScrollArea>
  )
}

interface NodeCardProps {
  readonly node: BotMapNode
  readonly edges: ReadonlyArray<BotMapEdge>
  readonly nodesById: ReadonlyMap<string, BotMapNode>
  readonly selected: boolean
  readonly onSelect: (nodeId: string) => void
}

function NodeCard({ node, edges, nodesById, selected, onSelect }: NodeCardProps) {
  const { t } = useTranslation()

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={() => onSelect(node.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(node.id)
        }
      }}
      className={cn(
        'cursor-pointer transition-shadow hover:shadow-md',
        selected && 'ring-2 ring-primary',
      )}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-medium">{node.title}</CardTitle>
          <NodeStatusPill node={node} />
        </div>
      </CardHeader>
      <CardContent className="space-y-2 pb-3 text-xs">
        <NodeSubtitle node={node} />
        {edges.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            {isSystemGraphScreen(node)
              ? t('botMapPage.badges.systemButtons')
              : t('botMapPage.badges.noButtons')}
          </p>
        ) : (
          <ul className="space-y-1">
            {edges.map((edge) => (
              <li key={edge.id} className="flex flex-wrap items-center gap-1.5">
                {edge.sourceLabel.length > 0 && (
                  <span className="font-medium">{edge.sourceLabel}</span>
                )}
                <DestinationBadge edge={edge} nodesById={nodesById} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function NodeSubtitle({ node }: { node: BotMapNode }) {
  const { t } = useTranslation()
  switch (node.kind) {
    case 'graph-screen':
      return (
        <p className="font-mono text-[10px] text-muted-foreground">
          {node.shortId}
        </p>
      )
    case 'notification':
      return (
        <p className="font-mono text-[10px] text-muted-foreground">
          {node.type}
        </p>
      )
    case 'mini-app-terminal':
      return (
        <p className="font-mono text-[10px] text-muted-foreground">
          {node.route}
        </p>
      )
    case 'reply-keyboard':
      return (
        <p className="text-[11px] text-muted-foreground">
          {t('botMapPage.badges.buttons', { count: node.buttons.length })}
        </p>
      )
  }
}

function NodeStatusPill({ node }: { node: BotMapNode }) {
  const { t } = useTranslation()
  if (node.kind === 'graph-screen' && node.isRoot) {
    return (
      <Badge variant="default" className="text-[10px]">
        {t('botMapPage.badges.root')}
      </Badge>
    )
  }
  switch (node.status) {
    case 'PUBLISHED':
      return (
        <Badge variant="secondary" className="text-[10px]">
          {t('botMapPage.badges.published')}
        </Badge>
      )
    case 'DRAFT':
      return (
        <Badge variant="outline" className="text-[10px]">
          {t('botMapPage.badges.draft')}
        </Badge>
      )
    case 'ACTIVE':
      return (
        <Badge variant="default" className="text-[10px]">
          {t('botMapPage.badges.active')}
        </Badge>
      )
    case 'DISABLED':
      return (
        <Badge variant="outline" className="text-[10px]">
          {t('botMapPage.badges.disabled')}
        </Badge>
      )
    default:
      return null
  }
}

/**
 * Built-in screens (help / invite / rules) whose buttons the bot appends at
 * runtime (not editable graph buttons). The bot-map graph node carries 0
 * outgoing edges for them, so the list would otherwise read "No buttons" —
 * misleading, since the bot DOES render system buttons there. Matches reiwa's
 * `findScreenByName` override sentinels (case-insensitive screen name).
 */
const SYSTEM_SCREEN_NAMES: ReadonlySet<string> = new Set(['help', 'invite', 'rules'])

function isSystemGraphScreen(node: BotMapNode): boolean {
  return (
    node.kind === 'graph-screen' &&
    SYSTEM_SCREEN_NAMES.has(node.title.trim().toLowerCase())
  )
}

function indexEdgesBySource(
  edges: ReadonlyArray<BotMapEdge>,
): ReadonlyMap<string, ReadonlyArray<BotMapEdge>> {
  const map = new Map<string, BotMapEdge[]>()
  for (const edge of edges) {
    const list = map.get(edge.source) ?? []
    list.push(edge)
    map.set(edge.source, list)
  }
  return map
}

function indexNodesById(
  nodes: ReadonlyArray<BotMapNode>,
): ReadonlyMap<string, BotMapNode> {
  const map = new Map<string, BotMapNode>()
  for (const node of nodes) map.set(node.id, node)
  return map
}
