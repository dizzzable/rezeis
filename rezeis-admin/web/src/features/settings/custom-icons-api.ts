import { api } from '@/lib/api'

/** One operator-uploaded custom icon. Mirrors the backend `CustomIconInterface`. */
export interface CustomIcon {
  id: string
  name: string
  /** Public URL, relative to the admin host (`/uploads/icons/<file>`). */
  url: string
  /** Optional hex tint applied via CSS mask; `null` keeps the icon's own colours. */
  color: string | null
}

interface IconUploadResponse {
  url: string
  originalName: string
  mimeType: string
  size: number
}

export const CUSTOM_ICONS_QUERY_KEY = ['admin', 'settings', 'icons'] as const

export async function getCustomIcons(): Promise<CustomIcon[]> {
  const { data } = await api.get<CustomIcon[]>('/admin/settings/icons')
  return data
}

export async function saveCustomIcons(icons: CustomIcon[]): Promise<CustomIcon[]> {
  const { data } = await api.put<CustomIcon[]>('/admin/settings/icons', { icons })
  return data
}

export async function uploadCustomIconFile(file: File): Promise<string> {
  const form = new FormData()
  form.append('file', file)
  const { data } = await api.post<IconUploadResponse>('/admin/settings/icons/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return data.url
}

/**
 * Absolute URL for an uploaded icon. The admin serves `/uploads/*` from the
 * same origin, so a relative URL works directly in the panel. Exported so the
 * reiwa side / previews can build the same value if needed.
 */
export function iconAssetUrl(url: string): string {
  return url
}
