import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Trophy,
  Plus,
  Info,
  Pencil,
  Trash2,
  ArrowUp,
  ArrowDown,
  Upload,
  Send,
  Mail,
  Users,
  Rss,
  Gift,
  Star,
  Link2,
  type LucideIcon,
} from 'lucide-react'

import { api } from '@/lib/api'
import { getErrorMessage } from '@/lib/http-errors'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

import { usePlans } from '@/features/plans/plans-api'

import {
  createQuest,
  deleteQuest,
  listQuestIcons,
  listQuests,
  questIconAdminUrl,
  reorderQuests,
  updateQuest,
  uploadQuestIcon,
  type Quest,
  type QuestIconKind,
  type QuestRewardType,
  type QuestType,
} from './quests-api'
import {
  buildQuestPayload,
  emptyQuestDraft,
  questToDraft,
  validateQuestDraft,
  type QuestDraft,
  type QuestValidationMessages,
} from './quests-form-schema'

// Quest types with a working end-to-end completion path. SUBSCRIBE_CHANNEL
// (Phase B) and PARTNER_TASK (Phase C) are verified via the bot / signed
// partner callback; CUSTOM has no detection yet and stays gated off (matches
// the backend QuestService COMPLETABLE_QUEST_TYPES allow-list).
const QUEST_TYPES: QuestType[] = [
  'LINK_TELEGRAM',
  'LINK_EMAIL',
  'INVITE_FRIENDS',
  'SUBSCRIBE_CHANNEL',
  'PARTNER_TASK',
]
const PARTNER_METHODS = ['manual_code', 'postback', 'timed_visit'] as const
const REWARD_TYPES: QuestRewardType[] = ['POINTS', 'DAYS', 'PROMOCODE', 'DISCOUNT', 'TRAFFIC']
const SUB_BUCKETS = ['ACTIVE', 'EXPIRED', 'TRIAL', 'LIMITED', 'NONE'] as const
const PLATFORM_OPTS = ['telegram', 'miniapp', 'web'] as const
const CONTACT_OPTS = ['hasTelegram', 'hasEmail', 'hasWebPush'] as const
const PRESET_ICONS: ReadonlyArray<{ key: string; icon: LucideIcon }> = [
  { key: 'telegram', icon: Send },
  { key: 'email', icon: Mail },
  { key: 'friends', icon: Users },
  { key: 'channel', icon: Rss },
  { key: 'gift', icon: Gift },
  { key: 'star', icon: Star },
  { key: 'trophy', icon: Trophy },
  { key: 'link', icon: Link2 },
]
const PRESET_ICON_MAP = new Map(PRESET_ICONS.map((p) => [p.key, p.icon]))

function toggleIn(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

/** Hoverable info icon reusing the product tooltip pattern (what / how / example). */
function InfoTip({ text }: { text: string }) {
  const { t } = useTranslation()
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('questsAdminPage.help.infoAria')}
            className="inline-flex text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs leading-snug">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function LabelWithHint({ label, hint }: { label: string; hint?: string }) {
  return (
    <span className="flex items-center gap-1">
      {label}
      {hint && <InfoTip text={hint} />}
    </span>
  )
}

/** Thumbnail for an uploaded SVG icon, fetched through the authenticated axios client. */
function SvgIconThumb({ iconId, className }: { iconId: string; className?: string }) {
  // Cache the immutable Blob in the query cache (deduped across thumbs); each
  // component mints + revokes its OWN object URL so unmounting one thumb never
  // invalidates a URL another thumb is still rendering.
  const { data: blob } = useQuery({
    queryKey: ['admin', 'quests', 'icon-blob', iconId],
    queryFn: async () => {
      const res = await api.get(questIconAdminUrl(iconId), { responseType: 'blob' })
      return res.data as Blob
    },
    staleTime: Infinity,
    enabled: iconId.trim().length > 0,
  })
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob) {
      setUrl(null)
      return
    }
    const objectUrl = URL.createObjectURL(blob)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [blob])
  if (!url) return <span className={cn('inline-block h-5 w-5', className)} />
  return <img src={url} alt="" className={cn('h-5 w-5 object-contain', className)} />
}

function QuestIconThumb({
  iconKind,
  iconRef,
  className,
}: {
  iconKind: QuestIconKind
  iconRef: string
  className?: string
}) {
  if (iconKind === 'SVG') return <SvgIconThumb iconId={iconRef} className={className} />
  const Icon = PRESET_ICON_MAP.get(iconRef) ?? Trophy
  return <Icon className={cn('h-5 w-5', className)} />
}

function FilterChipGroup({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string
  options: ReadonlyArray<{ value: string; label: string }>
  selected: string[]
  onToggle: (value: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const active = selected.includes(opt.value)
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onToggle(opt.value)}
              aria-pressed={active}
              className={cn(
                'rounded-full border px-3 py-1 text-xs transition-colors',
                active
                  ? 'border-primary bg-primary/15 text-primary'
                  : 'border-border text-muted-foreground hover:bg-muted',
              )}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default function QuestsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Quest | null>(null)

  const quests = useQuery({ queryKey: ['admin', 'quests'], queryFn: listQuests })

  const reorder = useMutation({
    mutationFn: (orderedIds: string[]) => reorderQuests(orderedIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'quests'] })
      toast.success(t('questsAdminPage.toast.reordered'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('questsAdminPage.toast.saveFailed'))),
  })

  const remove = useMutation({
    mutationFn: (id: string) => deleteQuest(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'quests'] })
      toast.success(t('questsAdminPage.toast.deleted'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('questsAdminPage.toast.saveFailed'))),
  })

  const rows = quests.data ?? []

  function move(index: number, direction: -1 | 1): void {
    const next = [...rows]
    const target = index + direction
    if (target < 0 || target >= next.length) return
    const [item] = next.splice(index, 1)
    next.splice(target, 0, item)
    reorder.mutate(next.map((q) => q.id))
  }

  function openCreate(): void {
    setEditing(null)
    setDialogOpen(true)
  }

  function openEdit(quest: Quest): void {
    setEditing(quest)
    setDialogOpen(true)
  }

  function rewardLabel(quest: Quest): string {
    const type = t(`questsAdminPage.rewardTypes.${quest.rewardType}`)
    return quest.rewardType === 'PROMOCODE' ? type : `${quest.rewardAmount} · ${type}`
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Trophy className="h-6 w-6" />
            {t('questsAdminPage.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('questsAdminPage.subtitle')}</p>
        </div>
        <Button className="gap-1" onClick={openCreate}>
          <Plus className="h-4 w-4" />
          {t('questsAdminPage.actions.new')}
        </Button>
      </header>

      <Card>
        <CardContent className="p-0">
          {quests.isLoading ? (
            <div className="space-y-3 p-6">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="py-16 text-center text-muted-foreground">
              <Trophy className="mx-auto mb-3 h-10 w-10 opacity-30" />
              <p>{t('questsAdminPage.empty')}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">{t('questsAdminPage.columns.order')}</TableHead>
                  <TableHead>{t('questsAdminPage.columns.title')}</TableHead>
                  <TableHead>{t('questsAdminPage.columns.type')}</TableHead>
                  <TableHead>{t('questsAdminPage.columns.reward')}</TableHead>
                  <TableHead className="w-20">{t('questsAdminPage.columns.issued')}</TableHead>
                  <TableHead className="w-24">{t('questsAdminPage.columns.status')}</TableHead>
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((quest, index) => (
                  <TableRow key={quest.id}>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          disabled={index === 0 || reorder.isPending}
                          onClick={() => move(index, -1)}
                          aria-label={t('questsAdminPage.actions.moveUp')}
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          disabled={index === rows.length - 1 || reorder.isPending}
                          onClick={() => move(index, 1)}
                          aria-label={t('questsAdminPage.actions.moveDown')}
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <QuestIconThumb
                          iconKind={quest.iconKind}
                          iconRef={quest.iconRef}
                          className="text-muted-foreground"
                        />
                        <span className="font-medium">{quest.title.ru || quest.title.en}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{t(`questsAdminPage.types.${quest.type}`)}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">{rewardLabel(quest)}</TableCell>
                    <TableCell className="tabular-nums text-sm text-muted-foreground">
                      {quest.issuedCount}
                    </TableCell>
                    <TableCell>
                      <Badge variant={quest.enabled ? 'default' : 'outline'}>
                        {quest.enabled
                          ? t('questsAdminPage.status.enabled')
                          : t('questsAdminPage.status.disabled')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-muted-foreground"
                          onClick={() => openEdit(quest)}
                          aria-label={t('questsAdminPage.actions.edit')}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-destructive"
                              aria-label={t('questsAdminPage.actions.delete')}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>{t('questsAdminPage.delete.title')}</AlertDialogTitle>
                              <AlertDialogDescription>
                                {t('questsAdminPage.delete.description')}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel disabled={remove.isPending}>
                                {t('questsAdminPage.form.cancel')}
                              </AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                disabled={remove.isPending}
                                onClick={() => remove.mutate(quest.id)}
                              >
                                {t('questsAdminPage.delete.confirm')}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing
                ? t('questsAdminPage.form.editTitle')
                : t('questsAdminPage.form.createTitle')}
            </DialogTitle>
          </DialogHeader>
          {dialogOpen && (
            <QuestForm quest={editing} onClose={() => setDialogOpen(false)} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Create / edit form ──────────────────────────────────────────────────────

function QuestForm({ quest, onClose }: { quest: Quest | null; onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<QuestDraft>(() =>
    quest ? questToDraft(quest) : emptyQuestDraft(),
  )
  const [errors, setErrors] = useState<Record<string, string>>({})

  const icons = useQuery({ queryKey: ['admin', 'quests', 'icons'], queryFn: listQuestIcons })
  // Catalog for the GRANT_TRIAL plan picker — all active non-archived plans,
  // TRIAL availability sorted first (grantTrial accepts non-trial plans too).
  const { data: allPlans = [], isLoading: plansLoading } = usePlans(
    undefined,
    {
      enabled:
        draft.rewardType === 'DAYS' && draft.daysFallback === 'GRANT_TRIAL',
    },
  )
  const trialPlanOptions = useMemo(() => {
    const active = allPlans.filter((p) => p.isActive && !p.isArchived)
    // Prefer TRIAL first, keep every other active plan selectable (mixed catalog).
    const base = [...active].sort((a, b) => {
      const aTrial = a.availability === 'TRIAL' ? 0 : 1
      const bTrial = b.availability === 'TRIAL' ? 0 : 1
      if (aTrial !== bTrial) return aTrial - bTrial
      return a.name.localeCompare(b.name)
    })
    // Keep a previously saved (possibly inactive/archived) plan visible when editing.
    const selectedId = draft.rewardPlanId.trim()
    if (selectedId && !base.some((p) => p.id === selectedId)) {
      const orphan = allPlans.find((p) => p.id === selectedId)
      if (orphan) return [orphan, ...base]
    }
    return base
  }, [allPlans, draft.rewardPlanId])

  const validationMessages = useMemo<QuestValidationMessages>(
    () => ({
      titleRequired: t('questsAdminPage.validation.titleRequired'),
      rewardAmountRequired: t('questsAdminPage.validation.rewardAmountRequired'),
      planRequired: t('questsAdminPage.validation.planRequired'),
      channelLinkRequired: t('questsAdminPage.validation.channelLinkRequired'),
      channelLinkInvalid: t('questsAdminPage.validation.channelLinkInvalid'),
      channelIdInvalid: t('questsAdminPage.validation.channelIdInvalid'),
      channelIdRequiredForInvite: t('questsAdminPage.validation.channelIdRequiredForInvite'),
      windowInvalid: t('questsAdminPage.validation.windowInvalid'),
      partnerRequired: t('questsAdminPage.validation.partnerRequired'),
    }),
    [t],
  )

  function set<K extends keyof QuestDraft>(key: K, value: QuestDraft[K]): void {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const save = useMutation({
    mutationFn: () => {
      const payload = buildQuestPayload(draft)
      return quest ? updateQuest(quest.id, payload) : createQuest(payload)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'quests'] })
      toast.success(quest ? t('questsAdminPage.toast.updated') : t('questsAdminPage.toast.created'))
      onClose()
    },
    onError: (err) => toast.error(getErrorMessage(err, t('questsAdminPage.toast.saveFailed'))),
  })

  const upload = useMutation({
    mutationFn: (file: File) => uploadQuestIcon(file),
    onSuccess: (icon) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'quests', 'icons'] })
      setDraft((prev) => ({ ...prev, iconKind: 'SVG', iconRef: icon.id }))
      toast.success(t('questsAdminPage.toast.iconUploaded'))
    },
    onError: (err) => toast.error(getErrorMessage(err, t('questsAdminPage.toast.iconUploadFailed'))),
  })

  function submit(): void {
    const found = validateQuestDraft(draft, validationMessages)
    setErrors(found)
    if (Object.keys(found).length === 0) save.mutate()
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0]
    if (file) upload.mutate(file)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <div className="space-y-4">
      {/* Type + reward */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>
            <LabelWithHint label={t('questsAdminPage.form.type')} hint={t('questsAdminPage.help.type')} />
          </Label>
          <Select value={draft.type} onValueChange={(v) => set('type', v as QuestType)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {QUEST_TYPES.map((qt) => (
                <SelectItem key={qt} value={qt}>
                  {t(`questsAdminPage.types.${qt}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>
            <LabelWithHint
              label={t('questsAdminPage.form.rewardType')}
              hint={t('questsAdminPage.help.rewardType')}
            />
          </Label>
          <Select value={draft.rewardType} onValueChange={(v) => set('rewardType', v as QuestRewardType)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REWARD_TYPES.map((rt) => (
                <SelectItem key={rt} value={rt}>
                  {t(`questsAdminPage.rewardTypes.${rt}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Titles */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>{t('questsAdminPage.form.titleRu')}</Label>
          <Input value={draft.titleRu} onChange={(e) => set('titleRu', e.target.value)} maxLength={200} />
        </div>
        <div className="space-y-1.5">
          <Label>{t('questsAdminPage.form.titleEn')}</Label>
          <Input value={draft.titleEn} onChange={(e) => set('titleEn', e.target.value)} maxLength={200} />
        </div>
      </div>
      {errors.title && <p className="text-xs text-destructive">{errors.title}</p>}

      {/* Descriptions */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>{t('questsAdminPage.form.descRu')}</Label>
          <Textarea
            value={draft.descRu}
            onChange={(e) => set('descRu', e.target.value)}
            rows={2}
            maxLength={200}
          />
        </div>
        <div className="space-y-1.5">
          <Label>{t('questsAdminPage.form.descEn')}</Label>
          <Textarea
            value={draft.descEn}
            onChange={(e) => set('descEn', e.target.value)}
            rows={2}
            maxLength={200}
          />
        </div>
      </div>

      {/* Reward amount / days fallback / plan */}
      {draft.rewardType !== 'PROMOCODE' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t('questsAdminPage.form.rewardAmount')}</Label>
            <Input
              type="number"
              min={1}
              value={draft.rewardAmount}
              onChange={(e) => set('rewardAmount', e.target.value)}
            />
            {errors.rewardAmount && <p className="text-xs text-destructive">{errors.rewardAmount}</p>}
          </div>
          {draft.rewardType === 'DAYS' && (
            <div className="space-y-1.5">
              <Label>
                <LabelWithHint
                  label={t('questsAdminPage.form.daysFallback')}
                  hint={t('questsAdminPage.help.daysFallback')}
                />
              </Label>
              <Select
                value={draft.daysFallback}
                onValueChange={(v) => set('daysFallback', v as QuestDraft['daysFallback'])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="GRANT_TRIAL">
                    {t('questsAdminPage.daysFallback.GRANT_TRIAL')}
                  </SelectItem>
                  <SelectItem value="MINT_PROMOCODE">
                    {t('questsAdminPage.daysFallback.MINT_PROMOCODE')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}
      {draft.rewardType === 'DAYS' && draft.daysFallback === 'GRANT_TRIAL' && (
        <div className="space-y-1.5">
          <Label>
            <LabelWithHint
              label={t('questsAdminPage.form.rewardPlanId')}
              hint={t('questsAdminPage.help.rewardPlanId')}
            />
          </Label>
          <Select
            value={draft.rewardPlanId || undefined}
            onValueChange={(v) => set('rewardPlanId', v)}
            disabled={plansLoading || trialPlanOptions.length === 0}
          >
            <SelectTrigger aria-label={t('questsAdminPage.form.rewardPlanId')}>
              <SelectValue
                placeholder={
                  plansLoading
                    ? t('questsAdminPage.form.rewardPlanLoading')
                    : trialPlanOptions.length === 0
                      ? t('questsAdminPage.form.rewardPlanEmpty')
                      : t('questsAdminPage.form.rewardPlanPlaceholder')
                }
              />
            </SelectTrigger>
            <SelectContent>
              {trialPlanOptions.map((plan) => (
                <SelectItem key={plan.id} value={plan.id}>
                  {plan.name}
                  {plan.availability === 'TRIAL' ? ` · ${t('questsAdminPage.form.rewardPlanTrialTag')}` : ''}
                  {plan.isArchived ? ` · ${t('questsAdminPage.form.rewardPlanArchivedTag')}` : ''}
                  {!plan.isActive ? ` · ${t('questsAdminPage.form.rewardPlanInactiveTag')}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors.rewardPlanId && <p className="text-xs text-destructive">{errors.rewardPlanId}</p>}
          {!plansLoading && trialPlanOptions.length === 0 && (
            <p className="text-xs text-muted-foreground">{t('questsAdminPage.form.rewardPlanEmptyHint')}</p>
          )}
        </div>
      )}

      {/* Type-specific params */}
      {draft.type === 'INVITE_FRIENDS' && (
        <div className="space-y-1.5">
          <Label>
            <LabelWithHint
              label={t('questsAdminPage.form.requiredFriends')}
              hint={t('questsAdminPage.help.requiredFriends')}
            />
          </Label>
          <Input
            type="number"
            min={1}
            value={draft.requiredFriends}
            onChange={(e) => set('requiredFriends', e.target.value)}
            className="max-w-[160px]"
          />
        </div>
      )}
      {draft.type === 'SUBSCRIBE_CHANNEL' && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>
              <LabelWithHint
                label={t('questsAdminPage.form.channelLink')}
                hint={t('questsAdminPage.help.channelLink')}
              />
            </Label>
            <Input
              value={draft.channelLink}
              onChange={(e) => set('channelLink', e.target.value)}
              placeholder={t('questsAdminPage.form.channelLinkPlaceholder')}
            />
            {errors.channelLink && <p className="text-xs text-destructive">{errors.channelLink}</p>}
          </div>
          <div className="space-y-1.5">
            <Label>
              <LabelWithHint
                label={t('questsAdminPage.form.channelId')}
                hint={t('questsAdminPage.help.channelId')}
              />
            </Label>
            <Input
              value={draft.channelId}
              onChange={(e) => set('channelId', e.target.value)}
              placeholder={t('questsAdminPage.form.channelIdPlaceholder')}
            />
            {errors.channelId && <p className="text-xs text-destructive">{errors.channelId}</p>}
          </div>
        </div>
      )}
      {draft.type === 'PARTNER_TASK' && (
        <div className="space-y-3 rounded-lg border border-border/60 p-3">
          <div className="space-y-1.5">
            <Label>
              <LabelWithHint
                label={t('questsAdminPage.form.partnerMethod')}
                hint={t('questsAdminPage.help.partnerMethod')}
              />
            </Label>
            <Select
              value={draft.partnerMethod}
              onValueChange={(v) => set('partnerMethod', v as QuestDraft['partnerMethod'])}
            >
              <SelectTrigger className="max-w-[240px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PARTNER_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {t(`questsAdminPage.partnerMethod.${m}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>
              <LabelWithHint
                label={t('questsAdminPage.form.partnerSlug')}
                hint={t('questsAdminPage.help.partnerSlug')}
              />
            </Label>
            <Input
              value={draft.partnerSlug}
              onChange={(e) => set('partnerSlug', e.target.value)}
              placeholder="acme"
              className="max-w-[240px]"
            />
            {errors.partnerSlug && <p className="text-xs text-destructive">{errors.partnerSlug}</p>}
          </div>
          {draft.partnerMethod === 'manual_code' && (
            <div className="space-y-1.5">
              <Label>
                <LabelWithHint
                  label={t('questsAdminPage.form.partnerCode')}
                  hint={t('questsAdminPage.help.partnerCode')}
                />
              </Label>
              <Input
                value={draft.partnerCode}
                onChange={(e) => set('partnerCode', e.target.value)}
                placeholder="PROMO2026"
                className="max-w-[240px]"
              />
              {errors.partnerCode && <p className="text-xs text-destructive">{errors.partnerCode}</p>}
            </div>
          )}
          <div className="space-y-1.5">
            <Label>
              <LabelWithHint
                label={t('questsAdminPage.form.partnerLandingUrl')}
                hint={t('questsAdminPage.help.partnerLandingUrl')}
              />
            </Label>
            <Input
              type="url"
              value={draft.partnerLandingUrl}
              onChange={(e) => set('partnerLandingUrl', e.target.value)}
              placeholder="https://partner.example/offer"
            />
          </div>
          {draft.partnerMethod === 'timed_visit' && (
            <div className="space-y-1.5">
              <Label>
                <LabelWithHint
                  label={t('questsAdminPage.form.partnerDwellSeconds')}
                  hint={t('questsAdminPage.help.partnerDwellSeconds')}
                />
              </Label>
              <Input
                type="number"
                min={0}
                max={3600}
                value={draft.partnerDwellSeconds}
                onChange={(e) => set('partnerDwellSeconds', e.target.value)}
                className="max-w-[160px]"
              />
            </div>
          )}
        </div>
      )}
      {/* Icon picker */}
      <div className="space-y-2 rounded-lg border border-border/60 p-3">
        <Label>
          <LabelWithHint label={t('questsAdminPage.form.icon')} hint={t('questsAdminPage.help.icon')} />
        </Label>
        <Select value={draft.iconKind} onValueChange={(v) => set('iconKind', v as QuestIconKind)}>
          <SelectTrigger className="max-w-[220px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="PRESET">{t('questsAdminPage.iconKind.PRESET')}</SelectItem>
            <SelectItem value="SVG">{t('questsAdminPage.iconKind.SVG')}</SelectItem>
          </SelectContent>
        </Select>
        {draft.iconKind === 'PRESET' ? (
          <div className="flex flex-wrap gap-1.5">
            {PRESET_ICONS.map(({ key, icon: Icon }) => {
              const active = draft.iconRef === key
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => set('iconRef', key)}
                  aria-label={t(`questsAdminPage.presets.${key}`)}
                  aria-pressed={active}
                  className={cn(
                    'flex h-10 w-10 items-center justify-center rounded-lg border transition-colors',
                    active
                      ? 'border-primary bg-primary/15 text-primary'
                      : 'border-border text-muted-foreground hover:bg-muted',
                  )}
                >
                  <Icon className="h-5 w-5" />
                </button>
              )
            })}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {icons.data?.map((icon) => {
                const active = draft.iconRef === icon.id
                return (
                  <button
                    key={icon.id}
                    type="button"
                    onClick={() => set('iconRef', icon.id)}
                    title={icon.name}
                    aria-pressed={active}
                    className={cn(
                      'flex h-10 w-10 items-center justify-center rounded-lg border transition-colors',
                      active ? 'border-primary bg-primary/15' : 'border-border hover:bg-muted',
                    )}
                  >
                    <SvgIconThumb iconId={icon.id} />
                  </button>
                )
              })}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/svg+xml"
              className="hidden"
              onChange={onPickFile}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-1"
              disabled={upload.isPending}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="h-3.5 w-3.5" />
              {t('questsAdminPage.form.uploadSvg')}
            </Button>
          </div>
        )}
      </div>

      {/* Audience filter */}
      <div className="space-y-3 rounded-lg border border-border/60 p-3">
        <div>
          <Label>
            <LabelWithHint
              label={t('questsAdminPage.audience.title')}
              hint={t('questsAdminPage.help.audience')}
            />
          </Label>
          <p className="text-xs text-muted-foreground">{t('questsAdminPage.audience.hint')}</p>
        </div>
        <FilterChipGroup
          label={t('questsAdminPage.audience.subscription')}
          options={SUB_BUCKETS.map((v) => ({ value: v, label: t(`questsAdminPage.audience.sub.${v}`) }))}
          selected={draft.subBuckets}
          onToggle={(v) => set('subBuckets', toggleIn(draft.subBuckets, v))}
        />
        <FilterChipGroup
          label={t('questsAdminPage.audience.platform')}
          options={PLATFORM_OPTS.map((v) => ({
            value: v,
            label: t(`questsAdminPage.audience.platforms.${v}`),
          }))}
          selected={draft.platforms}
          onToggle={(v) => set('platforms', toggleIn(draft.platforms, v))}
        />
        <FilterChipGroup
          label={t('questsAdminPage.audience.contact')}
          options={CONTACT_OPTS.map((v) => ({
            value: v,
            label: t(`questsAdminPage.audience.contacts.${v}`),
          }))}
          selected={draft.contactFilters}
          onToggle={(v) => set('contactFilters', toggleIn(draft.contactFilters, v))}
        />
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-muted-foreground">
            {t('questsAdminPage.audience.inactiveDays')}
          </Label>
          <Input
            type="number"
            min={1}
            value={draft.inactiveDays}
            onChange={(e) => set('inactiveDays', e.target.value)}
            placeholder={t('questsAdminPage.audience.inactiveDaysPlaceholder')}
            className="max-w-[160px]"
          />
        </div>
      </div>

      {/* Window */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>{t('questsAdminPage.form.startAt')}</Label>
          <Input
            type="datetime-local"
            value={draft.startAt}
            onChange={(e) => set('startAt', e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>{t('questsAdminPage.form.endAt')}</Label>
          <Input
            type="datetime-local"
            value={draft.endAt}
            onChange={(e) => set('endAt', e.target.value)}
          />
          {errors.endAt && <p className="text-xs text-destructive">{errors.endAt}</p>}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>
          <LabelWithHint
            label={t('questsAdminPage.form.maxCompletionsGlobal')}
            hint={t('questsAdminPage.help.maxCompletions')}
          />
        </Label>
        <Input
          type="number"
          min={1}
          value={draft.maxCompletionsGlobal}
          onChange={(e) => set('maxCompletionsGlobal', e.target.value)}
          className="max-w-[200px]"
        />
      </div>

      {/* Enabled */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 p-3">
        <div>
          <Label htmlFor="quest-enabled" className="text-sm font-normal">
            <LabelWithHint
              label={t('questsAdminPage.form.enabled')}
              hint={t('questsAdminPage.help.enabled')}
            />
          </Label>
        </div>
        <Switch
          id="quest-enabled"
          checked={draft.enabled}
          onCheckedChange={(v) => set('enabled', v)}
          aria-label={t('questsAdminPage.form.enabled')}
        />
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {t('questsAdminPage.form.cancel')}
        </Button>
        <Button onClick={submit} disabled={save.isPending}>
          {quest ? t('questsAdminPage.form.save') : t('questsAdminPage.form.create')}
        </Button>
      </DialogFooter>
    </div>
  )
}
