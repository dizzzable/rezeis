import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Trash2, Plus, ShieldOff, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'

import {
  listAdminIpAllowlist,
  createAdminIpAllowlistEntry,
  updateAdminIpAllowlistEntry,
  deleteAdminIpAllowlistEntry,
} from './two-factor-api'

interface AdminIpAllowlistPageProps {
  /**
   * When `true`, hides the page-level header (title + subtitle) so the
   * page can be embedded inside a tab without duplicating headings.
   */
  readonly embedded?: boolean
}

/**
 * Admin Panel IP allowlist editor.
 *
 * Important UX detail
 *   The first row added activates the allowlist for everyone — including
 *   the operator currently editing the page. The header banner highlights
 *   the operator's IP so they don't lock themselves out.
 */
export default function AdminIpAllowlistPage({ embedded = false }: AdminIpAllowlistPageProps = {}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['admin-ip-allowlist'],
    queryFn: listAdminIpAllowlist,
    staleTime: 10_000,
  })

  const [address, setAddress] = useState('')
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)

  const createMutation = useMutation({
    mutationFn: createAdminIpAllowlistEntry,
    onSuccess: () => {
      setAddress('')
      setLabel('')
      setError(null)
      queryClient.invalidateQueries({ queryKey: ['admin-ip-allowlist'] })
    },
    onError: (err: { response?: { data?: { message?: string } } }) =>
      setError(err.response?.data?.message ?? t('ipAllowlistPage.errors.createFailed')),
  })

  const toggleMutation = useMutation({
    mutationFn: (input: { id: string; isActive: boolean }) =>
      updateAdminIpAllowlistEntry(input.id, { isActive: input.isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-ip-allowlist'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteAdminIpAllowlistEntry,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-ip-allowlist'] }),
  })

  if (isLoading || !data) {
    return <Skeleton className="h-72 w-full" />
  }

  const activeEntries = data.items.filter((entry) => entry.isActive).length
  const allowlistActive = activeEntries > 0

  return (
    <div className="space-y-6">
      {!embedded && (
        <div>
          <h1 className="text-2xl font-bold">{t('ipAllowlistPage.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('ipAllowlistPage.subtitle')}</p>
        </div>
      )}

      <Card className={allowlistActive ? 'border-amber-300' : 'border-emerald-300'}>
        <CardContent className="flex items-center gap-3 py-4">
          {allowlistActive ? (
            <>
              <ShieldCheck className="h-5 w-5 text-amber-600" />
              <p className="text-sm">
                <strong>{t('ipAllowlistPage.statusActive')}</strong>{' '}
                {t('ipAllowlistPage.statusActiveBody', { count: activeEntries })}
              </p>
            </>
          ) : (
            <>
              <ShieldOff className="h-5 w-5 text-emerald-600" />
              <p className="text-sm">
                <strong>{t('ipAllowlistPage.statusInactive')}</strong>{' '}
                {t('ipAllowlistPage.statusInactiveBody')}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('ipAllowlistPage.addEntry')}</CardTitle>
          <CardDescription>{t('ipAllowlistPage.addEntryHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (!address.trim()) return
              createMutation.mutate({ address: address.trim(), label: label.trim() })
            }}
          >
            <div className="flex-1 min-w-[200px] space-y-2">
              <Label htmlFor="al-addr">{t('ipAllowlistPage.address')}</Label>
              <Input
                id="al-addr"
                placeholder="192.168.1.0/24"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </div>
            <div className="flex-1 min-w-[200px] space-y-2">
              <Label htmlFor="al-label">{t('ipAllowlistPage.label')}</Label>
              <Input
                id="al-label"
                placeholder={t('ipAllowlistPage.labelPlaceholder')}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={createMutation.isPending || !address.trim()}>
              {createMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-2 h-4 w-4" />
              )}
              {t('ipAllowlistPage.add')}
            </Button>
          </form>
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('ipAllowlistPage.entries', { count: data.total })}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {data.items.length === 0 ? (
            <p className="px-6 py-4 text-sm text-muted-foreground">{t('ipAllowlistPage.empty')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/30 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">{t('ipAllowlistPage.columns.address')}</th>
                  <th className="px-4 py-2">{t('ipAllowlistPage.columns.label')}</th>
                  <th className="px-4 py-2">{t('ipAllowlistPage.columns.created')}</th>
                  <th className="px-4 py-2 w-24">{t('ipAllowlistPage.columns.active')}</th>
                  <th className="w-16" />
                </tr>
              </thead>
              <tbody>
                {data.items.map((entry) => (
                  <tr key={entry.id} className="border-b last:border-0">
                    <td className="px-4 py-2 font-mono text-xs">{entry.address}</td>
                    <td className="px-4 py-2">
                      {entry.label || <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {new Date(entry.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2">
                      <Switch
                        checked={entry.isActive}
                        onCheckedChange={(checked) =>
                          toggleMutation.mutate({ id: entry.id, isActive: checked })
                        }
                      />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => deleteMutation.mutate(entry.id)}
                        disabled={deleteMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
