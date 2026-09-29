/**
 * «Проверить ключи» on the Antilopay settings card.
 * -------------------------------------------------
 * Reader for `POST admin/payments/gateways/:id/check-keys`
 * (`AdminPaymentGatewaysController.checkGatewayKeys`, `payment_gateways:edit`).
 * The panel signs a small JSON with the credentials that are STORED and has
 * Antilopay's own `signature/check` say whether the signature is accepted, so
 * the operator learns before the first customer that the Secret ID and the
 * private key work together and that the server may call the API.
 *
 * Two limits the card says out loud:
 *   - what is checked is what is SAVED, not what is in the form. With unsaved
 *     changes the button is off and asks to save first — an answer about the
 *     old keys read under the new ones would be a false green;
 *   - the public key is not checked: it only verifies Antilopay's callbacks to
 *     us, which nothing here can provoke.
 *
 * The panel answers a verdict word and, where there is one, Antilopay's own
 * code; the words are the panel's (`AntilopayKeyCheckVerdict`), and this file
 * is the only place they are put into sentences.
 */
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import { KeyRound, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'

/** Mirrors `AntilopayKeyCheckResult` (antilopay-key-check.service.ts). */
export interface AntilopayKeyCheckResult {
  readonly verdict: string
  /** Antilopay's own `code`, when its answer carried one. */
  readonly code: number | null
  /** The HTTP status of an answer that was not a verdict. */
  readonly httpStatus: number | null
  /** How a call that got no answer ended. */
  readonly failure: 'TIMEOUT' | 'NETWORK' | null
}

type Translate = (key: string, values?: Record<string, string | number>) => string

/**
 * The sentence for a result, and whether it is good news. An answer this build
 * does not know (a newer panel's verdict) reads as «Antilopay не ответила» with
 * what came with it, never as a success.
 */
function describeKeyCheck(
  result: AntilopayKeyCheckResult,
  t: Translate,
): { readonly ok: boolean; readonly text: string } {
  const code = result.code ?? 0
  switch (result.verdict) {
    case 'OK':
      return { ok: true, text: t('paymentGateways.keyCheck.ok') }
    case 'SIGNATURE_REFUSED':
      return { ok: false, text: t('paymentGateways.keyCheck.signatureRefused') }
    case 'SECRET_ID_REJECTED':
      return { ok: false, text: t('paymentGateways.keyCheck.secretIdRejected', { code }) }
    case 'IP_NOT_ALLOWED':
      return { ok: false, text: t('paymentGateways.keyCheck.ipNotAllowed') }
    case 'KEYS_MISSING':
      return { ok: false, text: t('paymentGateways.keyCheck.keysMissing') }
    case 'PRIVATE_KEY_UNREADABLE':
      return { ok: false, text: t('paymentGateways.keyCheck.privateKeyUnreadable') }
    default: {
      const detail =
        result.failure === 'TIMEOUT'
          ? t('paymentGateways.keyCheck.detailTimeout')
          : result.failure === 'NETWORK'
            ? t('paymentGateways.keyCheck.detailNetwork')
            : result.code !== null
              ? t('paymentGateways.keyCheck.detailCode', { code: result.code })
              : result.httpStatus !== null
                ? t('paymentGateways.keyCheck.detailHttp', { status: result.httpStatus })
                : null
      return {
        ok: false,
        text:
          detail === null
            ? t('paymentGateways.keyCheck.notAnsweredBare')
            : t('paymentGateways.keyCheck.notAnswered', { detail }),
      }
    }
  }
}

interface AntilopayKeyCheckProps {
  readonly gatewayId: string
  /** The form differs from what is stored: the button checks what is stored. */
  readonly hasUnsavedChanges: boolean
}

export function AntilopayKeyCheck({ gatewayId, hasUnsavedChanges }: AntilopayKeyCheckProps): JSX.Element {
  const { t } = useTranslation()
  const check = useMutation({
    mutationFn: async (): Promise<AntilopayKeyCheckResult> =>
      (await api.post(`/admin/payments/gateways/${gatewayId}/check-keys`)).data as AntilopayKeyCheckResult,
  })
  const translate: Translate = (key, values) => t(key, values)
  // A result is about the keys as they were saved. Once the form has moved off
  // them it describes something else, so it is not shown.
  const shown = hasUnsavedChanges || check.data === undefined ? null : describeKeyCheck(check.data, translate)

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">{t('paymentGateways.keyCheck.title')}</p>
          <p className="text-xs text-muted-foreground">{t('paymentGateways.keyCheck.publicKeyNote')}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={hasUnsavedChanges || check.isPending}
          onClick={(): void => check.mutate()}
        >
          {check.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <KeyRound className="mr-2 h-4 w-4" />
          )}
          {t('paymentGateways.keyCheck.button')}
        </Button>
      </div>
      {hasUnsavedChanges && (
        <p className="text-xs text-muted-foreground">{t('paymentGateways.keyCheck.saveFirst')}</p>
      )}
      {!hasUnsavedChanges && check.isError && (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {t('paymentGateways.keyCheck.requestFailed')}
        </p>
      )}
      {shown !== null && (
        <p
          role={shown.ok ? 'status' : 'alert'}
          className={
            shown.ok
              ? 'flex items-start gap-1.5 text-xs text-emerald-600 dark:text-emerald-400'
              : 'flex items-start gap-1.5 text-xs text-destructive'
          }
        >
          {shown.ok ? (
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          ) : (
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
          {shown.text}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{t('paymentGateways.hints.antilopayIp')}</p>
    </div>
  )
}
