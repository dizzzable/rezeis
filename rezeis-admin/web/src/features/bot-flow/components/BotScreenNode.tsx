import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useTranslation } from 'react-i18next'
import { MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { BotScreenNodeData, BotFlowButton } from '../types'
import { useEmojiRegistry } from '../../custom-emoji/use-emoji-registry'

function BotScreenNodeComponent({ data, id, selected }: NodeProps) {
  const nodeData = data as unknown as BotScreenNodeData
  const { t } = useTranslation()
  // Resolve a button's stored custom_emoji_id back to its registry preview.
  const { byCustomEmojiId } = useEmojiRegistry()

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

      {/*
        Generic source handle. Drag from here to create a NAVIGATE link to
        another screen — `onConnect` provisions the underlying button when the
        drag lands on a target screen's handle. A brand-new screen has no
        per-button handles yet, so without a connectable anchor there was no
        way to originate a link from it (the reported "can't draw a connection
        from a new block" bug). It also remains the origin for the programmatic
        system "back to menu" edges.
      */}
      <Handle
        type="source"
        position={Position.Right}
        id={`${id}-source`}
        title={t('botFlow.connectHandle', { defaultValue: 'Drag to create a link to another screen' })}
        className="!w-3.5 !h-3.5 !bg-emerald-500 !border-2 !border-background"
        style={{ right: -7 }}
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

      {/* Banner preview */}
      {nodeData.mediaUrl && (
        <div className="px-3 pb-2">
          <div className="h-16 rounded-md bg-muted/50 overflow-hidden">
            {nodeData.mediaType === 'VIDEO' ? (
              <video src={nodeData.mediaUrl} className="h-full w-full object-cover" muted playsInline />
            ) : (
              <img src={nodeData.mediaUrl} alt="" className="h-full w-full object-cover" />
            )}
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
                        src={
                          byCustomEmojiId.get(btn.iconCustomEmojiId)?.imageUrl ??
                          `/uploads/emoji/${btn.iconCustomEmojiId}.webp`
                        }
                        alt=""
                        className="inline-block h-3 w-3 mr-0.5 align-middle"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                      />
                    )}
                    {btn.labelRu || btn.labelEn}
                  </div>
                  {/* Source handle per navigable / back button so its edge
                      originates from the button chip. NAVIGATE → another
                      screen (blue); BACK / START_OVER → root menu (slate). */}
                  {(btn.actionType === 'NAVIGATE' ||
                    btn.actionType === 'BACK' ||
                    btn.actionType === 'START_OVER') && (
                    <Handle
                      type="source"
                      position={Position.Bottom}
                      id={`btn-${btn.id}`}
                      className={cn(
                        '!w-2.5 !h-2.5 !border-2 !border-background !-bottom-1.5',
                        btn.actionType === 'NAVIGATE' ? '!bg-blue-500' : '!bg-slate-400',
                      )}
                      style={{ left: '50%', transform: 'translateX(-50%)' }}
                    />
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Runtime-injected system buttons (read-only preview): the per-screen
          built-in buttons of invite/rules/help and the auto "◀️ В меню" row.
          Muted dashed chips so the operator sees the full keyboard; the back
          chip anchors the dashed edge to the root screen. */}
      {nodeData.systemButtons && nodeData.systemButtons.length > 0 && (
        <div className="px-2 pb-2 pt-1.5 space-y-1 border-t border-dashed border-border/60">
          <p className="px-1 text-[8px] font-medium uppercase tracking-wider text-muted-foreground/60">
            {t('botFlow.systemButtonsCanvasLabel')}
          </p>
          {nodeData.systemButtons.map((sb) => (
            <div key={sb.key} className="relative">
              <div className="truncate rounded-md border border-dashed border-border/70 bg-muted/30 px-2 py-1 text-center text-[10px] font-medium text-muted-foreground">
                {t(sb.labelKey)}
              </div>
              {sb.isBack && (
                <Handle
                  type="source"
                  position={Position.Bottom}
                  id={`${id}-sysback`}
                  className="!w-2.5 !h-2.5 !bg-slate-400 !border-2 !border-background !-bottom-1.5"
                  style={{ left: '50%', transform: 'translateX(-50%)' }}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export const BotScreenNode = memo(BotScreenNodeComponent)
