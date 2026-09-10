import { api } from '@/lib/api'

/**
 * user-export-api
 * ───────────────
 * The column catalogue, read from the server rather than kept here.
 *
 * A copy in the SPA would let an operator tick a column the export does not
 * write, and a column that comes back blank reads as "we hold no such data
 * about these people" — a conclusion they would act on. So the picker draws
 * whatever this returns, and the only thing this package knows about a column
 * is how to LABEL it.
 */

export interface UserExportColumn {
  readonly id: string
  readonly group: string
  /**
   * `user` | `subscription` | `panel`. Only `panel` matters to the operator:
   * those columns are read out of Remnawave and the export takes longer for
   * them, so the dialog says so instead of appearing to hang.
   */
  readonly source: string
  /** Needs `users:export_registration`, which this admin may not hold. */
  readonly elevated: boolean
}

export interface UserExportCatalog {
  readonly columns: readonly UserExportColumn[]
  /** False when the elevated columns must be drawn locked rather than ticked. */
  readonly allowElevated: boolean
}

export async function getUserExportCatalog(): Promise<UserExportCatalog> {
  const response = await api.get<UserExportCatalog>('/admin/users/export/columns')
  return response.data
}

/** The columns an operator starts with: everything they are allowed to have. */
export function defaultSelection(catalog: UserExportCatalog): string[] {
  return catalog.columns
    .filter((column) => catalog.allowElevated || !column.elevated)
    .map((column) => column.id)
}

/**
 * The columns grouped for the dialog, in the server's order.
 *
 * The order is the catalogue's, so the checkboxes read down the customer's life
 * the same way the file's columns run left to right — an operator who ticks
 * half of them can still find them in the spreadsheet.
 */
export function groupColumns(
  columns: readonly UserExportColumn[],
): Array<{ group: string; columns: UserExportColumn[] }> {
  const order: string[] = []
  const byGroup = new Map<string, UserExportColumn[]>()
  for (const column of columns) {
    if (!byGroup.has(column.group)) {
      byGroup.set(column.group, [])
      order.push(column.group)
    }
    byGroup.get(column.group)?.push(column)
  }
  return order.map((group) => ({ group, columns: byGroup.get(group) ?? [] }))
}
