import axios from 'axios'
import type { AxiosError } from 'axios'
import { env } from '@/lib/env'

interface ApiErrorPayload {
  readonly detail?: string | { readonly msg?: string } | Array<{ readonly msg?: string }>
}

export const api = axios.create({
  baseURL: env.ruidApiUrl,
  timeout: 10000,
  withCredentials: true,
})

export function getApiErrorMessage(error: unknown): string {
  if (!isAxiosError(error)) {
    return 'Unable to load data from the user edge.'
  }
  const payload: ApiErrorPayload | undefined = error.response?.data
  if (typeof payload?.detail === 'string') {
    return payload.detail
  }
  if (Array.isArray(payload?.detail)) {
    return payload.detail.map((issue) => issue.msg).filter(Boolean).join(', ') || 'Request failed.'
  }
  if (typeof payload?.detail?.msg === 'string') {
    return payload.detail.msg
  }
  return error.message || 'Request failed.'
}

export function isApiUnauthorizedError(error: unknown): boolean {
  if (!isAxiosError(error)) {
    return false
  }
  return error.response?.status === 401
}

function isAxiosError(error: unknown): error is AxiosError<ApiErrorPayload> {
  return axios.isAxiosError(error)
}
