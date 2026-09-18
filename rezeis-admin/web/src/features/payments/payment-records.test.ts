import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  GATEWAY_LABELS,
  PARTNER_BALANCE_GATEWAY,
  describeDelivery,
  formatPaymentAmount,
  gatewayLabel,
  resolvePayment,
  type TransactionRow,
} from './payment-records'

/**
 * The decisions the Payments page makes about a row, without rendering it.
 */

function row(overrides: Partial<TransactionRow>): TransactionRow {
  return {
    id: 'cmfk2x9pq0010abcd1234efgh',
    paymentId: 'cmfk2x9pq0011abcd1234efgh',
    userId: 'cmfk2x9pq0000abcd1234efgh',
    status: 'COMPLETED',
    purchaseType: 'RENEW',
    gatewayType: 'YOOKASSA',
    currency: 'RUB',
    amount: '299',
    createdAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  }
}

describe('gateway names', () => {
  it('names every gateway the schema declares', () => {
    // Read from the schema itself: a gateway added there without a name here
    // would reach the page as a raw enum.
    const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '../../../../prisma/schema.prisma')
    const schema = readFileSync(schemaPath, 'utf8')
    const block = /enum PaymentGatewayType \{([\s\S]*?)\}/.exec(schema)?.[1] ?? ''
    const declared = block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[A-Z_]+$/.test(line))

    expect(declared.length).toBeGreaterThan(10)
    const named = [...Object.keys(GATEWAY_LABELS), PARTNER_BALANCE_GATEWAY].sort()
    expect(named).toEqual([...declared].sort())
  })

  it('writes brands as the Gateways page does, and translates only the wallet', () => {
    const t = (key: string): string => `t:${key}`
    expect(gatewayLabel('TELEGRAM_STARS', t)).toBe('Telegram Stars')
    expect(gatewayLabel('LAVA', t)).toBe('Lava.top')
    expect(gatewayLabel('PARTNER_BALANCE', t)).toBe('t:paymentsPage.gateways.PARTNER_BALANCE')
  })
})

describe('formatPaymentAmount', () => {
  it('keeps the kopecks: 1500.5 RUB is 1 500,50 ₽, not 1500.5 RUB and not rounded', () => {
    expect(formatPaymentAmount('1500.5', 'RUB', 'ru-RU')).toBe('1\xa0500,50\xa0₽')
    expect(formatPaymentAmount('1500.5', 'RUB', 'en-US')).toBe('₽1,500.50')
  })

  it('never rounds a coin away', () => {
    expect(formatPaymentAmount('0.00012345', 'BTC', 'en-US')).toContain('0.00012345')
    // Prisma writes the smallest amounts in exponent form.
    expect(formatPaymentAmount('1e-8', 'BTC', 'en-US')).toContain('0.00000001')
  })

  it('shows Telegram Stars whole', () => {
    expect(formatPaymentAmount('1500', 'XTR', 'en-US')).toBe('XTR\xa01,500')
  })

  it('writes a code Intl refuses after the number', () => {
    expect(formatPaymentAmount('12.5', 'USDT', 'ru-RU')).toBe('12,5\xa0USDT')
  })

  it('says nothing is there rather than printing "null"', () => {
    expect(formatPaymentAmount(null, 'RUB', 'ru-RU')).toBe('—')
  })
})

describe('describeDelivery', () => {
  it('gives the time when the purchase was delivered', () => {
    expect(describeDelivery(row({ fulfilledAt: '2026-09-01T10:00:05.000Z' }))).toEqual({
      kind: 'delivered',
      at: '2026-09-01T10:00:05.000Z',
    })
  })

  it('says a failed or cancelled payment delivers nothing — not «not yet»', () => {
    expect(describeDelivery(row({ status: 'FAILED', fulfilledAt: null }))).toEqual({ kind: 'notDelivered' })
    expect(describeDelivery(row({ status: 'CANCELED', fulfilledAt: null }))).toEqual({ kind: 'notDelivered' })
  })

  it('names the platform of an import the importer did not stamp', () => {
    expect(
      describeDelivery(row({ fulfilledAt: null, planSnapshot: { importedFrom: 'remnashop', sourceTransactionId: 7 } })),
    ).toEqual({ kind: 'noStampImported', source: 'remnashop' })
  })

  it('keeps «not yet» for a payment still waiting to be paid', () => {
    expect(describeDelivery(row({ status: 'PENDING', fulfilledAt: null }))).toEqual({ kind: 'awaitingPayment' })
  })

  it('says only that there is no record for a completed payment of ours without the stamp', () => {
    expect(describeDelivery(row({ status: 'COMPLETED', fulfilledAt: null }))).toEqual({ kind: 'noStamp' })
    expect(describeDelivery(row({ status: 'REFUNDED', fulfilledAt: null }))).toEqual({ kind: 'noStamp' })
  })
})

describe('resolvePayment', () => {
  it('finds an imported payment by the number the cabinet shows for it', () => {
    const imported = row({ paymentId: 'bedolaga:4821' })

    expect(resolvePayment([imported], '4821')).toEqual({ kind: 'found', transaction: imported })
  })

  it('does not guess between two platforms that used the same number', () => {
    const items = [row({ id: 'a', paymentId: 'bedolaga:4821' }), row({ id: 'b', paymentId: 'remnashop:4821' })]

    expect(resolvePayment(items, '4821')).toEqual({ kind: 'ambiguous', count: 2 })
  })

  it('still prefers an exact payment id over anything that only ends the same way', () => {
    const ours = row({ id: 'ours', paymentId: '4821' })
    const imported = row({ id: 'imported', paymentId: 'bedolaga:4821' })

    expect(resolvePayment([imported, ours], '4821')).toEqual({ kind: 'found', transaction: ours })
  })
})
