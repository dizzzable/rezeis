import { queryOptions } from '@tanstack/react-query'

import { api } from '@/lib/api'
import type { TariffConstructorDraft } from './tariff-constructor-schema'

export interface TariffConstructor extends TariffConstructorDraft {
  readonly contractVersion: number
  readonly id: string
  readonly enabled: boolean
  readonly draftVersion: number
  readonly publishedRevisionId: string | null
  readonly revisions: ReadonlyArray<{
    readonly id: string
    readonly version: number
    readonly publishedAt: string
  }>
}

export const tariffConstructorQueryKeys = {
  all: ['admin', 'tariff-constructors'] as const,
  detail: () => [...tariffConstructorQueryKeys.all, 'default'] as const,
}

export function tariffConstructorOptions() {
  return queryOptions({
    queryKey: tariffConstructorQueryKeys.detail(),
    queryFn: async ({ signal }) => {
      const response = await api.get<TariffConstructor>('/admin/tariff-constructors/default', { signal })
      return response.data
    },
  })
}

export async function saveTariffConstructorDraft(draft: TariffConstructorDraft): Promise<TariffConstructor> {
  const response = await api.put<TariffConstructor>('/admin/tariff-constructors/default/draft', draft)
  return response.data
}

export async function publishTariffConstructor(): Promise<{ revisionId: string; version: number }> {
  const response = await api.post<{ revisionId: string; version: number }>('/admin/tariff-constructors/default/publish')
  return response.data
}

export async function toggleTariffConstructor(enabled: boolean): Promise<{ enabled: boolean }> {
  const response = await api.put<{ enabled: boolean }>('/admin/tariff-constructors/default/enabled', { enabled })
  return response.data
}
