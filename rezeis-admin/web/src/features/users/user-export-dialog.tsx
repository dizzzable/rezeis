import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Download, Loader2, Lock } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { downloadCsv } from '@/features/partners/csv-download'
import { translateApiError } from '@/lib/translate-error'

import {
  defaultSelection,
  getUserExportCatalog,
  groupColumns,
  type UserExportColumn,
} from './user-export-api'
import { filtersFromParams, filtersToParams } from './users-filters'

/**
 * user-export-dialog
 * ──────────────────
 * "Export the users" — which ones, and which columns.
 *
 * ── Everything is ticked when it opens ───────────────────────────────────────
 *
 * The common case is a full dump into a spreadsheet, so pressing Export
 * straight away has to be the whole base. Untick is the cheap gesture; hunting
 * for the four boxes you actually wanted is not, which is why there is a "none"
 * beside "all" in each group.
 *
 * ── The filters are the LIST'S filters ───────────────────────────────────────
 *
 * Not a second set here. The operator narrows the list, sees a count, and
 * exports what they are looking at — and because the list keeps its filters in
 * the URL, this dialog reads them from there rather than needing the state
 * lifted. A shared link therefore exports the same population it shows.
 */
export function UserExportDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const { t, i18n } = useTranslation()
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const [downloading, setDownloading] = useState(false)
  /**
   * Set when the file that was just saved is SHORT, and cleared on every new
   * attempt.
   *
   * State rather than a toast, and the dialog stays open when it is set. A toast
   * is gone in four seconds; "the spreadsheet on your disk is missing customers"
   * is a fact the operator has to still be able to read while they decide what
   * to do about it — and the thing to do is narrow the filters, which is what
   * the list behind this dialog is for.
   */
  const [truncated, setTruncated] = useState<{ readonly rowCount: number | null } | null>(null)

  const catalogQuery = useQuery({
    queryKey: ['admin', 'users', 'export', 'columns'],
    queryFn: getUserExportCatalog,
    // Only when the dialog is open: the catalogue is a permission check as well
    // as a list, and asking for it on every visit to the users page would put a
    // 403 in the console of every operator who cannot export.
    enabled: open,
    staleTime: 5 * 60 * 1000,
  })

  const catalog = catalogQuery.data
  const groups = useMemo(
    () => (catalog === undefined ? [] : groupColumns(catalog.columns)),
    [catalog],
  )
  // `null` until the catalogue lands, so the first render cannot tick a set
  // built from an empty list and then leave it ticked.
  //
  // And a column this admin may NOT have is dropped from whatever the operator
  // had picked, every render. Permissions can be revoked while the dialog is
  // mounted — the catalogue refetches after five minutes — and without this the
  // elevated box stayed checked AND disabled: ticked, unclickable, sent, and
  // refused by the server over a column the operator physically could not
  // untick. Only a page reload cleared it.
  const chosen = useMemo(() => {
    if (catalog === undefined) return null
    const base = selected ?? new Set(defaultSelection(catalog))
    const locked = new Set(
      catalog.columns.filter((column) => column.elevated && !catalog.allowElevated).map((c) => c.id),
    )
    if (locked.size === 0) return base
    return new Set([...base].filter((id) => !locked.has(id)))
  }, [catalog, selected])

  const toggle = (column: UserExportColumn, next: boolean): void => {
    if (chosen === null) return
    const updated = new Set(chosen)
    if (next) updated.add(column.id)
    else updated.delete(column.id)
    setSelected(updated)
  }

  const setGroup = (columns: readonly UserExportColumn[], next: boolean): void => {
    if (chosen === null || catalog === undefined) return
    const updated = new Set(chosen)
    for (const column of columns) {
      // A locked column is not a column this admin can choose, in either
      // direction: "select all" must not silently add one the server will
      // refuse the whole export over.
      if (column.elevated && !catalog.allowElevated) continue
      if (next) updated.add(column.id)
      else updated.delete(column.id)
    }
    setSelected(updated)
  }

  const download = async (): Promise<void> => {
    if (chosen === null || chosen.size === 0) return
    setDownloading(true)
    setTruncated(null)
    try {
      // ── THE LIST'S FILTERS, AND NOTHING ELSE OFF THE ADDRESS BAR ──────────
      //
      // This used to copy every key in `window.location.search` into the
      // request. The export endpoint validates with `forbidNonWhitelisted`, so
      // ONE key its DTO does not declare is a 400 and the whole export fails:
      // a `utm_source` on a link somebody shared, a `tab` the page put there, a
      // parameter a future screen adds for its own use, a stale bookmark from
      // before a filter was renamed. The operator sees a failed download and
      // nothing that names the parameter to blame.
      //
      // Round-tripping through the filter module is what makes that impossible
      // rather than merely unlikely: `filtersFromParams` keeps the keys it
      // knows and drops the rest, and `filtersToParams` can only emit keys the
      // export's DTO declares. A filter added to the list therefore travels
      // here for free, and a parameter that is not a filter cannot.
      const current = new URLSearchParams(window.location.search)
      const params: Record<string, string> = { ...filtersToParams(filtersFromParams(current)) }
      // `search` is the one export parameter that is not part of the filter
      // object — the list keeps it in its own state — so it is read across by
      // hand, trimmed the same way the list trims it before querying.
      const search = (current.get('search') ?? '').trim()
      if (search.length > 0) params.search = search
      params.columns = [...chosen].join(',')

      const result = await downloadCsv({
        path: '/admin/users/export/users.csv',
        filename: `users-export-${new Date().toISOString().slice(0, 10)}.csv`,
        params,
      })

      // A SHORT FILE IS NOT A SUCCESS. The server sets `X-Export-Truncated`
      // when the row ceiling stopped it with customers still to write, and an
      // operator who mails "everyone" off a file that quietly ends at the
      // oldest 20 000 has a campaign that reaches the wrong half of the base.
      if (result.truncated) {
        setTruncated({ rowCount: result.rowCount })
        return
      }
      toast.success(t('usersPage.export.usersSuccess'))
      onOpenChange(false)
    } catch (err) {
      toast.error(translateApiError(t, err))
    } finally {
      setDownloading(false)
    }
  }

  const total = catalog?.columns.length ?? 0
  const picked = chosen?.size ?? 0
  const wantsPanel =
    catalog !== undefined &&
    catalog.columns.some((column) => column.source === 'panel' && (chosen?.has(column.id) ?? false))

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Dropped when the operator closes the dialog, or the warning about the
        // file they downloaded this morning greets them this afternoon. This
        // component is not unmounted by closing — only its content is — so the
        // state outlives the dialog unless it is cleared here.
        if (!next) setTruncated(null)
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('usersPage.export.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('usersPage.export.dialogSubtitle')}</DialogDescription>
        </DialogHeader>

        {catalogQuery.isLoading && <Skeleton className="h-64 w-full" />}
        {catalogQuery.error !== null && catalogQuery.error !== undefined && (
          <Alert variant="destructive">
            <AlertDescription>{translateApiError(t, catalogQuery.error)}</AlertDescription>
          </Alert>
        )}

        {catalog !== undefined && chosen !== null && (
          <div className="space-y-4">
            {groups.map(({ group, columns }) => (
              <div key={group} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold">
                    {t(`usersPage.export.groups.${group}`)}
                  </p>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-[11px] font-normal text-muted-foreground"
                      onClick={() => setGroup(columns, true)}
                    >
                      {t('usersPage.export.selectAll')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-[11px] font-normal text-muted-foreground"
                      onClick={() => setGroup(columns, false)}
                    >
                      {t('usersPage.export.selectNone')}
                    </Button>
                  </div>
                </div>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {columns.map((column) => {
                    const locked = column.elevated && !catalog.allowElevated
                    return (
                      <div key={column.id} className="flex items-start gap-2">
                        <Checkbox
                          id={`export-${column.id}`}
                          checked={chosen.has(column.id)}
                          disabled={locked}
                          onCheckedChange={(next) => toggle(column, next === true)}
                        />
                        <Label
                          htmlFor={`export-${column.id}`}
                          className={`text-xs font-normal ${locked ? 'text-muted-foreground' : ''}`}
                        >
                          {t(`usersPage.export.columns.${column.id}`)}
                          {/* SHOWN LOCKED, not hidden. An operator who cannot
                              see a column cannot ask for the permission that
                              would give it to them. */}
                          {locked && (
                            <Lock
                              aria-label={t('usersPage.export.lockedHint')}
                              className="ml-1 inline h-3 w-3"
                            />
                          )}
                        </Label>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}

            {wantsPanel && (
              <Alert>
                <AlertDescription className="text-xs">
                  {t('usersPage.export.panelSlowHint')}
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}

        {truncated !== null && (
          <Alert variant="destructive" data-testid="export-truncated">
            <AlertDescription className="text-xs">
              {t('usersPage.export.truncatedWarning')}
              {/* TWO KEYS, not one sentence with a hole in it. The row count
                  comes from a response header, so it can be absent — and a
                  `0` or a dash in a row count is a claim about the file that
                  nothing has made. The second sentence simply does not appear.

                  `rows`, deliberately NOT `count`: i18next pluralises on a
                  variable named `count` and would then need a full Russian
                  `_one`/`_few`/`_many`/`_other` ladder here. The number is
                  already formatted into a locale string by the time it gets
                  here, so there is nothing left for a plural rule to agree
                  with. */}
              {truncated.rowCount !== null && (
                <>
                  {' '}
                  {t('usersPage.export.truncatedRows', {
                    rows: truncated.rowCount.toLocaleString(i18n.language),
                  })}
                </>
              )}
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {t('usersPage.export.chosenCount', { picked, total })}
          </p>
          <Button
            type="button"
            onClick={() => void download()}
            disabled={downloading || picked === 0 || catalog === undefined}
            data-testid="export-users-confirm"
          >
            {downloading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            {t('usersPage.export.download')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
