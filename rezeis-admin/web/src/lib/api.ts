import axios, { type AxiosError, type AxiosInstance } from 'axios'
import { env } from '@/lib/env'
import { authStorage } from '@/lib/auth-storage'
import { useAuthStore } from '@/stores/auth-store'

export class ApiError extends Error {
  public readonly status?: number

  public constructor(message: string, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function readAccessToken(): string {
  return useAuthStore.getState().token || authStorage.getToken()
}

function normalizeError(error: AxiosError<{ message?: string }>): Error {
  const message: string = error.response?.data?.message ?? error.message ?? 'errors.requestFailed'
  return new ApiError(message, error.response?.status)
}

const api: AxiosInstance = axios.create({
  baseURL: env.adminApiUrl,
  headers: {
    'Content-Type': 'application/json',
  },
})

api.interceptors.request.use((config) => {
  const accessToken: string = readAccessToken()
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`
  }
  return config
})

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError<{ message?: string }>) => Promise.reject(normalizeError(error)),
)

export { api }
