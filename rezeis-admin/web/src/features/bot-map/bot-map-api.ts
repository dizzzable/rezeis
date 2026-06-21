/**
 * bot-map-api
 * ───────────
 * Thin axios wrappers around the endpoints the "Карта бота" module
 * consumes. Reuses existing endpoints whenever possible — only the
 * read-side composer is new (`GET /admin/bot-map`); graph screens,
 * reply buttons, and notification templates write through their
 * already-shipped CRUD endpoints.
 */
import { api } from '@/lib/api'
import type { BotMapPayload, UpdateNotificationTemplatePatch } from './types'

export const BOT_MAP_QUERY_KEY = ['bot-map'] as const
export const BOT_BANNERS_QUERY_KEY = ['bot-config', 'banners'] as const

/** A reusable banner library entry (`GET /admin/bot-config/banners`). */
export interface BotBannerView {
  readonly id: string
  readonly name: string
  readonly url: string
  readonly mimeType: string
  readonly sizeBytes: number
  readonly createdAt: string
}

/** Fetch the reusable banner library. */
export async function fetchBanners(): Promise<readonly BotBannerView[]> {
  const res = await api.get<readonly BotBannerView[]>('/admin/bot-config/banners')
  return res.data
}

/** Upload a banner into the library and return the created entry. */
export async function uploadBanner(file: File, name?: string): Promise<BotBannerView> {
  const form = new FormData()
  form.append('file', file)
  if (name !== undefined && name.trim().length > 0) form.append('name', name.trim())
  const res = await api.post<BotBannerView>('/admin/bot-config/banners', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return res.data
}

/** Delete a banner from the library (assignments keep their URL). */
export async function deleteBanner(id: string): Promise<void> {
  await api.post(`/admin/bot-config/banners/${encodeURIComponent(id)}/delete`)
}

/** Fetch the unified node + edge payload backing the list and canvas. */
export async function fetchBotMap(): Promise<BotMapPayload> {
  const res = await api.get<BotMapPayload>('/admin/bot-map')
  return res.data
}

/** Patch a graph screen — same endpoint the legacy editor calls. */
export async function patchGraphScreen(
  screenId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await api.put(`/admin/bot-flows/screens/${encodeURIComponent(screenId)}`, patch)
}

/** Update a reply-keyboard button (label + flags). */
export async function patchReplyButton(
  buttonId: string,
  patch: { label?: string; visible?: boolean; actionTarget?: string | null },
): Promise<void> {
  await api.put(`/admin/bot-config/buttons/${encodeURIComponent(buttonId)}`, patch)
}

/**
 * Update a notification template row, including the new EN copy + buttons
 * fields shipped in Wave 1. The endpoint accepts a partial DTO — only
 * supplied fields are written.
 */
export async function patchNotificationTemplate(
  templateId: string,
  patch: UpdateNotificationTemplatePatch,
): Promise<void> {
  await api.patch(
    `/admin/notifications/templates/${encodeURIComponent(templateId)}`,
    patch,
  )
}
