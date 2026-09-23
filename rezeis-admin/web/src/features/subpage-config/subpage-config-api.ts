/**
 * Subpage config — admin API client
 * ─────────────────────────────────
 * Talks to AdminSubpageConfigController under /api/admin/subpage-config. The
 * config is a single global JSON blob (branding / uiConfig / baseSettings /
 * baseTranslations / svgLibrary / platforms) consumed by rezeis-subpage.
 *
 * The schema here is intentionally SHALLOW/permissive (`.passthrough()`) — the
 * authoritative full validation lives on the (AGPL) subpage side. We only assert
 * the top-level shape so the editor can bind form fields safely.
 */
import { z } from 'zod';

import { api } from '@/lib/api';

export const localizedTextSchema = z.record(z.string(), z.string());
export type LocalizedText = z.infer<typeof localizedTextSchema>;

export const subpageConfigSchema = z
  .object({
    version: z.string(),
    locales: z.array(z.string()).min(1),
    brandingSettings: z
      .object({
        title: z.string(),
        logoUrl: z.string(),
        supportUrl: z.string(),
      })
      .passthrough(),
    uiConfig: z
      .object({
        subscriptionInfoBlockType: z.string(),
        installationGuidesBlockType: z.string(),
      })
      .passthrough(),
    baseSettings: z
      .object({
        metaTitle: z.string(),
        metaDescription: z.string(),
        showConnectionKeys: z.boolean(),
        hideGetLinkButton: z.boolean(),
      })
      .passthrough(),
    baseTranslations: z.record(z.string(), localizedTextSchema),
    svgLibrary: z.record(z.string(), z.string()),
    platforms: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export type SubpageConfig = z.infer<typeof subpageConfigSchema>;

export const SUBPAGE_INFO_BLOCK_TYPES = ['collapsed', 'expanded', 'cards', 'hidden'] as const;
export const SUBPAGE_GUIDE_BLOCK_TYPES = ['cards', 'accordion', 'minimal', 'timeline'] as const;

export const SUBPAGE_CONFIG_KEYS = {
  all: ['admin', 'subpage-config'] as const,
} as const;

export const subpageConfigApi = {
  /**
   * The editor's copy. `config.brandingSettings.title` is the title SAVED
   * (`''` when none); `titleFallback` is what heads the page while it stays
   * empty — the brand, followed on rename — for the field's placeholder.
   */
  async get(): Promise<{ config: SubpageConfig; stored: boolean; titleFallback?: string }> {
    const response = await api.get('/admin/subpage-config');
    return z
      .object({ config: subpageConfigSchema, stored: z.boolean(), titleFallback: z.string().optional() })
      .parse(response.data);
  },

  async replace(config: SubpageConfig): Promise<SubpageConfig> {
    const response = await api.put('/admin/subpage-config', { config });
    return z.object({ config: subpageConfigSchema }).parse(response.data).config;
  },
};
