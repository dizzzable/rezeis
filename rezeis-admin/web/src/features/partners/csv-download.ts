import { api } from '@/lib/api'

interface CsvDownloadInput {
  readonly path: string
  readonly filename: string
  readonly params?: Record<string, string | number>
}

/**
 * Download a server-rendered CSV file as a save dialog. Uses the existing
 * authenticated `api` axios instance so the JWT header is set
 * automatically; we ask for `arraybuffer` so the BOM Excel needs is
 * preserved byte-for-byte.
 */
export async function downloadCsv({ path, filename, params }: CsvDownloadInput): Promise<void> {
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
}
