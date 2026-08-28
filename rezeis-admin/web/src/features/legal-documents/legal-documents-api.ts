/**
 * Legal documents — admin API client
 * ──────────────────────────────────
 * Talks to AdminLegalDocumentsController under /api/admin/legal-documents.
 * Exactly two documents exist and neither can be created or deleted, so this
 * client has a list and a patch and nothing else.
 */
import { z } from 'zod'

import { api } from '@/lib/api'
import { unwrapPayload, unwrapPayloadOrArray } from '@/lib/api-utils'

/**
 * Mirrors `LEGAL_DOCUMENT_KEYS` in the panel service, including its order —
 * the two lists decide the same thing and are checked against each other by
 * `legal-document-keys-parity.test.ts`.
 */
export const LEGAL_DOCUMENT_KEYS = ['USER_AGREEMENT', 'PRIVACY_POLICY', 'OFFER'] as const
export type LegalDocumentKey = (typeof LEGAL_DOCUMENT_KEYS)[number]

/**
 * Mirrors `LEGAL_DOCUMENT_BODY_MAX` on the server. Duplicated deliberately: the
 * counter has to render before any request is made, and a client that guesses
 * a smaller number is merely stricter, never wrong. Raise both together.
 */
export const LEGAL_DOCUMENT_BODY_MAX = 40_000
export const LEGAL_DOCUMENT_TITLE_MAX = 200

export const legalDocumentSchema = z.object({
  key: z.enum(LEGAL_DOCUMENT_KEYS),
  isActive: z.boolean(),
  titleRu: z.string(),
  titleEn: z.string(),
  bodyRu: z.string(),
  bodyEn: z.string(),
  updatedAt: z.string(),
})

export type LegalDocument = z.infer<typeof legalDocumentSchema>

export interface UpdateLegalDocumentPayload {
  readonly isActive?: boolean
  readonly titleRu?: string
  readonly titleEn?: string
  readonly bodyRu?: string
  readonly bodyEn?: string
}

export const LEGAL_DOCUMENT_QUERY_KEYS = {
  all: ['admin', 'legal-documents'] as const,
}

export const legalDocumentsApi = {
  async list(): Promise<LegalDocument[]> {
    const response = await api.get('/admin/legal-documents')
    return z.array(legalDocumentSchema).parse(unwrapPayloadOrArray(response.data))
  },
  async update(key: LegalDocumentKey, payload: UpdateLegalDocumentPayload): Promise<LegalDocument> {
    const response = await api.patch(`/admin/legal-documents/${key}`, payload)
    return legalDocumentSchema.parse(unwrapPayload(response.data))
  },
}
