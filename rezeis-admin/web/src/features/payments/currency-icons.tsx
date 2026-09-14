/**
 * Inline currency icons for the payment gateway settings UI.
 *
 * Each entry maps a currency code to a vendor SVG asset shipped with the
 * SPA. We use Vite's default URL imports so unused icons are
 * tree-shaken automatically and the bundler hashes each file for
 * cache-busting.
 *
 * `USD` and `EUR` don't have vendor logos in our asset set — we fall
 * back to a simple `$`/`€` glyph. `XTR` (Telegram Stars) reuses the
 * Telegram star SVG. The native crypto coins use their official logos.
 */

import type { JSX } from 'react'

import avalancheUrl from '@/assets/currency/Avalanche.svg'
import bitcoinUrl from '@/assets/currency/Bitcoin.svg'
import bitcoinCashUrl from '@/assets/currency/BitcoinCash.svg'
import bnbUrl from '@/assets/currency/Bnb.svg'
import daiUrl from '@/assets/currency/Dai.svg'
import dashUrl from '@/assets/currency/Dash.svg'
import ethereumUrl from '@/assets/currency/Ethereum.svg'
import litecoinUrl from '@/assets/currency/Litecoin.svg'
import moneroUrl from '@/assets/currency/Monero.svg'
import polygonUrl from '@/assets/currency/Polygon.svg'
import rubelUrl from '@/assets/currency/Rubel.svg'
import solanaUrl from '@/assets/currency/Solana.svg'
import telegramStarUrl from '@/assets/currency/TelegramStar.svg'
import tonUrl from '@/assets/currency/Ton.svg'
import trxUrl from '@/assets/currency/Trx.svg'
import usdcUrl from '@/assets/currency/Usdc.svg'
import usdtUrl from '@/assets/currency/Usdt.svg'

/**
 * Codes this file can draw an icon or a display name for. It is an ICON
 * CATALOGUE, not the list of currencies the backend accepts, and it is
 * deliberately wider: every value of `enum Currency` in
 * `rezeis-admin/prisma/schema.prisma` (the only source of truth for what a
 * gateway or a price can carry), plus EUR, BCH, DAI, AVAX and MATIC, which the
 * enum does not have — the API refuses them. Do not type a request or build a
 * currency picker from this union; the gateway settings page gets its choices
 * from `GET /admin/payments/gateways/supported-currencies` and only looks the
 * icons up here. When a code is added to the enum, add an entry here too (and
 * ship a vendor SVG into `src/assets/currency/`).
 *
 * The header used to call this list a copy of the enum and to point at a
 * hand-written mirror, `src/common/types/prisma-enums.ts`, which was deleted on
 * 13.09.2026 after it was found to disagree with the schema in five enums. The
 * union below had drifted the same way, which is why it is described as what
 * it is rather than as a mirror.
 */
export type CurrencyCode =
  | 'USD'
  | 'EUR'
  | 'RUB'
  | 'XTR'
  | 'USDT'
  | 'USDC'
  | 'TON'
  | 'BTC'
  | 'BCH'
  | 'ETH'
  | 'LTC'
  | 'BNB'
  | 'DASH'
  | 'SOL'
  | 'XMR'
  | 'TRX'
  | 'DAI'
  | 'AVAX'
  | 'MATIC'

interface IconProps {
  readonly className?: string
}

const URL_BY_CURRENCY: Partial<Record<CurrencyCode, string>> = {
  RUB: rubelUrl,
  XTR: telegramStarUrl,
  USDT: usdtUrl,
  USDC: usdcUrl,
  TON: tonUrl,
  BTC: bitcoinUrl,
  BCH: bitcoinCashUrl,
  ETH: ethereumUrl,
  LTC: litecoinUrl,
  BNB: bnbUrl,
  DASH: dashUrl,
  SOL: solanaUrl,
  XMR: moneroUrl,
  TRX: trxUrl,
  DAI: daiUrl,
  AVAX: avalancheUrl,
  MATIC: polygonUrl,
}

/**
 * Map of human-friendly display names used in dropdowns next to the
 * currency code. Only included when meaningfully different from the
 * uppercased code (USD doesn't need "US Dollar" — the "$" glyph is
 * universal in the admin context).
 */
export const CURRENCY_DISPLAY_NAMES: Partial<Record<CurrencyCode, string>> = {
  RUB: 'Russian Ruble',
  XTR: 'Telegram Stars',
  USDT: 'Tether',
  USDC: 'USD Coin',
  TON: 'Toncoin',
  BTC: 'Bitcoin',
  BCH: 'Bitcoin Cash',
  ETH: 'Ethereum',
  LTC: 'Litecoin',
  BNB: 'Binance Coin',
  DASH: 'Dash',
  SOL: 'Solana',
  XMR: 'Monero',
  TRX: 'Tron',
  DAI: 'Dai',
  AVAX: 'Avalanche',
  MATIC: 'Polygon',
}

/**
 * Returns a React component that renders the currency icon, or `null`
 * if the currency is one of the fiat codes without a vendor SVG (USD /
 * EUR — caller falls back to a glyph).
 */
export function getCurrencyIcon(
  code: string,
): ((props: IconProps) => JSX.Element) | null {
  const url = URL_BY_CURRENCY[code as CurrencyCode]
  if (!url) return null
  return function CurrencyIcon({ className }: IconProps): JSX.Element {
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
