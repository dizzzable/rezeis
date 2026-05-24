/**
 * Helpers for surfacing axios / fetch error messages to the operator
 * via Sonner toasts. Always returns a non-empty string so callers can
 * pass it directly to `toast.error(...)`.
 *
 * The shape `error.response?.data?.message` is what NestJS' default
 * exception filter emits, which is the convention this admin uses
 * server-side. We fall back through a chain of safer extractions so
 * a 502 / network error does not crash the UI.
 */

interface ApiErrorShape {
  response?: {
    data?: {
      message?: string
      error?: string
    }
  }
  message?: string
}

export function getErrorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== 'object') return fallback
  const e = error as ApiErrorShape
  const apiMessage = e.response?.data?.message
  if (typeof apiMessage === 'string' && apiMessage.length > 0) return apiMessage
  const apiError = e.response?.data?.error
  if (typeof apiError === 'string' && apiError.length > 0) return apiError
  if (typeof e.message === 'string' && e.message.length > 0) return e.message
  return fallback
}
