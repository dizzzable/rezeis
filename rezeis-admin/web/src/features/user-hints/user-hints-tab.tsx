import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { Lightbulb, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { InfoTip, LabelWithInfo } from '@/components/ui/info-tip'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { translateApiError } from '@/lib/translate-error'
import { cn } from '@/lib/utils'

import { ActionTip } from './action-tip'
import { HintReachPanel } from './hint-reach-panel'
import {
  createUserHint,
  deleteUserHint,
  getHintVocabulary,
  listUserHints,
  updateUserHint,
  type HintCtaKind,
  type HintTone,
  type UpsertUserHintInput,
  type UserHint,
} from './user-hints-api'

const HINTS_KEY = ['admin', 'user-hints'] as const
const VOCAB_KEY = ['admin', 'user-hints', 'vocabulary'] as const

const TONES: HintTone[] = ['INFO', 'SUCCESS', 'WARNING', 'DANGER']
const CTA_KINDS: HintCtaKind[] = ['NONE', 'ROUTE', 'EXTERNAL']

/** The colour register each tone stands for, as the cabinet draws it. */
const TONE_SWATCH: Record<HintTone, string> = {
  INFO: 'bg-blue-500',
  SUCCESS: 'bg-emerald-500',
  WARNING: 'bg-amber-500',
  DANGER: 'bg-rose-500',
}

function emptyDraft(): UpsertUserHintInput {
  return {
    key: '',
    titleRu: '',
    bodyRu: '',
    mode: 'MODAL',
    tone: 'INFO',
    ctaKind: 'NONE',
    surfaces: [],
    formFactors: [],
    ttlHours: 168,
    isRepeatable: false,
    isActive: true,
  }
}

function toDraft(hint: UserHint): UpsertUserHintInput {
  return {
    key: hint.key,
    titleRu: hint.titleRu,
    bodyRu: hint.bodyRu,
    titleEn: hint.titleEn ?? '',
    bodyEn: hint.bodyEn ?? '',
    mode: hint.mode,
    tone: hint.tone,
    ctaKind: hint.ctaKind,
    ctaLabelRu: hint.ctaLabelRu ?? '',
    ctaLabelEn: hint.ctaLabelEn ?? '',
    ctaTarget: hint.ctaTarget ?? '',
    surfaces: hint.surfaces,
    formFactors: hint.formFactors,
    groupKey: hint.groupKey ?? '',
    ttlHours: hint.ttlHours,
    isRepeatable: hint.isRepeatable,
    isActive: hint.isActive,
  }
}

/**
 * A button target in the operator's words.
 *
 * A path reads as itself. A DOOR — `@connect`, a place the cabinet resolves on
 * its own (`HINT_DOOR_TARGETS` on the server) — is named: the raw string means
 * nothing to an operator, and one this panel has no name for still gets words
 * rather than the string.
 */
function routeTargetLabel(t: TFunction, route: string): string {
  if (!route.startsWith('@')) return route
  const named = String(t(`userHints.doors.${route.slice(1)}`, { defaultValue: '' }))
  return named.length > 0 ? named : String(t('userHints.doors.unknown'))
}

/**
 * Authoring surface for in-cabinet hints.
 *
 * ── What an operator is actually deciding here ────────────────────────────
 *
 * Not "what to say" so much as "when this is worth interrupting somebody". A
 * hint is a modal over a page the customer opened for their own reasons, so
 * every field on this form exists to narrow when it fires: the surfaces it
 * suits, how long it stays worth showing, and whether it may repeat.
 *
 * ── What it does NOT decide, and why that is on screen ────────────────────
 *
 * WHOM. A hint is queued for whoever the event of the rule calling it names,
 * and «Где показывать» only limits where the cabinet may draw it. The owner
 * read the second as the first — «Браузер» on a welcome bound to the Telegram
 * sign-up — and every delivery lapsed unseen. «Кто увидит» computes the first
 * answer beside the second, from the rules and the draft.
 *
 * ── Why the explanations are behind (i)s ──────────────────────────────────
 *
 * The panel's rule: visible text is for labels, live status and warnings;
 * how a setting works is one hover (or tap) away, and every button says what
 * pressing it does before it is pressed.
 */
export function UserHintsTab() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<{ id: string | null; draft: UpsertUserHintInput } | null>(
    null,
  )

  const hintsQuery = useQuery({ queryKey: HINTS_KEY, queryFn: listUserHints })
  const vocabQuery = useQuery({
    queryKey: VOCAB_KEY,
    queryFn: getHintVocabulary,
    staleTime: 10 * 60 * 1000,
  })

  const saveMutation = useMutation({
    mutationFn: (input: { id: string | null; draft: UpsertUserHintInput }) =>
      input.id === null ? createUserHint(input.draft) : updateUserHint(input.id, input.draft),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: HINTS_KEY })
      setEditing(null)
      toast.success(t('userHints.saved'))
    },
    onError: (error: unknown) => {
      // The server refuses a route that is not on its own list and a key that
      // already exists, and both are things the operator can fix — so its
      // sentence is shown, in the operator's language where the dictionary has
      // it. Reading `response.data.message` by hand showed the raw English and
      // dropped a validation refusal altogether: that one is an ARRAY, one line
      // per field, and a `typeof === 'string'` check replaced the whole
      // diagnosis with "could not save".
      toast.error(t('userHints.saveFailed', { message: translateApiError(t, error) }))
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteUserHint(id),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: HINTS_KEY })
      setEditing(null)
      toast.success(t('userHints.deleted', { count: result.deletedDeliveries }))
    },
    // The server's reason, the same way as a failed save: a hint deleted in
    // another tab answers "not found", a role without the grant answers with the
    // permission it lacks, and a dead host is not a refusal at all.
    onError: (error: unknown) =>
      toast.error(t('userHints.deleteFailed', { message: translateApiError(t, error) })),
  })

  const vocabulary = vocabQuery.data
  const hints = hintsQuery.data ?? []

  /** «Подробнее: <поле>» — the accessible name of a field's (i). */
  const infoLabel = (subject: string): string => t('automationsPage.infoAria', { subject })

  function toggleIn(list: string[] | undefined, value: string): string[] {
    const current = list ?? []
    return current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value]
  }

  // The key as SAVED, so «Кто увидит» can tell a rename from a new key.
  const savedKey =
    editing === null || editing.id === null
      ? null
      : (hints.find((hint) => hint.id === editing.id)?.key ?? null)
  // Every OTHER hint's key: a draft typed onto one of them is not a new hint
  // with that hint's rules, it is a conflict the save will refuse.
  const otherKeys = hints.filter((hint) => hint.id !== editing?.id).map((hint) => hint.key)

  return (
    <div className="space-y-4">
      {hintsQuery.error && (
        <Alert variant="destructive">
          <AlertTitle>{t('userHints.errors.title')}</AlertTitle>
          <AlertDescription>{t('userHints.errors.load')}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <Card>
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
            <div className="flex items-center gap-1.5">
              <CardTitle className="text-base flex items-center gap-2">
                <Lightbulb className="h-4 w-4" />
                {t('userHints.listTitle')}
              </CardTitle>
              <InfoTip label={infoLabel(t('userHints.listTitle'))}>{t('userHints.intro')}</InfoTip>
            </div>
            <ActionTip tip={t('userHints.tips.new')}>
              <Button size="sm" onClick={() => setEditing({ id: null, draft: emptyDraft() })}>
                <Plus className="mr-2 h-4 w-4" />
                {t('userHints.new')}
              </Button>
            </ActionTip>
          </CardHeader>
          <CardContent className="space-y-1">
            {hints.length === 0 && (
              <p className="text-sm text-muted-foreground py-4">{t('userHints.empty')}</p>
            )}
            {hints.map((hint) => (
              <button
                key={hint.id}
                type="button"
                onClick={() => setEditing({ id: hint.id, draft: toDraft(hint) })}
                className={cn(
                  'w-full rounded-lg border p-2 text-left transition-colors hover:bg-muted',
                  editing?.id === hint.id && 'bg-muted',
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn('h-2 w-2 shrink-0 rounded-full', TONE_SWATCH[hint.tone])}
                    aria-hidden
                  />
                  <span className="truncate text-sm font-medium">{hint.titleRu}</span>
                  {!hint.isActive && (
                    <Badge variant="outline" className="ml-auto shrink-0 text-xs">
                      {t('userHints.off')}
                    </Badge>
                  )}
                </div>
                <code className="text-xs text-muted-foreground">{hint.key}</code>
              </button>
            ))}
          </CardContent>
        </Card>

        {editing === null ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              {t('userHints.pickOne')}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">
                {editing.id === null ? t('userHints.new') : t('userHints.editing')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <LabelWithInfo
                  htmlFor="hint-key"
                  info={t('userHints.fields.keyHint')}
                  infoLabel={infoLabel(t('userHints.fields.key'))}
                >
                  {t('userHints.fields.key')}
                </LabelWithInfo>
                <Input
                  id="hint-key"
                  value={editing.draft.key}
                  placeholder={t('userHints.fields.keyPlaceholder')}
                  onChange={(e) =>
                    setEditing({ ...editing, draft: { ...editing.draft, key: e.target.value } })
                  }
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <LabelWithInfo
                    htmlFor="hint-title-ru"
                    info={t('userHints.fields.titleHint')}
                    infoLabel={infoLabel(t('userHints.fields.titleRu'))}
                  >
                    {t('userHints.fields.titleRu')}
                  </LabelWithInfo>
                  <Input
                    id="hint-title-ru"
                    value={editing.draft.titleRu}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        draft: { ...editing.draft, titleRu: e.target.value },
                      })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <LabelWithInfo
                    htmlFor="hint-title-en"
                    info={t('userHints.fields.titleHint')}
                    infoLabel={infoLabel(t('userHints.fields.titleEn'))}
                  >
                    {t('userHints.fields.titleEn')}
                  </LabelWithInfo>
                  <Input
                    id="hint-title-en"
                    value={editing.draft.titleEn ?? ''}
                    placeholder={t('userHints.fields.fallsBackToRu')}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        draft: { ...editing.draft, titleEn: e.target.value },
                      })
                    }
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <LabelWithInfo
                    htmlFor="hint-body-ru"
                    info={t('userHints.fields.bodyHint')}
                    infoLabel={infoLabel(t('userHints.fields.bodyRu'))}
                  >
                    {t('userHints.fields.bodyRu')}
                  </LabelWithInfo>
                  <Textarea
                    id="hint-body-ru"
                    rows={4}
                    value={editing.draft.bodyRu}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        draft: { ...editing.draft, bodyRu: e.target.value },
                      })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <LabelWithInfo
                    htmlFor="hint-body-en"
                    info={t('userHints.fields.bodyHint')}
                    infoLabel={infoLabel(t('userHints.fields.bodyEn'))}
                  >
                    {t('userHints.fields.bodyEn')}
                  </LabelWithInfo>
                  <Textarea
                    id="hint-body-en"
                    rows={4}
                    value={editing.draft.bodyEn ?? ''}
                    placeholder={t('userHints.fields.fallsBackToRu')}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        draft: { ...editing.draft, bodyEn: e.target.value },
                      })
                    }
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <LabelWithInfo
                    htmlFor="hint-tone"
                    info={t('userHints.fields.toneHint')}
                    infoLabel={infoLabel(t('userHints.fields.tone'))}
                  >
                    {t('userHints.fields.tone')}
                  </LabelWithInfo>
                  <Select
                    value={editing.draft.tone}
                    onValueChange={(value) =>
                      setEditing({
                        ...editing,
                        draft: { ...editing.draft, tone: value as HintTone },
                      })
                    }
                  >
                    <SelectTrigger id="hint-tone">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TONES.map((tone) => (
                        <SelectItem key={tone} value={tone}>
                          {t(`userHints.tones.${tone}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <LabelWithInfo
                    htmlFor="hint-ttl"
                    info={t('userHints.fields.ttlHint')}
                    infoLabel={infoLabel(t('userHints.fields.ttlHours'))}
                  >
                    {t('userHints.fields.ttlHours')}
                  </LabelWithInfo>
                  <Input
                    id="hint-ttl"
                    type="number"
                    min={1}
                    max={24 * 90}
                    value={editing.draft.ttlHours ?? 168}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        draft: { ...editing.draft, ttlHours: Number(e.target.value) },
                      })
                    }
                  />
                </div>
              </div>

              {/* ── The button ──────────────────────────────────────────── */}
              <div className="space-y-3 rounded-lg border p-3">
                <div className="space-y-1.5">
                  <LabelWithInfo
                    htmlFor="hint-cta-kind"
                    info={t('userHints.fields.ctaKindHint')}
                    infoLabel={infoLabel(t('userHints.fields.ctaKind'))}
                  >
                    {t('userHints.fields.ctaKind')}
                  </LabelWithInfo>
                  <Select
                    value={editing.draft.ctaKind}
                    onValueChange={(value) =>
                      setEditing({
                        ...editing,
                        draft: {
                          ...editing.draft,
                          ctaKind: value as HintCtaKind,
                          // The target means a different thing per kind, so it
                          // is cleared rather than carried across: a route left
                          // in an external field would fail validation with a
                          // message about a value the operator cannot see.
                          ctaTarget: '',
                        },
                      })
                    }
                  >
                    <SelectTrigger id="hint-cta-kind">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CTA_KINDS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {t(`userHints.ctaKinds.${kind}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {editing.draft.ctaKind !== 'NONE' && (
                  <>
                    <div className="space-y-1.5">
                      <LabelWithInfo
                        htmlFor="hint-cta-label"
                        info={t('userHints.fields.ctaLabelHint')}
                        infoLabel={infoLabel(t('userHints.fields.ctaLabelRu'))}
                      >
                        {t('userHints.fields.ctaLabelRu')}
                      </LabelWithInfo>
                      <Input
                        id="hint-cta-label"
                        value={editing.draft.ctaLabelRu ?? ''}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            draft: { ...editing.draft, ctaLabelRu: e.target.value },
                          })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <LabelWithInfo
                        htmlFor="hint-cta-target"
                        info={t('userHints.fields.ctaTargetHint')}
                        infoLabel={infoLabel(t('userHints.fields.ctaTarget'))}
                      >
                        {t('userHints.fields.ctaTarget')}
                      </LabelWithInfo>
                      {editing.draft.ctaKind === 'ROUTE' ? (
                        <Select
                          value={editing.draft.ctaTarget ?? ''}
                          onValueChange={(value) =>
                            setEditing({
                              ...editing,
                              draft: { ...editing.draft, ctaTarget: value },
                            })
                          }
                        >
                          <SelectTrigger id="hint-cta-target">
                            <SelectValue placeholder={t('userHints.fields.pickRoute')} />
                          </SelectTrigger>
                          <SelectContent>
                            {/* Chosen, never typed: a free-form path is a link
                                that breaks silently the first time a cabinet
                                route is renamed. */}
                            {(vocabulary?.routes ?? []).map((route) => (
                              <SelectItem key={route} value={route}>
                                {routeTargetLabel(t, route)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          id="hint-cta-target"
                          value={editing.draft.ctaTarget ?? ''}
                          placeholder={t('userHints.fields.externalPlaceholder')}
                          onChange={(e) =>
                            setEditing({
                              ...editing,
                              draft: { ...editing.draft, ctaTarget: e.target.value },
                            })
                          }
                        />
                      )}
                    </div>
                  </>
                )}
              </div>

              {/* ── Whom it reaches — decided by the rules, not by this form ── */}
              <HintReachPanel
                draftKey={editing.draft.key}
                savedKey={savedKey}
                otherKeys={otherKeys}
                surfaces={editing.draft.surfaces ?? []}
                isActive={editing.draft.isActive ?? true}
                ttlHours={editing.draft.ttlHours ?? 168}
              />

              {/* ── Where it may be drawn ───────────────────────────────── */}
              <div className="space-y-3 rounded-lg border p-3">
                <div className="space-y-2">
                  <LabelWithInfo
                    info={t('userHints.fields.surfacesHint')}
                    infoLabel={infoLabel(t('userHints.fields.surfaces'))}
                  >
                    {t('userHints.fields.surfaces')}
                  </LabelWithInfo>
                  <div
                    role="group"
                    aria-label={t('userHints.fields.surfaces')}
                    className="flex flex-wrap gap-2"
                  >
                    {(vocabulary?.surfaces ?? []).map((surface) => {
                      const on = editing.draft.surfaces?.includes(surface) ?? false
                      const name = t(`userHints.surfaces.${surface}`)
                      return (
                        <ActionTip
                          key={surface}
                          tip={t(on ? 'userHints.tips.surfaceOn' : 'userHints.tips.surfaceOff', {
                            name,
                          })}
                        >
                          <Button
                            type="button"
                            size="sm"
                            variant={on ? 'secondary' : 'outline'}
                            aria-pressed={on}
                            onClick={() =>
                              setEditing({
                                ...editing,
                                draft: {
                                  ...editing.draft,
                                  surfaces: toggleIn(editing.draft.surfaces, surface),
                                },
                              })
                            }
                          >
                            {name}
                          </Button>
                        </ActionTip>
                      )
                    })}
                  </div>
                </div>
                <div className="space-y-2">
                  <LabelWithInfo
                    info={t('userHints.fields.formFactorsHint')}
                    infoLabel={infoLabel(t('userHints.fields.formFactors'))}
                  >
                    {t('userHints.fields.formFactors')}
                  </LabelWithInfo>
                  <div
                    role="group"
                    aria-label={t('userHints.fields.formFactors')}
                    className="flex flex-wrap gap-2"
                  >
                    {(vocabulary?.formFactors ?? []).map((factor) => {
                      const on = editing.draft.formFactors?.includes(factor) ?? false
                      const name = t(`userHints.formFactors.${factor}`)
                      return (
                        <ActionTip
                          key={factor}
                          tip={t(
                            on ? 'userHints.tips.formFactorOn' : 'userHints.tips.formFactorOff',
                            { name },
                          )}
                        >
                          <Button
                            type="button"
                            size="sm"
                            variant={on ? 'secondary' : 'outline'}
                            aria-pressed={on}
                            onClick={() =>
                              setEditing({
                                ...editing,
                                draft: {
                                  ...editing.draft,
                                  formFactors: toggleIn(editing.draft.formFactors, factor),
                                },
                              })
                            }
                          >
                            {name}
                          </Button>
                        </ActionTip>
                      )
                    })}
                  </div>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <LabelWithInfo
                    htmlFor="hint-group"
                    info={t('userHints.fields.groupKeyHint')}
                    infoLabel={infoLabel(t('userHints.fields.groupKey'))}
                  >
                    {t('userHints.fields.groupKey')}
                  </LabelWithInfo>
                  <Input
                    id="hint-group"
                    value={editing.draft.groupKey ?? ''}
                    placeholder={t('userHints.fields.groupKeyPlaceholder')}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        draft: { ...editing.draft, groupKey: e.target.value },
                      })
                    }
                  />
                </div>
                <div className="space-y-3 pt-6">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="hint-active"
                      checked={editing.draft.isActive ?? true}
                      onCheckedChange={(checked) =>
                        setEditing({
                          ...editing,
                          draft: { ...editing.draft, isActive: checked },
                        })
                      }
                    />
                    <LabelWithInfo
                      htmlFor="hint-active"
                      info={t('userHints.fields.isActiveHint')}
                      infoLabel={infoLabel(t('userHints.fields.isActive'))}
                    >
                      {t('userHints.fields.isActive')}
                    </LabelWithInfo>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="hint-repeatable"
                      checked={editing.draft.isRepeatable ?? false}
                      onCheckedChange={(checked) =>
                        setEditing({
                          ...editing,
                          draft: { ...editing.draft, isRepeatable: checked },
                        })
                      }
                    />
                    <LabelWithInfo
                      htmlFor="hint-repeatable"
                      info={t('userHints.fields.isRepeatableHint')}
                      infoLabel={infoLabel(t('userHints.fields.isRepeatable'))}
                    >
                      {t('userHints.fields.isRepeatable')}
                    </LabelWithInfo>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <ActionTip
                  tip={t(editing.id === null ? 'userHints.tips.saveNew' : 'userHints.tips.saveExisting')}
                  disabled={saveMutation.isPending}
                >
                  <Button
                    disabled={saveMutation.isPending}
                    onClick={() => saveMutation.mutate({ id: editing.id, draft: editing.draft })}
                  >
                    {t('userHints.save')}
                  </Button>
                </ActionTip>
                <ActionTip tip={t('userHints.tips.cancel')}>
                  <Button variant="ghost" onClick={() => setEditing(null)}>
                    {t('userHints.cancel')}
                  </Button>
                </ActionTip>
                {editing.id !== null && (
                  <div className="ml-auto">
                    <ActionTip tip={t('userHints.tips.delete')} disabled={deleteMutation.isPending}>
                      <Button
                        variant="destructive"
                        disabled={deleteMutation.isPending}
                        onClick={() => {
                          // Deleting destroys the record of who was shown it, which
                          // switching it off does not — so the confirmation says so.
                          if (!window.confirm(t('userHints.deleteConfirm'))) return
                          deleteMutation.mutate(editing.id as string)
                        }}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        {t('userHints.delete')}
                      </Button>
                    </ActionTip>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
