import { api } from '@/lib/api'

interface CsvDownloadInput {
  readonly path: string
  readonly filename: string
  readonly params?: Record<string, string | number>
}

/**
 * What the server said ABOUT the file, beside the file itself.
 *
 * The export endpoints answer with two headers the download alone cannot carry:
 * how many rows the file holds, and whether the row ceiling cut it short. This
 * function used to throw the whole response away the moment the blob was built,
 * so `X-Export-Truncated` was set on every response, travelled the wire, and
 * was read by nobody — the operator got a file that silently stopped at 20 000
 * customers and no way to know it.
 *
 * Returned rather than handled here, because "what to do about a short file" is
 * a decision for the screen that asked for it. Every existing caller ignores
 * the value and still compiles.
 */
export interface CsvDownloadResult {
  /**
   * True only when the server said `X-Export-Truncated: true`.
   *
   * Compared against the literal on purpose. `Boolean('false')` is `true` — the
   * trap that has cost this codebase a filter that returned the rows it was
   * asked to exclude — and a header is a string like any other.
   */
  readonly truncated: boolean
  /** `X-Export-Row-Count`, or null when the endpoint does not send one. */
  readonly rowCount: number | null
}

/**
 * Download a server-rendered CSV file as a save dialog. Uses the existing
 * authenticated `api` axios instance so the JWT header is set
 * automatically; we ask for `arraybuffer` so the BOM Excel needs is
 * preserved byte-for-byte.
 *
 * ── Why the headers are readable at all ──────────────────────────────────────
 *
 * `X-Export-Truncated` is a custom header, and a cross-origin response would
 * hide it from JavaScript unless the server listed it in `exposedHeaders`. It
 * is readable here because there is no cross-origin: the panel's SPA is served
 * by the same Nest process that serves `/api` (`ServeStaticModule` in
 * `app.module.ts`, `baseURL: '/api'` in `lib/api.ts`), and the dev server
 * proxies `/api` to the same origin. Nothing to expose, because nothing is
 * cross-origin.
 */
export async function downloadCsv({
  path,
  filename,
  params,
}: CsvDownloadInput): Promise<CsvDownloadResult> {
  const response = await api.get<ArrayBuffer>(path, {
    params,
    responseType: 'arraybuffer',
  })
  const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8' })
  const objectUrl = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = filename
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
  return readExportHeaders(response.headers)
}

/** The two export headers, out of whatever shape axios hands back. */
function readExportHeaders(headers: unknown): CsvDownloadResult {
  const read = (name: string): string | null => {
    // Axios lower-cases response header names, and gives either an
    // `AxiosHeaders` instance or a plain object depending on the adapter and
    // on how a test faked it. Both answer to indexing; neither is guaranteed
    // to answer to `.get`.
    const value = (headers as Record<string, unknown> | null | undefined)?.[name.toLowerCase()]
    return typeof value === 'string' ? value : null
  }
  const rows = Number(read('X-Export-Row-Count'))
  return {
    truncated: read('X-Export-Truncated') === 'true',
    rowCount: Number.isFinite(rows) && read('X-Export-Row-Count') !== null ? rows : null,
  }
}
