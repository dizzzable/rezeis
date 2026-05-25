import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { BotScreenNodeData, BotFlowButton } from '../types'

function BotScreenNodeComponent({ data, id, selected }: NodeProps) {
  const nodeData = data as unknown as BotScreenNodeData

  const STYLE_COLORS: Record<string, { bg: string; text: string }> = {
    PRIMARY: { bg: '#3b82f6', text: '#ffffff' },
    SUCCESS: { bg: '#10b981', text: '#ffffff' },
    DANGER: { bg: '#ef4444', text: '#ffffff' },
    DEFAULT: { bg: 'var(--color-muted)', text: 'var(--color-foreground)' },
  }

  return (
    <div
      className={cn(
        'w-[280px] rounded-xl border bg-card shadow-md transition-shadow',
        selected && 'ring-2 ring-primary shadow-lg',
        nodeData.isRoot && 'border-emerald-500',
      )}
    >
      {/* Target handle — incoming connections */}
      <Handle
        type="target"
        position={Position.Top}
        id={`${id}-target`}
        className="!w-3 !h-3 !bg-primary !border-2 !border-background"
      />

      {/* Header */}
      <div className={cn(
        'flex items-center gap-2 px-3 py-2 rounded-t-xl border-b text-xs font-medium',
        nodeData.isRoot ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-muted/50 text-muted-foreground',
      )}>
        <MessageSquare className="h-3 w-3" />
        <span className="truncate">{nodeData.name}</span>
        {nodeData.isRoot && (
          <span className="ml-auto text-[10px] font-semibold uppercase tracking-wider opacity-70">Start</span>
        )}
      </div>

      {/* Message preview */}
      <div className="px-3 py-2 text-xs text-foreground/80 line-clamp-3 min-h-[2rem]">
        {nodeData.textRu || nodeData.textEn || <span className="italic text-muted-foreground">Empty message</span>}
      </div>

      {/* Media preview */}
      {nodeData.mediaUrl && (
        <div className="px-3 pb-2">
          <div className="h-16 rounded-md bg-muted/50 overflow-hidden">
            <img src={nodeData.mediaUrl} alt="" className="h-full w-full object-cover" />
          </div>
        </div>
      )}

      {/* Inline keyboard buttons */}
      {nodeData.buttons.length > 0 && (
        <div className="px-2 pb-2 space-y-1">
          {nodeData.buttons.map((row, rowIdx) => (
            <div key={rowIdx} className="flex gap-1">
              {row.map((btn: BotFlowButton) => (
                <div key={btn.id} className="relative flex-1 min-w-0">
                  <div
                    className="rounded-md px-2 py-1 text-[10px] font-medium text-center truncate"
                    style={{
                      backgroundColor: (STYLE_COLORS[btn.style] ?? STYLE_COLORS.DEFAULT).bg,
                      color: (STYLE_COLORS[btn.style] ?? STYLE_COLORS.DEFAULT).text,
                    }}
                  >
                    {btn.iconCustomEmojiId && (
                      <img
                        src={`/uploads/emoji/${btn.iconCustomEmojiId}.webp`}
                        alt=""
                        className="inline-block h-3 w-3 mr-0.5 align-middle"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                      />
                    )}
                    {btn.labelRu || btn.labelEn}
                  </div>
                  {/* Source handle per navigable button */}
                  {btn.actionType === 'NAVIGATE' && (
                    <Handle
                      type="source"
                      position={Position.Bottom}
                      id={`btn-${btn.id}`}
                      className="!w-2.5 !h-2.5 !bg-blue-500 !border-2 !border-background !-bottom-1.5"
                      style={{ left: '50%', transform: 'translateX(-50%)' }}
                    />
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export const BotScreenNode = memo(BotScreenNodeComponent)
