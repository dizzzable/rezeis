/**
 * Emoji Studio tab.
 *
 * One place to manage every semantic emoji slot: its fallback glyph and the
 * premium emoji (picked from imported packs — no raw ids to paste), plus the
 * blocks/screens that reference it. Premium custom emoji only render for users
 * when the bot owner has Telegram Premium, so the fallback is always editable.
 *
 * Mutations reuse the existing `PATCH /admin/bot-config/emojis/:id` endpoint
 * (fallback → `unicode`, premium bind/clear → `tgEmojiId`).
 */
import { useEffect, useState, type JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, Sparkles, X } from 'lucide-react'

import { api } from '@/lib/api'
import { expectArray } from '@/lib/api-utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { botConfigApi, BOT_CONFIG_KEYS, type EmojiStudioSlot } from '@/features/bot-config/bot-config-api'

import { EmojiPreview } from './emoji-preview'

interface PackEmojiLite {
  readonly slug: string
  readonly name: string
  readonly imageUrl: string
  readonly lottieUrl: string | null
  readonly videoUrl: string | null
  readonly customEmojiId: string | null
}
interface PackLite {
  readonly id: string
  readonly name: string
  readonly emojis: readonly PackEmojiLite[]
}

const PACKS_KEY = ['admin', 'custom-emoji', 'packs'] as const

/**
 * The three status-dot slots of the traffic line.
 *
 * The bot picks exactly one per traffic line from how close usage is to the
 * plan limit, and EVERY traffic line uses that same pick — the leading «Трафик»
 * line of a plan and each «Трафик доп.» line of a merged tariff. So an emoji
 * bound to one of these changes every traffic indicator at once, which the bare
 * registry keys (`TRAFFIC_WARN`) do not say. They are grouped and named here
 * instead of being left as three anonymous rows in registry order.
 */
const TRAFFIC_SLOT_KEYS = ['TRAFFIC_OK', 'TRAFFIC_WARN', 'TRAFFIC_FULL'] as const
type TrafficSlotKey = (typeof TRAFFIC_SLOT_KEYS)[number]

/** Owner-facing name per traffic slot; null for every other slot. */
const TRAFFIC_SLOT_LABEL_KEYS: Readonly<Record<TrafficSlotKey, string>> = {
  TRAFFIC_OK: 'emojiPacksPage.studio.slotLabels.TRAFFIC_OK',
  TRAFFIC_WARN: 'emojiPacksPage.studio.slotLabels.TRAFFIC_WARN',
  TRAFFIC_FULL: 'emojiPacksPage.studio.slotLabels.TRAFFIC_FULL',
}

function isTrafficSlotKey(key: string): key is TrafficSlotKey {
  return (TRAFFIC_SLOT_KEYS as readonly string[]).includes(key)
}

/**
 * Slot rows in the registry's order, with the three `TRAFFIC_*` slots pulled
 * into one block under their shared hint — at the position of the first traffic
 * slot, so the rest of the registry keeps its server order. The group is
 * rendered once even if the three rows are not adjacent in the payload.
 */
function SlotRows({ slots }: { readonly slots: readonly EmojiStudioSlot[] }): JSX.Element {
  const { t } = useTranslation()
  const trafficSlots = slots.filter((slot) => isTrafficSlotKey(slot.key))
  const rows: JSX.Element[] = []
  let trafficGroupDrawn = false

  for (const slot of slots) {
    if (!isTrafficSlotKey(slot.key)) {
      rows.push(<SlotRow key={slot.id} slot={slot} />)
      continue
    }
    if (trafficGroupDrawn) continue
    trafficGroupDrawn = true
    rows.push(
      <TableRow key="traffic-group" data-emoji-traffic-group="hint" className="hover:bg-transparent">
        <TableCell colSpan={4} className="bg-muted/40 py-2 text-xs text-muted-foreground">
          {t('emojiPacksPage.studio.trafficGroupHint')}
        </TableCell>
      </TableRow>,
    )
    for (const trafficSlot of trafficSlots) {
      rows.push(<SlotRow key={trafficSlot.id} slot={trafficSlot} />)
    }
  }

  return <>{rows}</>
}

export function EmojiStudioTab(): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: BOT_CONFIG_KEYS.emojiStudio,
    queryFn: botConfigApi.getEmojiStudio,
  })

  const ownerPremium = useMutation({
    mutationFn: (enabled: boolean) => botConfigApi.setEmojiOwnerPremium(enabled),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BOT_CONFIG_KEYS.emojiStudio })
      toast.success(t('emojiPacksPage.studio.ownerPremiumSaved'))
    },
    onError: () => toast.error(t('emojiPacksPage.studio.ownerPremiumFailed')),
  })

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  const slots = data?.slots ?? []
  const hasPremium = data?.ownerHasPremium ?? false

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('emojiPacksPage.studio.subtitle')}</p>
      <div
        className={
          hasPremium
            ? 'flex items-center justify-between gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400'
            : 'flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400'
        }
      >
        <span>
          {hasPremium
            ? t('emojiPacksPage.studio.ownerPremiumOn')
            : t('emojiPacksPage.studio.ownerPremiumOff')}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <Label htmlFor="owner-premium-switch" className="cursor-pointer text-xs font-normal">
            {t('emojiPacksPage.studio.ownerPremiumLabel')}
          </Label>
          <Switch
            id="owner-premium-switch"
            checked={hasPremium}
            disabled={ownerPremium.isPending}
            onCheckedChange={(value) => ownerPremium.mutate(value)}
            aria-label={t('emojiPacksPage.studio.ownerPremiumLabel')}
          />
        </div>
      </div>

      <div className="rounded-md border">
        {slots.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {t('emojiPacksPage.studio.empty')}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('emojiPacksPage.studio.colSlot')}</TableHead>
                <TableHead>{t('emojiPacksPage.studio.colUsedIn')}</TableHead>
                <TableHead className="w-28 text-center">{t('emojiPacksPage.studio.colFallback')}</TableHead>
                <TableHead className="w-64">{t('emojiPacksPage.studio.colPremium')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <SlotRows slots={slots} />
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}

function SlotRow({ slot }: { readonly slot: EmojiStudioSlot }): JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [fallback, setFallback] = useState(slot.unicode)
  const trafficLabelKey = isTrafficSlotKey(slot.key) ? TRAFFIC_SLOT_LABEL_KEYS[slot.key] : null

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync local edit buffer when the server row changes
    setFallback(slot.unicode)
  }, [slot.unicode])

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: BOT_CONFIG_KEYS.emojiStudio })
    void queryClient.invalidateQueries({ queryKey: BOT_CONFIG_KEYS.emojis })
  }

  const saveFallback = useMutation({
    mutationFn: (value: string) => botConfigApi.updateEmoji(slot.id, { unicode: value }),
    onSuccess: () => {
      invalidate()
      toast.success(t('emojiPacksPage.studio.saved'))
    },
    onError: () => toast.error(t('emojiPacksPage.studio.saveFailed')),
  })

  const setPremium = useMutation({
    mutationFn: (tgEmojiId: string | null) => botConfigApi.updateEmoji(slot.id, { tgEmojiId }),
    onSuccess: () => {
      invalidate()
      toast.success(t('emojiPacksPage.studio.saved'))
    },
    onError: () => toast.error(t('emojiPacksPage.studio.saveFailed')),
  })

  const commitFallback = (): void => {
    const value = fallback.trim()
    if (value.length === 0 || value === slot.unicode) {
      setFallback(slot.unicode)
      return
    }
    saveFallback.mutate(value)
  }

  return (
    <TableRow data-emoji-traffic-group={trafficLabelKey === null ? undefined : 'slot'}>
      <TableCell className="text-xs">
        {trafficLabelKey === null ? (
          <span className="font-mono">{slot.key}</span>
        ) : (
          // The name says WHAT the emoji means; the raw key stays visible so an
          // operator can still match the row to logs and to the other editors.
          <>
            <span className="block text-[13px] font-medium">{t(trafficLabelKey)}</span>
            <span className="block font-mono text-[10px] text-muted-foreground">{slot.key}</span>
          </>
        )}
      </TableCell>
      <TableCell>
        {slot.usedIn.length === 0 ? (
          <span className="text-xs text-muted-foreground">{t('emojiPacksPage.studio.notUsed')}</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {slot.usedIn.map((u) => (
              <Badge key={u} variant="outline" className="text-[10px] font-normal">
                {u}
              </Badge>
            ))}
          </div>
        )}
      </TableCell>
      <TableCell className="text-center">
        <Input
          value={fallback}
          onChange={(e) => setFallback(e.target.value)}
          onBlur={commitFallback}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          maxLength={16}
          aria-label={`${slot.key} ${t('emojiPacksPage.studio.colFallback')}`}
          className="mx-auto h-8 w-16 text-center text-lg"
        />
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          {slot.premiumPreview ? (
            <EmojiPreview
              imageUrl={slot.premiumPreview.imageUrl}
              lottieUrl={slot.premiumPreview.lottieUrl}
              videoUrl={slot.premiumPreview.videoUrl}
              alt={slot.premiumPreview.name}
              className="h-7 w-7 shrink-0"
            />
          ) : slot.tgEmojiId ? (
            <span className="font-mono text-[10px] text-muted-foreground">{slot.tgEmojiId}</span>
          ) : (
            <span className="text-xs text-muted-foreground">{t('emojiPacksPage.studio.noPremium')}</span>
          )}

          <PremiumPicker
            disabled={setPremium.isPending}
            onPick={(id) => setPremium.mutate(id)}
          />
          {slot.tgEmojiId && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground"
              disabled={setPremium.isPending}
              aria-label={t('emojiPacksPage.studio.clearPremium')}
              onClick={() => setPremium.mutate(null)}
            >
              {setPremium.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

function PremiumPicker({
  onPick,
  disabled,
}: {
  readonly onPick: (customEmojiId: string) => void
  readonly disabled: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const { data: packs } = useQuery<ReadonlyArray<PackLite>>({
    queryKey: PACKS_KEY,
    queryFn: async () =>
      expectArray<PackLite>((await api.get('/admin/custom-emoji/packs')).data),
    enabled: open,
    staleTime: 60_000,
  })

  // Only emoji that carry a custom_emoji_id can be bound to a slot.
  // NB: `Array.isArray` narrows to `any[]`, which would strip PackLite typing
  // (CI's tsconfig.app.json flags the resulting implicit-any), so re-assert the
  // element type explicitly on the fallback.
  const packList: ReadonlyArray<PackLite> = Array.isArray(packs) ? packs : []
  const bindablePacks = packList
    .map((p) => ({ ...p, emojis: p.emojis.filter((e) => (e.customEmojiId ?? '').length > 0) }))
    .filter((p) => p.emojis.length > 0)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs"
          disabled={disabled}
          aria-label={t('emojiPacksPage.studio.choosePremium')}
        >
          <Sparkles className="h-3.5 w-3.5" />
          {t('emojiPacksPage.studio.choosePremium')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-2" align="end">
        <p className="mb-2 text-[11px] font-medium text-muted-foreground">
          {t('emojiPacksPage.studio.pickerTitle')}
        </p>
        {bindablePacks.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {t('emojiPacksPage.studio.pickerEmpty')}
          </p>
        ) : (
          <div
            className="max-h-60 space-y-3 overflow-y-auto overflow-x-hidden overscroll-contain"
            onWheelCapture={(e) => e.stopPropagation()}
          >
            {bindablePacks.map((pack) => (
              <div key={pack.id} className="space-y-1">
                <p className="text-[11px] font-medium text-muted-foreground">{pack.name}</p>
                <div className="grid grid-cols-8 gap-1">
                  {pack.emojis.map((emoji) => (
                    <button
                      type="button"
                      key={emoji.slug}
                      title={emoji.name}
                      aria-label={emoji.name}
                      onClick={() => {
                        onPick(emoji.customEmojiId as string)
                        setOpen(false)
                      }}
                      className="flex aspect-square w-full items-center justify-center rounded hover:bg-muted"
                    >
                      <EmojiPreview
                        imageUrl={emoji.imageUrl}
                        lottieUrl={emoji.lottieUrl}
                        videoUrl={emoji.videoUrl}
                        alt={emoji.name}
                        playMode="hover"
                        className="h-6 w-6"
                      />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
