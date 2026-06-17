/**
 * Bot config — admin API client
 * ─────────────────────────────
 * Talks to AdminBotConfigController under /api/admin/bot-config. The three
 * sub-catalogs (buttons / emojis / texts) are siblings under one router so
 * we expose them as a single namespace here. Each entity has zod-validated
 * read schemas so the SPA never trusts a response shape blindly.
 *
 * Reorder is a single transactional POST instead of N PATCHes — the backend
 * rewrites every `orderIndex` atomically, which avoids interleaving with
 * reiwa's 5-minute refresh loop while a drag-and-drop is in flight.
 */
import { z } from 'zod'

import { api } from '@/lib/api'

// ── Buttons ────────────────────────────────────────────────────────────────

export const botButtonStyleSchema = z.enum(['DEFAULT', 'PRIMARY', 'SUCCESS', 'DANGER'])
export type BotButtonStyle = z.infer<typeof botButtonStyleSchema>

export const botButtonActionSchema = z.enum([
  'CALLBACK',
  'URL',
  'WEBAPP',
  'SCREEN',
  'SUPPORT_URL',
])
export type BotButtonAction = z.infer<typeof botButtonActionSchema>

export const botButtonSchema = z.object({
  id: z.string(),
  buttonId: z.string(),
  label: z.string(),
  style: botButtonStyleSchema,
  iconCustomEmojiId: z.string().nullable(),
  visible: z.boolean(),
  onePerRow: z.boolean(),
  orderIndex: z.number().int(),
  actionType: botButtonActionSchema,
  actionTarget: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type BotButton = z.infer<typeof botButtonSchema>

export const createBotButtonSchema = z.object({
  buttonId: z.string().min(1).max(64).regex(/^[a-z0-9._-]+$/i, 'invalid format'),
  label: z.string().min(1).max(120),
  style: botButtonStyleSchema.optional(),
  iconCustomEmojiId: z.string().max(120).nullable().optional(),
  visible: z.boolean().optional(),
  onePerRow: z.boolean().optional(),
  actionType: botButtonActionSchema.optional(),
  actionTarget: z.string().max(2_000).nullable().optional(),
})
export type CreateBotButtonPayload = z.infer<typeof createBotButtonSchema>

export const updateBotButtonSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  style: botButtonStyleSchema.optional(),
  iconCustomEmojiId: z.string().max(120).nullable().optional(),
  visible: z.boolean().optional(),
  onePerRow: z.boolean().optional(),
  actionType: botButtonActionSchema.optional(),
  actionTarget: z.string().max(2_000).nullable().optional(),
})
export type UpdateBotButtonPayload = z.infer<typeof updateBotButtonSchema>

// ── Emojis ─────────────────────────────────────────────────────────────────

export const botEmojiSchema = z.object({
  id: z.string(),
  key: z.string(),
  unicode: z.string(),
  tgEmojiId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type BotEmoji = z.infer<typeof botEmojiSchema>

export const createBotEmojiSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'invalid format'),
  unicode: z.string().min(1).max(16),
  tgEmojiId: z.string().max(120).nullable().optional(),
})
export type CreateBotEmojiPayload = z.infer<typeof createBotEmojiSchema>

export const updateBotEmojiSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'invalid format').optional(),
  unicode: z.string().min(1).max(16).optional(),
  tgEmojiId: z.string().max(120).nullable().optional(),
})
export type UpdateBotEmojiPayload = z.infer<typeof updateBotEmojiSchema>

// ── Texts ──────────────────────────────────────────────────────────────────

export const botTextSchema = z.object({
  id: z.string(),
  key: z.string(),
  value: z.string(),
  visible: z.boolean(),
  /** English sibling value (`<key>@en` row); null when no EN override. */
  valueEn: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type BotText = z.infer<typeof botTextSchema>

export const createBotTextSchema = z.object({
  key: z.string().min(1).max(160).regex(/^[a-z0-9._-]+$/i, 'invalid format'),
  value: z.string().min(1).max(8_000),
  visible: z.boolean().optional(),
  valueEn: z.string().max(8_000).nullable().optional(),
})
export type CreateBotTextPayload = z.infer<typeof createBotTextSchema>

export const updateBotTextSchema = z.object({
  key: z.string().min(1).max(160).regex(/^[a-z0-9._-]+$/i, 'invalid format').optional(),
  value: z.string().min(1).max(8_000).optional(),
  visible: z.boolean().optional(),
  valueEn: z.string().max(8_000).nullable().optional(),
})
export type UpdateBotTextPayload = z.infer<typeof updateBotTextSchema>

// ── Emoji studio (composite read) ────────────────────────────────────────────

export const slotPremiumPreviewSchema = z.object({
  slug: z.string(),
  name: z.string(),
  imageUrl: z.string(),
  lottieUrl: z.string().nullable(),
  videoUrl: z.string().nullable(),
  packName: z.string(),
})
export type SlotPremiumPreview = z.infer<typeof slotPremiumPreviewSchema>

export const emojiStudioSlotSchema = z.object({
  id: z.string(),
  key: z.string(),
  unicode: z.string(),
  tgEmojiId: z.string().nullable(),
  premiumPreview: slotPremiumPreviewSchema.nullable(),
  usedIn: z.array(z.string()),
})
export type EmojiStudioSlot = z.infer<typeof emojiStudioSlotSchema>

export const emojiStudioSchema = z.object({
  slots: z.array(emojiStudioSlotSchema),
  ownerHasPremium: z.boolean(),
})
export type EmojiStudioView = z.infer<typeof emojiStudioSchema>

// ── Query keys ─────────────────────────────────────────────────────────────
//
// Single source of truth for invalidations. Importers pass the constant in
// rather than duplicating the string array — keeps grep / refactor sane.

export const BOT_CONFIG_KEYS = {
  all: ['admin', 'bot-config'] as const,
  buttons: ['admin', 'bot-config', 'buttons'] as const,
  emojis: ['admin', 'bot-config', 'emojis'] as const,
  emojiStudio: ['admin', 'bot-config', 'emoji-studio'] as const,
  texts: ['admin', 'bot-config', 'texts'] as const,
} as const

// ── API surface ────────────────────────────────────────────────────────────

export const botConfigApi = {
  // Buttons --------------------------------------------------------------
  async listButtons(): Promise<BotButton[]> {
    const response = await api.get('/admin/bot-config/buttons')
    return z.array(botButtonSchema).parse(response.data)
  },
  async createButton(payload: CreateBotButtonPayload): Promise<BotButton> {
    const response = await api.post('/admin/bot-config/buttons', payload)
    return botButtonSchema.parse(response.data)
  },
  async updateButton(id: string, payload: UpdateBotButtonPayload): Promise<BotButton> {
    const response = await api.patch(`/admin/bot-config/buttons/${id}`, payload)
    return botButtonSchema.parse(response.data)
  },
  async deleteButton(id: string): Promise<void> {
    await api.post(`/admin/bot-config/buttons/${id}/delete`)
  },
  async reorderButtons(ids: readonly string[]): Promise<BotButton[]> {
    const response = await api.post('/admin/bot-config/buttons/reorder', { ids })
    return z.array(botButtonSchema).parse(response.data)
  },

  // Emojis ---------------------------------------------------------------
  async listEmojis(): Promise<BotEmoji[]> {
    const response = await api.get('/admin/bot-config/emojis')
    return z.array(botEmojiSchema).parse(response.data)
  },
  async createEmoji(payload: CreateBotEmojiPayload): Promise<BotEmoji> {
    const response = await api.post('/admin/bot-config/emojis', payload)
    return botEmojiSchema.parse(response.data)
  },
  async updateEmoji(id: string, payload: UpdateBotEmojiPayload): Promise<BotEmoji> {
    const response = await api.patch(`/admin/bot-config/emojis/${id}`, payload)
    return botEmojiSchema.parse(response.data)
  },
  async deleteEmoji(id: string): Promise<void> {
    await api.post(`/admin/bot-config/emojis/${id}/delete`)
  },

  async getEmojiStudio(): Promise<EmojiStudioView> {
    const response = await api.get('/admin/bot-config/emoji-studio')
    return emojiStudioSchema.parse(response.data)
  },

  async setEmojiOwnerPremium(enabled: boolean): Promise<{ ownerHasPremium: boolean }> {
    const response = await api.put('/admin/bot-config/emoji-studio/owner-premium', { enabled })
    return z.object({ ownerHasPremium: z.boolean() }).parse(response.data)
  },

  // Texts ----------------------------------------------------------------
  async listTexts(): Promise<BotText[]> {
    const response = await api.get('/admin/bot-config/texts')
    return z.array(botTextSchema).parse(response.data)
  },
  async createText(payload: CreateBotTextPayload): Promise<BotText> {
    const response = await api.post('/admin/bot-config/texts', payload)
    return botTextSchema.parse(response.data)
  },
  async updateText(id: string, payload: UpdateBotTextPayload): Promise<BotText> {
    const response = await api.patch(`/admin/bot-config/texts/${id}`, payload)
    return botTextSchema.parse(response.data)
  },
  async deleteText(id: string): Promise<void> {
    await api.post(`/admin/bot-config/texts/${id}/delete`)
  },
}
