import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, Loader2, Play } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

import {
  type BulkUserAction,
  type BulkUserOperationResult,
  executeBulkUserOperation,
} from './bulk-users-api'

const ACTIONS: ReadonlyArray<{
  readonly value: BulkUserAction
  readonly labelKey: string
  readonly needsInput?: 'language' | 'maxSubscriptions'
}> = [
  { value: 'block', labelKey: 'bulkUsersPage.actions.block' },
  { value: 'unblock', labelKey: 'bulkUsersPage.actions.unblock' },
  { value: 'delete', labelKey: 'bulkUsersPage.actions.delete' },
  { value: 'set_language', labelKey: 'bulkUsersPage.actions.setLanguage', needsInput: 'language' },
  {
    value: 'set_max_subscriptions',
    labelKey: 'bulkUsersPage.actions.setMaxSubs',
    needsInput: 'maxSubscriptions',
  },
]

const DESTRUCTIVE: ReadonlyArray<BulkUserAction> = ['block', 'delete']

/**
 * Bulk user operations.
 *
 * Operators paste a list of canonical user IDs (Reiwa CUIDs) and pick
 * an action. Up to 1000 IDs per batch.
 */
export default function BulkUsersPage() {
  const { t } = useTranslation()
  const [action, setAction] = useState<BulkUserAction>('block')
  const [rawIds, setRawIds] = useState('')
  const [param, setParam] = useState('')
  const [result, setResult] = useState<BulkUserOperationResult | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const ids = useMemo(
    () =>
      rawIds
        .split(/[\s,]+/g)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    [rawIds],
  )
  const uniqueIds = useMemo(() => Array.from(new Set(ids)), [ids])

  const actionDef = ACTIONS.find((a) => a.value === action)!
  const needsParam = actionDef.needsInput
  const isDestructive = DESTRUCTIVE.includes(action)
  const requireConfirm = isDestructive
  const confirmOk = !requireConfirm || confirmText === action.toUpperCase()

  const mutation = useMutation({
    mutationFn: () =>
      executeBulkUserOperation({
        userIds: uniqueIds,
        action,
        payload: needsParam
          ? needsParam === 'language'
            ? { language: param.toUpperCase() }
            : { maxSubscriptions: Number.parseInt(param, 10) }
          : undefined,
      }),
    onSuccess: (data) => {
      setResult(data)
      setError(null)
      setConfirmText('')
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { message?: string } }; message?: string }
      setError(e?.response?.data?.message ?? e?.message ?? t('bulkUsersPage.errors.failed'))
    },
  })

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t('bulkUsersPage.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('bulkUsersPage.subtitle')}</p>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('bulkUsersPage.configure')}</CardTitle>
          <CardDescription>{t('bulkUsersPage.configureHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>{t('bulkUsersPage.action')}</Label>
            <div className="flex flex-wrap gap-1">
              {ACTIONS.map((a) => (
                <Button
                  key={a.value}
                  size="sm"
                  variant={action === a.value ? 'default' : 'outline'}
                  onClick={() => {
                    setAction(a.value)
                    setResult(null)
                    setConfirmText('')
                  }}
                >
                  {t(a.labelKey)}
                </Button>
              ))}
            </div>
          </div>

          {needsParam ? (
            <div className="space-y-2">
              <Label htmlFor="bulk-param">
                {needsParam === 'language'
                  ? t('bulkUsersPage.params.language')
                  : t('bulkUsersPage.params.maxSubs')}
              </Label>
              <Input
                id="bulk-param"
                value={param}
                onChange={(e) => setParam(e.target.value)}
                placeholder={needsParam === 'language' ? 'EN' : '5'}
              />
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="bulk-ids">
              {t('bulkUsersPage.idsLabel', { count: uniqueIds.length })}
            </Label>
            <Textarea
              id="bulk-ids"
              rows={8}
              placeholder="cln1abc... cln2def... cln3ghi..."
              value={rawIds}
              onChange={(e) => setRawIds(e.target.value)}
            />
          </div>

          {requireConfirm ? (
            <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/40 dark:bg-amber-950/30">
              <div className="flex items-center gap-2 font-semibold text-amber-900 dark:text-amber-200">
                <AlertTriangle className="h-4 w-4" /> {t('bulkUsersPage.confirm.warning')}
              </div>
              <p className="text-xs text-amber-800 dark:text-amber-300">
                {t('bulkUsersPage.confirm.typeToConfirm', { value: action.toUpperCase() })}
              </p>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={action.toUpperCase()}
              />
            </div>
          ) : null}

          <Button
            onClick={() => mutation.mutate()}
            disabled={
              mutation.isPending ||
              uniqueIds.length === 0 ||
              !confirmOk ||
              (needsParam !== undefined && param.trim().length === 0)
            }
          >
            {mutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            {t('bulkUsersPage.runOn', { count: uniqueIds.length })}
          </Button>
        </CardContent>
      </Card>

      {result ? <ResultCard result={result} /> : null}
    </div>
  )
}

function ResultCard({ result }: { readonly result: BulkUserOperationResult }) {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          <CardTitle className="text-base">
            {t('bulkUsersPage.result.title', { action: result.action, count: result.total })}
          </CardTitle>
        </div>
        <CardDescription>
          {t('bulkUsersPage.result.summary', {
            ok: result.succeeded,
            failed: result.failed,
            skipped: result.skipped,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="max-h-[420px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/30 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">{t('bulkUsersPage.result.userId')}</th>
                <th className="px-3 py-2">{t('bulkUsersPage.result.status')}</th>
                <th className="px-3 py-2">{t('bulkUsersPage.result.message')}</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((item) => (
                <tr key={item.userId} className="border-b last:border-0">
                  <td className="px-3 py-2 font-mono text-xs">{item.userId}</td>
                  <td
                    className={`px-3 py-2 text-xs font-medium uppercase ${
                      item.status === 'ok'
                        ? 'text-emerald-500'
                        : item.status === 'skipped'
                          ? 'text-muted-foreground'
                          : 'text-destructive'
                    }`}
                  >
                    {item.status}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{item.message ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}
