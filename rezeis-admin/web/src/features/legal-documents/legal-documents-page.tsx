/**
 * Legal documents editor.
 *
 * Two fixed documents, each with its own switch and its own Russian and
 * English text. There is no create and no delete — a third document is a
 * migration, not a click.
 *
 * Two behaviours here exist because of how this feature fails rather than how
 * it works:
 *
 *  - The switch is disabled while the Russian body is empty, and says why. The
 *    server refuses the same combination, but a rejected save on a settings
 *    page reads as "saving is broken"; the reason belongs next to the control.
 *  - An active document with no English text gets a visible warning. It still
 *    works — an English reader is served the Russian wording rather than a
 *    blank page — but silently showing Russian to someone who picked English
 *    is the kind of thing nobody notices until a user asks about it.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, FileText, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { FadeIn } from '@/lib/motion'

import {
  LEGAL_DOCUMENT_BODY_MAX,
  LEGAL_DOCUMENT_QUERY_KEYS,
  LEGAL_DOCUMENT_TITLE_MAX,
  legalDocumentsApi,
  type LegalDocument,
  type LegalDocumentKey,
} from './legal-documents-api'

interface DraftState {
  isActive: boolean
  titleRu: string
  titleEn: string
  bodyRu: string
  bodyEn: string
}

function toDraft(document: LegalDocument): DraftState {
  return {
    isActive: document.isActive,
    titleRu: document.titleRu,
    titleEn: document.titleEn,
    bodyRu: document.bodyRu,
    bodyEn: document.bodyEn,
  }
}

export default function LegalDocumentsPage() {
  const { t } = useTranslation()

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: LEGAL_DOCUMENT_QUERY_KEYS.all,
    queryFn: () => legalDocumentsApi.list(),
  })

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  // Without this branch a failed load renders the header over nothing at all,
  // which reads as "the operator has no documents" — the one thing this page
  // must never imply, since it is what decides whether sign-up asks for
  // consent. The query client retries nothing, so the retry has to be offered.
  if (isError) {
    return (
      <FadeIn className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('legalDocumentsPage.title')}</h1>
        </div>
        <Card>
          <CardContent className="flex flex-col items-start gap-3 pt-6">
            <p className="text-sm">{t('legalDocumentsPage.loadFailed')}</p>
            <Button variant="outline" onClick={() => void refetch()}>
              {t('legalDocumentsPage.retry')}
            </Button>
          </CardContent>
        </Card>
      </FadeIn>
    )
  }

  return (
    <FadeIn className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('legalDocumentsPage.title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('legalDocumentsPage.subtitle')}</p>
      </div>
      {(data ?? []).map((document) => (
        <LegalDocumentCard key={document.key} document={document} />
      ))}
    </FadeIn>
  )
}

function LegalDocumentCard({ document }: { readonly document: LegalDocument }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<DraftState>(() => toDraft(document))

  useEffect(() => {
    // Re-seed the editor when the server sends a newer copy (after a save, or
    // when another operator edited it). Sanctioned "sync external data into
    // local editable state" case.
    /* eslint-disable react-hooks/set-state-in-effect -- editor state mirrors the fetched document */
    setDraft(toDraft(document))
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [document])

  const mutation = useMutation({
    mutationFn: (payload: DraftState) => legalDocumentsApi.update(document.key, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: LEGAL_DOCUMENT_QUERY_KEYS.all })
      toast.success(t('legalDocumentsPage.saved'))
    },
    onError: () => toast.error(t('legalDocumentsPage.saveFailed')),
  })

  // Mirrors the server rule exactly. The title is the checkbox label at
  // sign-up; enabling a document without one asks the visitor to accept
  // something unnamed.
  const isPublishable =
    draft.bodyRu.trim().length > 0 && draft.titleRu.trim().length > 0
  const missingTranslation = draft.isActive && draft.bodyEn.trim().length === 0
  const dirty =
    draft.isActive !== document.isActive ||
    draft.titleRu !== document.titleRu ||
    draft.titleEn !== document.titleEn ||
    draft.bodyRu !== document.bodyRu ||
    draft.bodyEn !== document.bodyEn

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            <FileText className="size-4" aria-hidden />
            {t(`legalDocumentsPage.documents.${documentSlug(document.key)}.title`)}
          </CardTitle>
          <CardDescription>
            {t(`legalDocumentsPage.documents.${documentSlug(document.key)}.description`)}
          </CardDescription>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            <Label htmlFor={`active-${document.key}`} className="text-sm">
              {t('legalDocumentsPage.required')}
            </Label>
            <Switch
              id={`active-${document.key}`}
              checked={draft.isActive}
              // Turning this on without a body would be refused by the server.
              // Refusing here instead keeps the reason next to the cause.
              disabled={!isPublishable}
              onCheckedChange={(isActive) => setDraft((prev) => ({ ...prev, isActive }))}
            />
          </div>
          {!isPublishable && (
            <p className="text-muted-foreground max-w-56 text-right text-xs">
              {t('legalDocumentsPage.needsRussianBody')}
            </p>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {missingTranslation && (
          <div className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 flex items-start gap-2 rounded-md border p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{t('legalDocumentsPage.missingTranslation')}</span>
          </div>
        )}

        <div className="grid gap-6 md:grid-cols-2">
          <LocaleFields
            locale="ru"
            title={draft.titleRu}
            body={draft.bodyRu}
            onTitleChange={(titleRu) => setDraft((prev) => ({ ...prev, titleRu }))}
            onBodyChange={(bodyRu) => setDraft((prev) => ({ ...prev, bodyRu }))}
            documentKey={document.key}
          />
          <LocaleFields
            locale="en"
            title={draft.titleEn}
            body={draft.bodyEn}
            onTitleChange={(titleEn) => setDraft((prev) => ({ ...prev, titleEn }))}
            onBodyChange={(bodyEn) => setDraft((prev) => ({ ...prev, bodyEn }))}
            documentKey={document.key}
          />
        </div>

        <div className="flex items-center justify-between">
          <p className="text-muted-foreground text-xs">{t('legalDocumentsPage.plainTextOnly')}</p>
          <Button
            onClick={() => mutation.mutate(draft)}
            disabled={!dirty || mutation.isPending}
          >
            <Save className="mr-2 size-4" aria-hidden />
            {t('legalDocumentsPage.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function LocaleFields({
  locale,
  title,
  body,
  onTitleChange,
  onBodyChange,
  documentKey,
}: {
  readonly locale: 'ru' | 'en'
  readonly title: string
  readonly body: string
  readonly onTitleChange: (value: string) => void
  readonly onBodyChange: (value: string) => void
  readonly documentKey: LegalDocumentKey
}) {
  const { t } = useTranslation()
  const titleId = `title-${locale}-${documentKey}`
  const bodyId = `body-${locale}-${documentKey}`

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{t(`legalDocumentsPage.locales.${locale}`)}</p>
      <div className="space-y-1.5">
        <Label htmlFor={titleId}>{t('legalDocumentsPage.documentTitle')}</Label>
        <Input
          id={titleId}
          value={title}
          maxLength={LEGAL_DOCUMENT_TITLE_MAX}
          onChange={(event) => onTitleChange(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={bodyId}>{t('legalDocumentsPage.documentBody')}</Label>
        <Textarea
          id={bodyId}
          value={body}
          rows={16}
          maxLength={LEGAL_DOCUMENT_BODY_MAX}
          className="font-mono text-xs"
          onChange={(event) => onBodyChange(event.target.value)}
        />
        <p className="text-muted-foreground text-right text-xs tabular-nums">
          {body.length} / {LEGAL_DOCUMENT_BODY_MAX}
        </p>
      </div>
    </div>
  )
}

/** `USER_AGREEMENT` → `userAgreement`, so translation keys stay camelCase. */
function documentSlug(key: LegalDocumentKey): string {
  return key
    .toLowerCase()
    .replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}
