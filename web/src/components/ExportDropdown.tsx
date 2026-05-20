import { Download, FileJson, FileSpreadsheet } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface ExportColumnDefinition<TRow> {
  /** Column header rendered in CSV / first JSON key. */
  readonly header: string
  /**
   * Cell extractor. Return a primitive (string/number/boolean) — anything
   * else gets `JSON.stringify`d for CSV and emitted as-is for JSON.
   */
  readonly accessor: (row: TRow) => unknown
}

export interface ExportDropdownProps<TRow> {
  /**
   * Filename stem (no extension). Date suffix is appended automatically:
   * `users` → `users-2026-05-16.csv`.
   */
  readonly filename: string
  readonly rows: readonly TRow[]
  readonly columns: readonly ExportColumnDefinition<TRow>[]
  /** Disable the trigger when there's no data yet. */
  readonly disabled?: boolean
  /** Optional label override (defaults to "Export"). */
  readonly label?: string
}

/**
 * Thin client-side export dropdown — pulls the rows you already have in
 * memory and offers CSV / JSON download. We intentionally keep this
 * client-only: pages that need a server-side dump (e.g. millions of
 * audit rows) should expose a dedicated endpoint instead.
 *
 * Encoding
 *   - CSV uses CRLF line endings, RFC 4180 quoting, and a UTF-8 BOM so
 *     Excel opens the file in the right encoding by default.
 *   - JSON pretty-prints with 2-space indent.
 */
export function ExportDropdown<TRow>(props: ExportDropdownProps<TRow>) {
  const dateSuffix = new Date().toISOString().slice(0, 10)
  const stem = `${props.filename}-${dateSuffix}`

  const downloadCsv = () => {
    const csv = buildCsv(props.rows, props.columns)
    triggerDownload(`${stem}.csv`, csv, 'text/csv;charset=utf-8;')
  }

  const downloadJson = () => {
    const data = props.rows.map((row) => {
      const obj: Record<string, unknown> = {}
      for (const col of props.columns) {
        obj[col.header] = col.accessor(row)
      }
      return obj
    })
    const json = JSON.stringify(data, null, 2)
    triggerDownload(`${stem}.json`, json, 'application/json;charset=utf-8;')
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={props.disabled || props.rows.length === 0}
        >
          <Download className="mr-2 h-4 w-4" />
          {props.label ?? 'Export'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={downloadCsv}>
          <FileSpreadsheet className="mr-2 h-4 w-4" />
          CSV ({props.rows.length} rows)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={downloadJson}>
          <FileJson className="mr-2 h-4 w-4" />
          JSON ({props.rows.length} rows)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function buildCsv<TRow>(
  rows: readonly TRow[],
  columns: readonly ExportColumnDefinition<TRow>[],
): string {
  const lines: string[] = []
  lines.push(columns.map((col) => csvCell(col.header)).join(','))
  for (const row of rows) {
    lines.push(columns.map((col) => csvCell(col.accessor(row))).join(','))
  }
  // UTF-8 BOM so Excel detects the encoding correctly on Windows.
  return '\uFEFF' + lines.join('\r\n')
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  let str: string
  if (typeof value === 'string') str = value
  else {
    try {
      str = JSON.stringify(value)
    } catch {
      str = String(value)
    }
  }
  // RFC 4180: wrap any field containing comma/quote/newline in double
  // quotes and escape internal quotes.
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function triggerDownload(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Schedule revoke on the next tick so download starts before the
  // blob is freed.
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
