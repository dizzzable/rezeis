/**
 * Landing builder — admin API client
 * ───────────────────────────────────
 * Talks to AdminLandingConfigController under /admin/landing-config. The
 * config shape is intentionally loosely-typed here (`Record<string, unknown>`
 * sections) since the authoritative Zod schema lives on the backend — the
 * admin UI is a typed EDITOR over a JSON document, not a re-validator. Draft
 * saves carry the optimistic-concurrency `version`; a stale save is rejected
 * with 409 by the backend (surfaced here as `LandingDraftConflictError`).
 */
import { z } from 'zod'

import { api } from '@/lib/api'

export const localizedTextSchema = z.record(z.string(), z.string())
export type LocalizedText = z.infer<typeof localizedTextSchema>

export const LANDING_SECTION_TYPES = [
  'hero',
  'featuresGrid',
  'howItWorks',
  'pricing',
  'faq',
  'testimonials',
  'stats',
  'trustLogos',
  'ctaBanner',
  'footer',
] as const
export type LandingSectionType = (typeof LANDING_SECTION_TYPES)[number]

/** Background effect presets — mirror backend `LANDING_BACKGROUNDS`. */
export const LANDING_BACKGROUNDS = [
  'none',
  'gradient',
  'aurora',
  'grid',
  'dots',
  'glow',
  'mesh',
  'noise',
  'blobs',
  'spotlight',
] as const
export type LandingBackground = (typeof LANDING_BACKGROUNDS)[number]

/** Card/section surface treatment — mirror backend `LANDING_SURFACE_STYLES`. */
export const LANDING_SURFACE_STYLES = ['solid', 'glass', 'outline'] as const
export type LandingSurfaceStyle = (typeof LANDING_SURFACE_STYLES)[number]

/** Per-section scroll-reveal animation — mirror backend `LANDING_ANIMATIONS`. */
export const LANDING_ANIMATIONS = ['none', 'fade', 'fadeUp', 'zoom'] as const
export type LandingAnimation = (typeof LANDING_ANIMATIONS)[number]

export interface LandingSection {
  id: string
  type: LandingSectionType
  visible: boolean
  animation?: LandingAnimation
  data: Record<string, unknown>
}

export interface LandingTheme {
  inherit: boolean
  colors?: { primary?: string; bg?: string; fg?: string; accent?: string }
  font?: { family?: string; scale?: number }
  radius?: 'none' | 'sm' | 'md' | 'lg' | 'xl'
  background?: LandingBackground
  backgroundColors?: string[]
  animateBackground?: boolean
  surfaceStyle?: LandingSurfaceStyle
}

export interface LandingConfig {
  schemaVersion: number
  enabled: boolean
  theme: LandingTheme
  locales: string[]
  defaultLocale: string
  meta: { title: LocalizedText; description: LocalizedText }
  ogImage?: string
  sections: LandingSection[]
}

export interface LandingDraftResponse {
  draft: LandingConfig
  published: LandingConfig | { enabled: false } | null
  version: number
  stored: boolean
  hasDraftChanges: boolean
}

export interface LandingRevisionMeta {
  id: string
  schemaVersion: number
  publishedBy: string | null
  publishedAt: string
  isCurrent: boolean
}

export interface LandingPublishStrictIssue {
  path: string
  message: string
}

/** Thrown when a draft save is rejected (409) because a second editor saved
 *  in between. Carries the server's current version for a reload prompt. */
export class LandingDraftConflictError extends Error {
  public readonly currentVersion: number
  public constructor(currentVersion: number) {
    super('LANDING_DRAFT_CONFLICT')
    this.currentVersion = currentVersion
  }
}

/** Thrown when publish is blocked by the backend's publish-strict gate. */
export class LandingPublishIncompleteError extends Error {
  public readonly issues: LandingPublishStrictIssue[]
  public constructor(issues: LandingPublishStrictIssue[]) {
    super('LANDING_PUBLISH_INCOMPLETE')
    this.issues = issues
  }
}

export const LANDING_BUILDER_KEYS = {
  all: ['admin', 'landing-config'] as const,
  revisions: ['admin', 'landing-config', 'revisions'] as const,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

export const landingBuilderApi = {
  async get(): Promise<LandingDraftResponse> {
    const response = await api.get('/admin/landing-config')
    return response.data as LandingDraftResponse
  },

  async saveDraft(config: LandingConfig, version: number): Promise<{ config: LandingConfig; version: number }> {
    try {
      const response = await api.put('/admin/landing-config', { config, version })
      return response.data as { config: LandingConfig; version: number }
    } catch (error) {
      const status = isRecord(error) && isRecord(error['response']) ? error['response']['status'] : null
      if (status === 409) {
        const body = isRecord(error) && isRecord(error['response']) ? error['response']['data'] : null
        const currentVersion =
          isRecord(body) && typeof body['currentVersion'] === 'number' ? body['currentVersion'] : version
        throw new LandingDraftConflictError(currentVersion)
      }
      throw error
    }
  },

  async publish(): Promise<{ revisionId: string }> {
    try {
      const response = await api.post('/admin/landing-config/publish')
      return response.data as { revisionId: string }
    } catch (error) {
      const status = isRecord(error) && isRecord(error['response']) ? error['response']['status'] : null
      const body = isRecord(error) && isRecord(error['response']) ? error['response']['data'] : null
      if (status === 400 && isRecord(body) && body['message'] === 'LANDING_PUBLISH_INCOMPLETE') {
        const issues = Array.isArray(body['issues']) ? (body['issues'] as LandingPublishStrictIssue[]) : []
        throw new LandingPublishIncompleteError(issues)
      }
      throw error
    }
  },

  async rollback(revisionId: string): Promise<{ revisionId: string }> {
    const response = await api.post(`/admin/landing-config/rollback/${revisionId}`)
    return response.data as { revisionId: string }
  },

  async listRevisions(): Promise<LandingRevisionMeta[]> {
    const response = await api.get('/admin/landing-config/revisions')
    return response.data as LandingRevisionMeta[]
  },
}
