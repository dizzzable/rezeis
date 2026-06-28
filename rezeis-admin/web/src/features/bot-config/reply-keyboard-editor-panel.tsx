/**
 * ReplyKeyboardEditorPanel — right-side inspector for the pinned reply-
 * keyboard pseudo-node on the Bot Studio canvas.
 *
 * Mirrors the existing ScreenEditorPanel's contract: the panel is rendered
 * inside the canvas page when the corresponding node is selected, and it
 * owns its own data fetches + mutations against the bot-config endpoints.
 *
 * The DnD pattern follows the well-trodden codebase recipe in
 * features/remnawave/infra/infra-hosts-section.tsx:
 *   - Local optimistic copy resyncs whenever upstream refetches.
 *   - DragEnd computes the new order and fires the reorder mutation
 *     immediately; failure paths trigger a refetch which restores the
 *     authoritative server state via the resync effect.
 *
 * Following the official TanStack Query v5 optimistic-update guide the
 * visibility toggle uses cancel → snapshot → setQueryData → return ctx →
 * onError restores → onSettled invalidates.
 */
import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Eye, EyeOff, GripVertical, Plus, Save as SaveIcon, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { EmojiPicker } from '@/features/broadcast/emoji-picker'
import { insertAtCaret } from '@/features/bot-map/utils/insert-at-caret'
import { BannerField } from '@/features/bot-map/components/BannerField'

import {
  BOT_CONFIG_KEYS,
  type BotButton,
  type BotButtonAction,
  type BotButtonStyle,
  botConfigApi,
} from './bot-config-api'
import {
  ActionFields,
  buildActionPayload,
  BotButtonCreateDialog,
} from './bot-button-dialogs'

const REPLY_BUTTON_STYLES: BotButtonStyle[] = ['DEFAULT', 'PRIMARY', 'SUCCESS', 'DANGER']

/**
 * Shared cache key with `BotBannerTab` and the canvas reply pseudo-node
 * thumbnail in `bot-flow-page` — writing through it keeps all three in
 * sync. The global banner lives in `bot.banner_url` (already rendered by
 * reiwa's welcome screen); the "one banner for all" flag persists in
 * `bot.banner_apply_all` with `visible:false` so it stays out of reiwa's
 * `translations` payload and never trips the byte-parity contract guard.
 */
const BOT_TEXTS_QUERY_KEY = ['bot-texts'] as const
const BANNER_URL_KEY = 'bot.banner_url'
const BANNER_APPLY_ALL_KEY = 'bot.banner_apply_all'

interface BotTextRow {
  readonly id: string
  readonly key: string
  readonly value: string
  readonly visible: boolean
}

export function ReplyKeyboardEditorPanel(): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const { data: buttons, isLoading } = useQuery({
    queryKey: BOT_CONFIG_KEYS.buttons,
    queryFn: botConfigApi.listButtons,
  })

  // ── Global bot banner (main-menu inspector) ──────────────────────────────
  // The operator anchors the whole bot here, so the "one banner for all"
  // controls live on the main menu. The URL persists in the existing
  // `bot.banner_url` row; the apply-all flag in `bot.banner_apply_all`.
  // Both write through the bot-config texts endpoints, so the cache-bust
  // interceptor pushes them to reiwa with the rest of the config.
  const { data: botTexts } = useQuery({
    queryKey: BOT_TEXTS_QUERY_KEY,
    queryFn: async (): Promise<readonly BotTextRow[]> => {
      const { data } = await api.get<readonly BotTextRow[]>('/admin/bot-config/texts')
      return data
    },
  })
  const bannerRow = botTexts?.find((r) => r.key === BANNER_URL_KEY) ?? null
  const bannerUrl = (bannerRow?.value ?? '').trim()
  const applyAllRow = botTexts?.find((r) => r.key === BANNER_APPLY_ALL_KEY) ?? null
  const applyAll = (applyAllRow?.value ?? '').trim().toLowerCase() === 'true'

  const upsertTextMutation = useMutation({
    mutationFn: async ({
      key,
      value,
      row,
    }: {
      readonly key: string
      readonly value: string
      readonly row: BotTextRow | null
    }) => {
      if (row !== null) {
        // Raw PATCH (not botConfigApi.updateText) so an empty value is
        // accepted as a soft-clear, mirroring BotBannerTab's remove path.
        await api.patch(`/admin/bot-config/texts/${row.id}`, { value })
      } else if (value.length > 0) {
        await api.post('/admin/bot-config/texts', { key, value, visible: false })
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BOT_TEXTS_QUERY_KEY })
      toast.success(t('botStudio.replyKeyboard.bannerSection.saved'))
    },
    onError: () => toast.error(t('botStudio.replyKeyboard.bannerSection.saveFailed')),
  })

  const [order, setOrder] = useState<BotButton[]>([])
    /* eslint-disable react-hooks/set-state-in-effect */
    useEffect(() => {
    if (buttons) {
      setOrder([...buttons].sort((a, b) => a.orderIndex - b.orderIndex))
    }
  }, [buttons])
    /* eslint-enable react-hooks/set-state-in-effect */

  const reorderMutation = useMutation({
    mutationFn: (ids: string[]) => botConfigApi.reorderButtons(ids),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BOT_CONFIG_KEYS.buttons })
      toast.success(t('botConfigPage.buttons.toasts.reordered'))
    },
    onError: () => {
      toast.error(t('botConfigPage.buttons.toasts.reorderFailed'))
      void queryClient.invalidateQueries({ queryKey: BOT_CONFIG_KEYS.buttons })
    },
  })

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event
    if (!over || active.id === over.id) return
    setOrder((prev) => {
      const oldIndex = prev.findIndex((b) => b.id === active.id)
      const newIndex = prev.findIndex((b) => b.id === over.id)
      if (oldIndex === -1 || newIndex === -1) return prev
      const next = arrayMove(prev, oldIndex, newIndex)
      reorderMutation.mutate(next.map((b) => b.id))
      return next
    })
  }

  const toggleVisibilityMutation = useMutation({
    mutationFn: ({ id, visible }: { readonly id: string; readonly visible: boolean }) =>
      botConfigApi.updateButton(id, { visible }),
    onMutate: async ({ id, visible }) => {
      await queryClient.cancelQueries({ queryKey: BOT_CONFIG_KEYS.buttons })
      const previous = queryClient.getQueryData<BotButton[]>(BOT_CONFIG_KEYS.buttons)
      queryClient.setQueryData<BotButton[]>(BOT_CONFIG_KEYS.buttons, (old) =>
        old ? old.map((b) => (b.id === id ? { ...b, visible } : b)) : old,
      )
      return { previous }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(BOT_CONFIG_KEYS.buttons, ctx.previous)
      toast.error(t('botConfigPage.buttons.toasts.updateFailed'))
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: BOT_CONFIG_KEYS.buttons })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => botConfigApi.deleteButton(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BOT_CONFIG_KEYS.buttons })
      toast.success(t('botConfigPage.buttons.toasts.deleted'))
    },
    onError: () => toast.error(t('botConfigPage.buttons.toasts.deleteFailed')),
  })

  const [creating, setCreating] = useState(false)

  if (isLoading) {
    return (
      <div className="space-y-2 p-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold">{t('botStudio.replyKeyboard.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('botStudio.replyKeyboard.subtitle')}</p>
      </div>

      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-[11px] leading-relaxed text-emerald-700 dark:text-emerald-400">
        {t('botStudio.replyKeyboard.autoSaveHint')}
      </div>

      <section className="space-y-3 rounded-md border p-3">
        <div>
          <h4 className="text-sm font-semibold">
            {t('botStudio.replyKeyboard.bannerSection.title')}
          </h4>
          <p className="text-[11px] leading-snug text-muted-foreground">
            {t('botStudio.replyKeyboard.bannerSection.subtitle')}
          </p>
        </div>

        <BannerField
          value={bannerUrl.length > 0 ? bannerUrl : null}
          onChange={(url) =>
            upsertTextMutation.mutate({
              key: BANNER_URL_KEY,
              value: url ?? '',
              row: bannerRow,
            })
          }
          disabled={upsertTextMutation.isPending}
        />

        {bannerUrl.length === 0 ? (
          <div className="space-y-1.5 rounded-md border border-dashed bg-muted/20 p-2">
            <p className="text-[10px] leading-snug text-muted-foreground">
              {t('botStudio.replyKeyboard.bannerSection.defaultInUse')}
            </p>
            <img
              src="/bot-default-banner.jpg"
              alt={t('botStudio.replyKeyboard.bannerAlt')}
              className="h-24 w-full rounded object-cover"
            />
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/20 p-2.5">
          <div className="min-w-0">
            <Label className="text-xs">
              {t('botStudio.replyKeyboard.bannerSection.applyAll')}
            </Label>
            <p className="text-[10px] leading-snug text-muted-foreground">
              {t('botStudio.replyKeyboard.bannerSection.applyAllHint')}
            </p>
          </div>
          <Switch
            checked={applyAll}
            onCheckedChange={(next) =>
              upsertTextMutation.mutate({
                key: BANNER_APPLY_ALL_KEY,
                value: next ? 'true' : 'false',
                row: applyAllRow,
              })
            }
            disabled={upsertTextMutation.isPending}
            aria-label={t('botStudio.replyKeyboard.bannerSection.applyAll')}
          />
        </div>
      </section>

      <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
        <Plus className="mr-1 h-4 w-4" aria-hidden />
        {t('botConfigPage.buttons.create')}
      </Button>

      {order.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
          {t('botConfigPage.buttons.empty')}
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={order.map((b) => b.id)} strategy={verticalListSortingStrategy}>
            <ul className="space-y-2">
              {order.map((button) => (
                <SortableReplyButtonCard
                  key={button.id}
                  button={button}
                  onToggleVisible={(visible) =>
                    toggleVisibilityMutation.mutate({ id: button.id, visible })
                  }
                  onDelete={() => deleteMutation.mutate(button.id)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      <BotButtonCreateDialog open={creating} onOpenChange={setCreating} />
    </div>
  )
}

interface SortableReplyButtonCardProps {
  readonly button: BotButton
  readonly onToggleVisible: (visible: boolean) => void
  readonly onDelete: () => void
}

/**
 * Inline editable card for a single reply-keyboard button — mirrors the
 * notification editor's button row (labelled fields, action type + target,
 * style, "one per row", inline Save/Delete) instead of the old compact row +
 * modal. Reply buttons are single-locale (one `label`), so there's a single
 * "Подпись" field with an emoji picker rather than an RU/EN pair. DnD reorder
 * + the immediate visibility toggle are preserved in the card header.
 */
function SortableReplyButtonCard({
  button,
  onToggleVisible,
  onDelete,
}: SortableReplyButtonCardProps): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: button.id,
  })

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  }

  const [label, setLabel] = useState(button.label)
  const [styleValue, setStyleValue] = useState<BotButtonStyle>(button.style)
  const [iconCustomEmojiId, setIconCustomEmojiId] = useState(button.iconCustomEmojiId ?? '')
  const [onePerRow, setOnePerRow] = useState(button.onePerRow)
  const [actionType, setActionType] = useState<BotButtonAction>(button.actionType)
  const [actionTarget, setActionTarget] = useState(button.actionTarget ?? '')
  const labelRef = useRef<HTMLInputElement | null>(null)

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setLabel(button.label)
    setStyleValue(button.style)
    setIconCustomEmojiId(button.iconCustomEmojiId ?? '')
    setOnePerRow(button.onePerRow)
    setActionType(button.actionType)
    setActionTarget(button.actionTarget ?? '')
  }, [
    button.id,
    button.label,
    button.style,
    button.iconCustomEmojiId,
    button.onePerRow,
    button.actionType,
    button.actionTarget,
  ])
  /* eslint-enable react-hooks/set-state-in-effect */

  const mutation = useMutation({
    mutationFn: () => {
      const action = buildActionPayload(actionType, actionTarget)
      return botConfigApi.updateButton(button.id, {
        label,
        style: styleValue,
        iconCustomEmojiId: iconCustomEmojiId.trim() === '' ? null : iconCustomEmojiId.trim(),
        onePerRow,
        actionType: action.actionType,
        actionTarget: action.actionTarget,
      })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BOT_CONFIG_KEYS.buttons })
      toast.success(t('botConfigPage.buttons.toasts.updated'))
    },
    onError: () => toast.error(t('botConfigPage.buttons.toasts.updateFailed')),
  })

  const insertLabelEmoji = (emoji: string) => {
    const el = labelRef.current
    const start = el?.selectionStart ?? label.length
    const end = el?.selectionEnd ?? label.length
    const { value: next, caret } = insertAtCaret(label, start, end, emoji)
    setLabel(next)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(caret, caret)
    })
  }

  const dirty =
    label !== button.label ||
    styleValue !== button.style ||
    (iconCustomEmojiId.trim() === '' ? null : iconCustomEmojiId.trim()) !==
      (button.iconCustomEmojiId ?? null) ||
    onePerRow !== button.onePerRow ||
    actionType !== button.actionType ||
    (actionTarget.trim() === '' ? null : actionTarget.trim()) !== (button.actionTarget ?? null)
  const canSave = label.trim().length > 0 && dirty && !mutation.isPending

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        'space-y-2 rounded-md border bg-muted/20 p-3',
        isDragging && 'bg-muted/40',
      )}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="cursor-grab touch-none rounded px-0.5 text-muted-foreground hover:text-foreground"
          aria-label={t('botConfigPage.buttons.dragHandle')}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" aria-hidden />
        </button>
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">{button.buttonId}</code>
        <div className="ml-auto flex items-center gap-1.5">
          {button.visible ? (
            <Eye className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          ) : (
            <EyeOff className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          )}
          <Switch
            checked={button.visible}
            onCheckedChange={onToggleVisible}
            aria-label={t('botConfigPage.buttons.toggleVisible')}
          />
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-[11px]">{t('botConfigPage.buttons.fields.label')}</Label>
          <EmojiPicker onSelect={insertLabelEmoji} ariaLabel={t('emojiPicker.trigger')} />
        </div>
        <Input
          ref={labelRef}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={120}
          className="text-xs"
        />
      </div>

      <ActionFields
        idPrefix={`reply-${button.id}`}
        actionType={actionType}
        actionTarget={actionTarget}
        onActionTypeChange={(next) => {
          setActionType(next)
          if (next === 'CALLBACK' || next === 'SUPPORT_URL') setActionTarget('')
        }}
        onActionTargetChange={setActionTarget}
      />

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[11px]">{t('botConfigPage.buttons.fields.style')}</Label>
          <Select value={styleValue} onValueChange={(v) => setStyleValue(v as BotButtonStyle)}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REPLY_BUTTON_STYLES.map((s) => (
                <SelectItem key={s} value={s} className="text-xs">
                  {t(`botConfigPage.buttons.styles.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px]">{t('botConfigPage.buttons.fields.iconCustomEmojiId')}</Label>
          <Input
            value={iconCustomEmojiId}
            onChange={(e) => setIconCustomEmojiId(e.target.value)}
            placeholder={t('botConfigPage.buttons.fields.iconCustomEmojiIdPlaceholder')}
            maxLength={120}
            className="font-mono text-xs"
          />
        </div>
      </div>

      <div className="flex items-center justify-between rounded-md border bg-muted/20 p-2">
        <div className="min-w-0">
          <Label className="text-[11px]">{t('botConfigPage.buttons.fields.onePerRow')}</Label>
          <p className="text-[10px] leading-snug text-muted-foreground">
            {t('botConfigPage.buttons.fields.onePerRowHint')}
          </p>
        </div>
        <Switch checked={onePerRow} onCheckedChange={setOnePerRow} />
      </div>

      <div className="flex items-center justify-between">
        <Button
          size="sm"
          variant="ghost"
          onClick={onDelete}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden />
          {t('botConfigPage.buttons.delete')}
        </Button>
        <Button size="sm" onClick={() => mutation.mutate()} disabled={!canSave}>
          <SaveIcon className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          {t('botConfigPage.buttons.save')}
        </Button>
      </div>
    </li>
  )
}
