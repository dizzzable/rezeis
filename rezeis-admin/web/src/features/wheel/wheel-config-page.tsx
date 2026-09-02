import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, ArrowDown, ArrowUp, CircleDot, Pencil, Plus, Trash2 } from 'lucide-react'

import { getErrorMessage } from '@/lib/http-errors'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'

import { listKeyPools } from './wheel-keys-api'
import {
  RARITY_COLOR,
  createSector,
  deleteSector,
  getWheel,
  reorderSectors,
  sectorTitle,
  updateSector,
  updateWheelSettings,
  type WheelSector,
  type WheelSectorKind,
  type WheelSectorPayload,
  type WheelRarity,
} from './wheel-config-api'
import { WheelPreview } from './wheel-preview'

const KINDS: readonly WheelSectorKind[] = [
  'NOTHING',
  'POINTS',
  'SPINS',
  'DAYS',
  'TRAFFIC',
  'DISCOUNT',
  'PROMOCODE',
  'KEY',
  'MANUAL',
]

const RARITIES: readonly WheelRarity[] = ['COMMON', 'RARE', 'EPIC', 'LEGENDARY']

/** Kinds whose `amount` is a quantity the operator has to fill in. */
const NEEDS_AMOUNT: ReadonlySet<WheelSectorKind> = new Set<WheelSectorKind>([
  'POINTS',
  'SPINS',
  'DAYS',
  'TRAFFIC',
  'DISCOUNT',
  'PROMOCODE',
])

interface Draft {
  kind: WheelSectorKind
  titleRu: string
  titleEn: string
  rarity: WheelRarity
  weight: string
  amount: string
  keyPoolId: string
  manualInstructions: string
  maxWinsPerUser: string
  maxWinsTotal: string
  enabled: boolean
}

function emptyDraft(): Draft {
  return {
    kind: 'POINTS',
    titleRu: '',
    titleEn: '',
    rarity: 'COMMON',
    weight: '10',
    amount: '0',
    keyPoolId: '',
    manualInstructions: '',
    maxWinsPerUser: '',
    maxWinsTotal: '',
    enabled: false,
  }
}

function toDraft(sector: WheelSector): Draft {
  return {
    kind: sector.kind,
    titleRu: sector.title?.ru ?? '',
    titleEn: sector.title?.en ?? '',
    rarity: sector.rarity,
    weight: String(sector.weight),
    amount: String(sector.amount),
    keyPoolId: sector.keyPoolId ?? '',
    manualInstructions: sector.manualInstructions ?? '',
    maxWinsPerUser: sector.maxWinsPerUser === null ? '' : String(sector.maxWinsPerUser),
    maxWinsTotal: sector.maxWinsTotal === null ? '' : String(sector.maxWinsTotal),
    enabled: sector.enabled,
  }
}

/** An empty box means "no ceiling", which is a null and not a zero. */
function toNumberOrNull(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}

function toPayload(draft: Draft): WheelSectorPayload {
  return {
    kind: draft.kind,
    title: { ru: draft.titleRu.trim(), en: draft.titleEn.trim() || draft.titleRu.trim() },
    rarity: draft.rarity,
    weight: toNumberOrNull(draft.weight) ?? 0,
    amount: toNumberOrNull(draft.amount) ?? 0,
    keyPoolId: draft.kind === 'KEY' && draft.keyPoolId !== '' ? draft.keyPoolId : null,
    manualInstructions:
      draft.kind === 'MANUAL' && draft.manualInstructions.trim() !== ''
        ? draft.manualInstructions.trim()
        : null,
    // The loss sector is exempt from every ceiling by design, so sending one
    // would be refused — and there is no box for it in the form either.
    maxWinsPerUser: draft.kind === 'NOTHING' ? null : toNumberOrNull(draft.maxWinsPerUser),
    maxWinsTotal: draft.kind === 'NOTHING' ? null : toNumberOrNull(draft.maxWinsTotal),
    enabled: draft.enabled,
  }
}

/**
 * The wheel as the operator builds it.
 *
 * Two things on this page do not exist anywhere else: the LIVE percentage
 * beside every weight — derived, so the column cannot fail to total a
 * hundred — and the guard on whether the spins can ever run out. Neither is
 * ever shown to a person spinning.
 */
export default function WheelConfigPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null)
  const [removing, setRemoving] = useState<WheelSector | null>(null)

  const wheel = useQuery({ queryKey: ['admin', 'wheel'], queryFn: getWheel })
  const pools = useQuery({ queryKey: ['admin', 'wheel', 'key-pools'], queryFn: listKeyPools })

  const fail = useCallback(
    (error: unknown) => toast.error(getErrorMessage(error, t('common.error'))),
    [t],
  )
  const applied = useCallback(
    (data: unknown) => {
      queryClient.setQueryData(['admin', 'wheel'], data)
      queryClient.invalidateQueries({ queryKey: ['admin', 'wheel'] })
    },
    [queryClient],
  )

  const save = useMutation({
    mutationFn: ({ id, draft }: { id: string | null; draft: Draft }) =>
      id === null ? createSector(toPayload(draft)) : updateSector(id, toPayload(draft)),
    onSuccess: (data) => {
      applied(data)
      setEditing(null)
      toast.success(t('wheelConfigPage.toast.saved'))
    },
    onError: fail,
  })

  const remove = useMutation({
    mutationFn: (sectorId: string) => deleteSector(sectorId),
    onSuccess: (data) => {
      applied(data)
      setRemoving(null)
      toast.success(t('wheelConfigPage.toast.deleted'))
    },
    onError: (error: unknown) => {
      fail(error)
      setRemoving(null)
    },
  })

  const reorder = useMutation({
    mutationFn: (orderedIds: readonly string[]) => reorderSectors(orderedIds),
    onSuccess: applied,
    onError: fail,
  })

  const settings = useMutation({
    mutationFn: updateWheelSettings,
    onSuccess: (data) => {
      applied(data)
      toast.success(t('wheelConfigPage.toast.settingsSaved'))
    },
    onError: fail,
  })

  const sectors = useMemo(() => wheel.data?.sectors ?? [], [wheel.data])
  const economy = wheel.data?.economy
  const blockers = wheel.data?.blockers ?? []

  const move = (index: number, delta: number) => {
    const next = [...sectors]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    const [moved] = next.splice(index, 1)
    if (moved === undefined) return
    next.splice(target, 0, moved)
    reorder.mutate(next.map((sector) => sector.id))
  }

  if (wheel.isLoading) {
    return <Skeleton className="h-96 w-full" />
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <CircleDot className="h-6 w-6" />
            {t('wheelConfigPage.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('wheelConfigPage.subtitle')}</p>
        </div>
        <Button
          className="gap-1"
          onClick={() => setEditing({ id: null, draft: emptyDraft() })}
        >
          <Plus className="h-4 w-4" />
          {t('wheelConfigPage.actions.newSector')}
        </Button>
      </header>

      {blockers.length > 0 ? (
        <Card className="border-destructive">
          <CardContent className="flex gap-3 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div className="space-y-1 text-sm">
              <p className="font-medium">{t('wheelConfigPage.blockers.title')}</p>
              <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                {blockers.map((blocker) => (
                  <li key={blocker}>
                    {blocker === 'PERPETUAL'
                      ? t('wheelConfigPage.blockers.PERPETUAL', {
                          value: (economy?.spinsReturnedPerSpin ?? 0).toFixed(2),
                        })
                      : t(`wheelConfigPage.blockers.${blocker}`)}
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-4 p-4">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="wheel-enabled" className="text-base">
                  {t('wheelConfigPage.settings.enabled')}
                </Label>
                <Switch
                  id="wheel-enabled"
                  checked={wheel.data?.settings.enabled ?? false}
                  disabled={settings.isPending}
                  onCheckedChange={(checked) => settings.mutate({ enabled: checked })}
                />
              </div>
              <SettingNumber
                id="wheel-cooldown"
                label={t('wheelConfigPage.settings.cooldown')}
                hint={t('wheelConfigPage.settings.cooldownHint')}
                value={wheel.data?.settings.freeSpinCooldownHours ?? null}
                onSave={(value) => settings.mutate({ freeSpinCooldownHours: value })}
              />
              <SettingNumber
                id="wheel-price"
                label={t('wheelConfigPage.settings.price')}
                hint={t('wheelConfigPage.settings.priceHint')}
                value={wheel.data?.settings.spinPricePoints ?? null}
                onSave={(value) => settings.mutate({ spinPricePoints: value })}
              />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 p-4">
              <p className="text-sm font-medium">{t('wheelConfigPage.preview.title')}</p>
              <div className="flex justify-center">
                <WheelPreview sectors={sectors} />
              </div>
              <p className="text-xs text-muted-foreground">
                {t('wheelConfigPage.preview.note')}
              </p>
            </CardContent>
          </Card>

          {economy ? (
            <Card>
              <CardContent className="space-y-2 p-4 text-sm">
                <p className="font-medium">{t('wheelConfigPage.economy.title')}</p>
                <p className="text-muted-foreground">
                  {t('wheelConfigPage.economy.returned', {
                    value: economy.spinsReturnedPerSpin.toFixed(2),
                  })}
                </p>
                <p className={economy.generous ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>
                  {economy.expectedTotalSpins === null
                    ? t('wheelConfigPage.economy.never')
                    : t('wheelConfigPage.economy.total', {
                        value: economy.expectedTotalSpins.toFixed(1),
                      })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('wheelConfigPage.economy.spins', {
                    total: wheel.data?.spins.total ?? 0,
                    pending: wheel.data?.spins.pending ?? 0,
                  })}
                </p>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <Card>
          <CardContent className="p-0">
            {sectors.length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">
                {t('wheelConfigPage.empty')}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-24">{t('wheelConfigPage.columns.order')}</TableHead>
                    <TableHead>{t('wheelConfigPage.columns.sector')}</TableHead>
                    <TableHead className="text-right">
                      {t('wheelConfigPage.columns.weight')}
                    </TableHead>
                    <TableHead className="text-right">
                      {t('wheelConfigPage.columns.chance')}
                    </TableHead>
                    <TableHead>{t('wheelConfigPage.columns.limits')}</TableHead>
                    <TableHead className="text-right">
                      {t('wheelConfigPage.columns.actions')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sectors.map((sector, index) => (
                    <TableRow key={sector.id} className={sector.enabled ? '' : 'opacity-60'}>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('wheelConfigPage.actions.moveUp')}
                            disabled={index === 0 || reorder.isPending}
                            onClick={() => move(index, -1)}
                          >
                            <ArrowUp className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('wheelConfigPage.actions.moveDown')}
                            disabled={index === sectors.length - 1 || reorder.isPending}
                            onClick={() => move(index, 1)}
                          >
                            <ArrowDown className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span
                            aria-hidden
                            className="h-3 w-3 shrink-0 rounded-full"
                            style={{ backgroundColor: RARITY_COLOR[sector.rarity] }}
                          />
                          <div>
                            <div className="font-medium">
                              {sectorTitle(sector, t('wheelConfigPage.unnamed'))}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {t(`wheelConfigPage.kinds.${sector.kind}`)}
                              {NEEDS_AMOUNT.has(sector.kind) ? ` · ${sector.amount}` : ''}
                              {sector.keysAvailable !== null
                                ? ` · ${t('wheelConfigPage.keysLeft', { count: sector.keysAvailable })}`
                                : ''}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{sector.weight}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {sector.enabled && sector.weight > 0
                          ? `${sector.chancePercent.toFixed(sector.chancePercent < 10 ? 1 : 0)} %`
                          : '—'}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {sector.maxWinsPerUser !== null
                          ? t('wheelConfigPage.perUser', { count: sector.maxWinsPerUser })
                          : null}
                        {sector.maxWinsTotal !== null ? (
                          <div>
                            {t('wheelConfigPage.total', {
                              won: sector.wonCount,
                              max: sector.maxWinsTotal,
                            })}
                          </div>
                        ) : null}
                        {!sector.enabled ? (
                          <Badge variant="secondary">{t('wheelConfigPage.disabled')}</Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('wheelConfigPage.actions.edit')}
                            onClick={() => setEditing({ id: sector.id, draft: toDraft(sector) })}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('wheelConfigPage.actions.delete')}
                            onClick={() => setRemoving(sector)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={editing !== null} onOpenChange={(open) => (open ? undefined : setEditing(null))}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing?.id === null
                ? t('wheelConfigPage.actions.newSector')
                : t('wheelConfigPage.actions.edit')}
            </DialogTitle>
          </DialogHeader>
          {editing !== null ? (
            <SectorForm
              draft={editing.draft}
              pools={(pools.data ?? []).map((pool) => ({
                id: pool.id,
                name: pool.name,
                available: pool.available,
              }))}
              onChange={(draft) => setEditing({ id: editing.id, draft })}
            />
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={save.isPending || (editing?.draft.titleRu.trim() ?? '') === ''}
              onClick={() => {
                if (editing !== null) save.mutate(editing)
              }}
            >
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('wheelConfigPage.deleteDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('wheelConfigPage.deleteDialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (removing !== null) remove.mutate(removing.id)
              }}
            >
              {t('wheelConfigPage.actions.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * A number that is saved when the operator leaves the box.
 *
 * An empty box is `null` — "off" for the cooldown, "cannot be bought" for the
 * price — which is a different thing from zero and is why this is not a plain
 * number input bound to a mutation.
 */
function SettingNumber({
  id,
  label,
  hint,
  value,
  onSave,
}: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly value: number | null
  readonly onSave: (value: number | null) => void
}) {
  const [text, setText] = useState(value === null ? '' : String(value))
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="numeric"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => onSave(toNumberOrNull(text))}
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

function SectorForm({
  draft,
  pools,
  onChange,
}: {
  readonly draft: Draft
  readonly pools: ReadonlyArray<{ id: string; name: string; available: number }>
  readonly onChange: (draft: Draft) => void
}) {
  const { t } = useTranslation()
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => onChange({ ...draft, [key]: value })

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>{t('wheelConfigPage.form.kind')}</Label>
          <Select value={draft.kind} onValueChange={(value) => set('kind', value as WheelSectorKind)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {t(`wheelConfigPage.kinds.${kind}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>{t('wheelConfigPage.form.rarity')}</Label>
          <Select value={draft.rarity} onValueChange={(value) => set('rarity', value as WheelRarity)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RARITIES.map((rarity) => (
                <SelectItem key={rarity} value={rarity}>
                  {t(`wheelConfigPage.rarities.${rarity}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="sector-title-ru">{t('wheelConfigPage.form.titleRu')}</Label>
          <Input
            id="sector-title-ru"
            value={draft.titleRu}
            onChange={(event) => set('titleRu', event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sector-title-en">{t('wheelConfigPage.form.titleEn')}</Label>
          <Input
            id="sector-title-en"
            value={draft.titleEn}
            onChange={(event) => set('titleEn', event.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="sector-weight">{t('wheelConfigPage.form.weight')}</Label>
          <Input
            id="sector-weight"
            inputMode="numeric"
            value={draft.weight}
            onChange={(event) => set('weight', event.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('wheelConfigPage.form.weightHint')}</p>
        </div>
        {NEEDS_AMOUNT.has(draft.kind) ? (
          <div className="space-y-1.5">
            <Label htmlFor="sector-amount">{t(`wheelConfigPage.amountLabel.${draft.kind}`)}</Label>
            <Input
              id="sector-amount"
              inputMode="numeric"
              value={draft.amount}
              onChange={(event) => set('amount', event.target.value)}
            />
          </div>
        ) : null}
      </div>

      {draft.kind === 'KEY' ? (
        <div className="space-y-1.5">
          <Label>{t('wheelConfigPage.form.pool')}</Label>
          <Select value={draft.keyPoolId} onValueChange={(value) => set('keyPoolId', value)}>
            <SelectTrigger>
              <SelectValue placeholder={t('wheelConfigPage.form.poolPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {pools.map((pool) => (
                <SelectItem key={pool.id} value={pool.id}>
                  {pool.name} · {t('wheelConfigPage.keysLeft', { count: pool.available })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {draft.kind === 'MANUAL' ? (
        <div className="space-y-1.5">
          <Label htmlFor="sector-instructions">{t('wheelConfigPage.form.instructions')}</Label>
          <Textarea
            id="sector-instructions"
            rows={3}
            value={draft.manualInstructions}
            onChange={(event) => set('manualInstructions', event.target.value)}
            placeholder={t('wheelConfigPage.form.instructionsPlaceholder')}
          />
          <p className="text-xs text-muted-foreground">
            {t('wheelConfigPage.form.instructionsHint')}
          </p>
        </div>
      ) : null}

      {draft.kind !== 'NOTHING' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="sector-per-user">{t('wheelConfigPage.form.perUser')}</Label>
            <Input
              id="sector-per-user"
              inputMode="numeric"
              value={draft.maxWinsPerUser}
              placeholder={t('wheelConfigPage.form.noLimit')}
              onChange={(event) => set('maxWinsPerUser', event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sector-total">{t('wheelConfigPage.form.totalLimit')}</Label>
            <Input
              id="sector-total"
              inputMode="numeric"
              value={draft.maxWinsTotal}
              placeholder={t('wheelConfigPage.form.noLimit')}
              onChange={(event) => set('maxWinsTotal', event.target.value)}
            />
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t('wheelConfigPage.form.lossNoLimits')}</p>
      )}

      <div className="flex items-center justify-between gap-3 pt-2">
        <Label htmlFor="sector-enabled">{t('wheelConfigPage.form.enabled')}</Label>
        <Switch
          id="sector-enabled"
          checked={draft.enabled}
          onCheckedChange={(checked) => set('enabled', checked)}
        />
      </div>
    </div>
  )
}
