import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Lightbulb, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

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
 * Authoring surface for in-cabinet hints.
 *
 * ── What an operator is actually deciding here ────────────────────────────
 *
 * Not "what to say" so much as "when this is worth interrupting somebody". A
 * hint is a modal over a page the customer opened for their own reasons, so
 * every field on this form exists to narrow when it fires: the surfaces it
 * suits, how long it stays worth showing, and whether it may repeat.
 *
 * ── Why the key matters more than it looks ────────────────────────────────
 *
 * The key IS the binding. A hint keyed `subscription-ready` fires when the
 * cabinet finishes provisioning a purchase; nothing else connects the two, and
 * renaming the key unbinds it. The form says so rather than leaving an operator
 * to discover it.
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
      // message is shown rather than a generic failure.
      const message =
        (error as { response?: { data?: { message?: unknown } } })?.response?.data?.message
      toast.error(typeof message === 'string' ? message : t('userHints.saveFailed'))
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteUserHint(id),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: HINTS_KEY })
      setEditing(null)
      toast.success(t('userHints.deleted', { count: result.deletedDeliveries }))
    },
    onError: () => toast.error(t('userHints.deleteFailed')),
  })

  const vocabulary = vocabQuery.data
  const hints = hintsQuery.data ?? []

  function toggleIn(list: string[] | undefined, value: string): string[] {
    const current = list ?? []
    return current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value]
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <p className="text-sm text-muted-foreground max-w-2xl">{t('userHints.intro')}</p>
        <Button onClick={() => setEditing({ id: null, draft: emptyDraft() })}>
          <Plus className="mr-2 h-4 w-4" />
          {t('userHints.new')}
        </Button>
      </div>

      {hintsQuery.error && (
        <Alert variant="destructive">
          <AlertTitle>{t('userHints.errors.title')}</AlertTitle>
          <AlertDescription>{t('userHints.errors.load')}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Lightbulb className="h-4 w-4" />
              {t('userHints.listTitle')}
            </CardTitle>
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
                <Label htmlFor="hint-key">{t('userHints.fields.key')}</Label>
                <Input
                  id="hint-key"
                  value={editing.draft.key}
                  placeholder="subscription-ready"
                  onChange={(e) =>
                    setEditing({ ...editing, draft: { ...editing.draft, key: e.target.value } })
                  }
                />
                {/* The one field whose meaning is not obvious from its name. */}
                <p className="text-xs text-muted-foreground">{t('userHints.fields.keyHint')}</p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="hint-title-ru">{t('userHints.fields.titleRu')}</Label>
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
                  <Label htmlFor="hint-title-en">{t('userHints.fields.titleEn')}</Label>
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
                  <Label htmlFor="hint-body-ru">{t('userHints.fields.bodyRu')}</Label>
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
                  <Label htmlFor="hint-body-en">{t('userHints.fields.bodyEn')}</Label>
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
                  <Label>{t('userHints.fields.tone')}</Label>
                  <Select
                    value={editing.draft.tone}
                    onValueChange={(value) =>
                      setEditing({
                        ...editing,
                        draft: { ...editing.draft, tone: value as HintTone },
                      })
                    }
                  >
                    <SelectTrigger>
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
                  <Label htmlFor="hint-ttl">{t('userHints.fields.ttlHours')}</Label>
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
                  <p className="text-xs text-muted-foreground">{t('userHints.fields.ttlHint')}</p>
                </div>
              </div>

              {/* ── The button ──────────────────────────────────────────── */}
              <div className="space-y-3 rounded-lg border p-3">
                <div className="space-y-1.5">
                  <Label>{t('userHints.fields.ctaKind')}</Label>
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
                    <SelectTrigger>
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
                      <Label htmlFor="hint-cta-label">{t('userHints.fields.ctaLabelRu')}</Label>
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
                      <Label>{t('userHints.fields.ctaTarget')}</Label>
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
                          <SelectTrigger>
                            <SelectValue placeholder={t('userHints.fields.pickRoute')} />
                          </SelectTrigger>
                          <SelectContent>
                            {/* Chosen, never typed: a free-form path is a link
                                that breaks silently the first time a cabinet
                                route is renamed. */}
                            {(vocabulary?.routes ?? []).map((route) => (
                              <SelectItem key={route} value={route}>
                                {route}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          value={editing.draft.ctaTarget ?? ''}
                          placeholder="https://t.me/your_channel"
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

              {/* ── Where it is worth showing ───────────────────────────── */}
              <div className="space-y-3 rounded-lg border p-3">
                <div>
                  <Label>{t('userHints.fields.surfaces')}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t('userHints.fields.surfacesHint')}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(vocabulary?.surfaces ?? []).map((surface) => (
                    <Button
                      key={surface}
                      type="button"
                      size="sm"
                      variant={
                        editing.draft.surfaces?.includes(surface) ? 'secondary' : 'outline'
                      }
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
                      {t(`userHints.surfaces.${surface}`)}
                    </Button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  {(vocabulary?.formFactors ?? []).map((factor) => (
                    <Button
                      key={factor}
                      type="button"
                      size="sm"
                      variant={
                        editing.draft.formFactors?.includes(factor) ? 'secondary' : 'outline'
                      }
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
                      {t(`userHints.formFactors.${factor}`)}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="hint-group">{t('userHints.fields.groupKey')}</Label>
                  <Input
                    id="hint-group"
                    value={editing.draft.groupKey ?? ''}
                    placeholder="purchase"
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        draft: { ...editing.draft, groupKey: e.target.value },
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('userHints.fields.groupKeyHint')}
                  </p>
                </div>
                <div className="space-y-3 pt-6">
                  <label className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={editing.draft.isActive ?? true}
                      onCheckedChange={(checked) =>
                        setEditing({
                          ...editing,
                          draft: { ...editing.draft, isActive: checked },
                        })
                      }
                    />
                    {t('userHints.fields.isActive')}
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={editing.draft.isRepeatable ?? false}
                      onCheckedChange={(checked) =>
                        setEditing({
                          ...editing,
                          draft: { ...editing.draft, isRepeatable: checked },
                        })
                      }
                    />
                    {t('userHints.fields.isRepeatable')}
                  </label>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <Button
                  disabled={saveMutation.isPending}
                  onClick={() => saveMutation.mutate({ id: editing.id, draft: editing.draft })}
                >
                  {t('userHints.save')}
                </Button>
                <Button variant="ghost" onClick={() => setEditing(null)}>
                  {t('userHints.cancel')}
                </Button>
                {editing.id !== null && (
                  <Button
                    variant="destructive"
                    className="ml-auto"
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
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
