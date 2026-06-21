/**
 * React Flow node components for the bot-map "Схема" tab.
 *
 * One component per `NodeKind`, all sharing a compact card look that
 * mirrors the list view. Each carries a target handle (top) and a
 * source handle (bottom) so the destination edges attach cleanly.
 * Mini App terminals only need a target handle (paths end there).
 */
import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Bell, Globe, LayoutGrid, MessageSquare } from 'lucide-react'

import { cn } from '@/lib/utils'

import type {
  GraphScreenMapNode,
  MiniAppTerminalMapNode,
  NotificationMapNode,
  ReplyKeyboardMapNode,
} from '../../types'

const CARD = 'w-[230px] rounded-xl border bg-card shadow-md transition-shadow'
const HEADER = 'flex items-center gap-2 rounded-t-xl border-b px-3 py-2 text-xs font-medium'
const targetHandle = '!h-2.5 !w-2.5 !border-2 !border-background !bg-primary'
const sourceHandle = '!h-2.5 !w-2.5 !border-2 !border-background !bg-blue-500'

function GraphScreenNodeComponent({ data, selected }: NodeProps) {
  const node = data as unknown as GraphScreenMapNode
  return (
    <div className={cn(CARD, selected && 'ring-2 ring-primary', node.isRoot && 'border-emerald-500')}>
      <Handle type="target" position={Position.Top} className={targetHandle} />
      <div
        className={cn(
          HEADER,
          node.isRoot
            ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
            : 'bg-muted/50 text-muted-foreground',
        )}
      >
        <MessageSquare className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate">{node.title}</span>
        {node.isRoot && (
          <span className="ml-auto text-[9px] font-semibold uppercase tracking-wider opacity-70">
            Start
          </span>
        )}
      </div>
      <div className="line-clamp-2 px-3 py-2 text-[11px] text-foreground/70">
        {node.textRu || node.textEn || '—'}
      </div>
      <Handle type="source" position={Position.Bottom} className={sourceHandle} />
    </div>
  )
}

function ReplyKeyboardNodeComponent({ data, selected }: NodeProps) {
  const node = data as unknown as ReplyKeyboardMapNode
  return (
    <div className={cn(CARD, 'border-dashed border-amber-500/60', selected && 'ring-2 ring-primary')}>
      <div className={cn(HEADER, 'bg-amber-500/10 text-amber-700 dark:text-amber-400')}>
        <LayoutGrid className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate">{node.title}</span>
      </div>
      <div className="px-3 py-2 text-[11px] text-foreground/70">
        {node.buttons.length === 0
          ? '—'
          : node.buttons
              .filter((b) => b.visible)
              .map((b) => b.label)
              .join(' · ')}
      </div>
      <Handle type="source" position={Position.Bottom} className={sourceHandle} />
    </div>
  )
}

function NotificationNodeComponent({ data, selected }: NodeProps) {
  const node = data as unknown as NotificationMapNode
  return (
    <div
      className={cn(
        CARD,
        selected && 'ring-2 ring-primary',
        !node.isActive && 'opacity-60',
      )}
    >
      <div className={cn(HEADER, 'bg-violet-500/10 text-violet-700 dark:text-violet-400')}>
        <Bell className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate">{node.title}</span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate font-mono text-[10px] text-muted-foreground">{node.type}</p>
      </div>
      <Handle type="source" position={Position.Bottom} className={sourceHandle} />
    </div>
  )
}

function MiniAppTerminalNodeComponent({ data, selected }: NodeProps) {
  const node = data as unknown as MiniAppTerminalMapNode
  return (
    <div
      className={cn(
        'w-[180px] rounded-xl border border-sky-500/50 bg-sky-500/5 shadow-sm',
        selected && 'ring-2 ring-primary',
      )}
    >
      <Handle type="target" position={Position.Top} className={targetHandle} />
      <div className={cn(HEADER, 'bg-sky-500/10 text-sky-700 dark:text-sky-400')}>
        <Globe className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate">Mini App</span>
      </div>
      <div className="px-3 py-2">
        <p className="truncate font-mono text-[11px]">{node.route}</p>
      </div>
    </div>
  )
}

export const GraphScreenNode = memo(GraphScreenNodeComponent)
export const ReplyKeyboardNode = memo(ReplyKeyboardNodeComponent)
export const NotificationNode = memo(NotificationNodeComponent)
export const MiniAppTerminalNode = memo(MiniAppTerminalNodeComponent)

export const BOT_MAP_NODE_TYPES = {
  'graph-screen': GraphScreenNode,
  'reply-keyboard': ReplyKeyboardNode,
  notification: NotificationNode,
  'mini-app-terminal': MiniAppTerminalNode,
} as const
