/**
 * Payment-gateway brand icons.
 *
 * Each gateway exposes a small React component that renders an `<img>`
 * pointing at a vendor SVG asset shipped with the SPA. We use Vite's
 * built-in support for `?url` (and the default URL behaviour for
 * `*.svg`) so the bundler hashes the asset for cache-busting and
 * tree-shakes unused gateways automatically.
 *
 * The components accept a single `className` prop so callers can size
 * them via Tailwind (`h-5 w-5`). Brand colors live inside the SVG
 * markup, so we do not pass `currentColor` for branded icons; only
 * generic shapes (Cryptomus reduced "logo" symbol) inherit color.
 */

import type { JSX } from 'react'

import antilopayUrl from '@/assets/payments/antilopapay.svg'
import aurapayUrl from '@/assets/payments/Aurapay.svg'
import cryptomusUrl from '@/assets/payments/Cryptomus.svg'
import cryptopayUrl from '@/assets/payments/Cryptopay.svg'
import heleketUrl from '@/assets/payments/Heleket.svg'
import lavaUrl from '@/assets/payments/lava.svg'
import mulenpayUrl from '@/assets/payments/MulenPay.svg'
import overpayUrl from '@/assets/payments/overpay.svg'
import paypalychUrl from '@/assets/payments/Paypalych.svg'
import plategaUrl from '@/assets/payments/Platega.svg'
import riopayUrl from '@/assets/payments/riopay.svg'
import rollypayUrl from '@/assets/payments/rollypay.svg'
import severpayUrl from '@/assets/payments/severpay.svg'
import telegramStarsUrl from '@/assets/payments/TelegramStars.svg'
import wataUrl from '@/assets/payments/wata.svg'
import yookassaUrl from '@/assets/payments/Yookassa.svg'

export type PaymentGatewayIconType =
  | 'TELEGRAM_STARS'
  | 'YOOKASSA'
  | 'PLATEGA'
  | 'MULENPAY'
  | 'HELEKET'
  | 'CRYPTOMUS'
  | 'CRYPTOPAY'
  | 'ANTILOPAY'
  | 'OVERPAY'
  | 'PAYPALYCH'
  | 'RIOPAY'
  | 'WATA'
  | 'AURAPAY'
  | 'ROLLYPAY'
  | 'SEVERPAY'
  | 'LAVA'

interface IconProps {
  readonly className?: string
}

const URL_BY_TYPE: Record<PaymentGatewayIconType, string> = {
  TELEGRAM_STARS: telegramStarsUrl,
  YOOKASSA: yookassaUrl,
  PLATEGA: plategaUrl,
  MULENPAY: mulenpayUrl,
  HELEKET: heleketUrl,
  CRYPTOMUS: cryptomusUrl,
  CRYPTOPAY: cryptopayUrl,
  ANTILOPAY: antilopayUrl,
  OVERPAY: overpayUrl,
  PAYPALYCH: paypalychUrl,
  RIOPAY: riopayUrl,
  WATA: wataUrl,
  AURAPAY: aurapayUrl,
  ROLLYPAY: rollypayUrl,
  SEVERPAY: severpayUrl,
  LAVA: lavaUrl,
}

/**
 * Returns a React component that renders the given gateway's brand icon.
 * The component is keyed off the static URL_BY_TYPE map — unknown types
 * return `null` so callers can fall back to a lucide icon.
 */
export function getPaymentGatewayIcon(
  type: string,
): ((props: IconProps) => JSX.Element) | null {
  const url = URL_BY_TYPE[type as PaymentGatewayIconType]
  if (url === undefined) return null
  return function PaymentGatewayIcon({ className }: IconProps): JSX.Element {
    return (
      <img
        src={url}
        alt=""
        aria-hidden="true"
        className={className}
        draggable={false}
      />
    )
  }
}
