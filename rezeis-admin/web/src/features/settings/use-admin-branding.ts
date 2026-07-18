import { useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api'

export interface AdminBranding {
  readonly brandName: string
  readonly logoUrl: string | null
  readonly adminPwaIconUrl: string | null
}

interface AdminSettingsPayload {
  readonly branding?: Partial<AdminBranding> | null
}

const DEFAULT_ADMIN_BRANDING: AdminBranding = {
  brandName: 'Rezeis Admin',
  logoUrl: null,
  adminPwaIconUrl: null,
}

export function useAdminBranding(): AdminBranding {
  const query = useQuery<AdminSettingsPayload>({
    queryKey: ['admin', 'settings'],
    queryFn: async () => (await api.get<AdminSettingsPayload>('/admin/settings')).data,
  })
  const branding = query.data?.branding
  return {
    brandName: branding?.brandName?.trim() || DEFAULT_ADMIN_BRANDING.brandName,
    logoUrl: branding?.logoUrl?.trim() || null,
    adminPwaIconUrl: branding?.adminPwaIconUrl?.trim() || null,
  }
}
