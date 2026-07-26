import { describe, expect, it } from 'vitest'

import {
  formatRequestTerms,
  isCounterOffer,
  isHistoryRequest,
  majorToMinor,
  placementSpendPayload,
} from './advertising-api'

describe('majorToMinor', () => {
  it('converts major currency units to minor integers', () => {
    expect(majorToMinor(3000)).toBe(300000)
    expect(majorToMinor('3000.50')).toBe(300050)
    expect(majorToMinor('10,25')).toBe(1025)
  })

  it('rejects invalid amounts', () => {
    expect(majorToMinor('')).toBeUndefined()
    expect(majorToMinor('abc')).toBeUndefined()
    expect(majorToMinor(-1)).toBeUndefined()
  })
})

describe('placementSpendPayload', () => {
  it('includes spend for COMPANY placements', () => {
    expect(placementSpendPayload('COMPANY', '3000', 'rub')).toEqual({
      spendAmountMinor: 300000,
      spendCurrency: 'RUB',
    })
  })

  it('strips spend for PARTNER placements (commission is cost)', () => {
    expect(placementSpendPayload('PARTNER', '9999', 'USD')).toEqual({})
  })

  // Omitting the field means "leave the stored budget alone", so a wrong amount
  // could be typed but never removed: the operator got a success toast and the old
  // number kept dividing into CAC and ROAS. An empty field is an explicit clear.
  it('clears spend explicitly when the major amount is empty/invalid', () => {
    expect(placementSpendPayload('COMPANY', '', 'RUB')).toEqual({
      spendAmountMinor: null,
      spendCurrency: null,
    })
    expect(placementSpendPayload('COMPANY', 'abc', 'RUB')).toEqual({
      spendAmountMinor: null,
      spendCurrency: null,
    })
  })

  // Free text used to reach the API, and the budget currency becomes the label on
  // revenue, CAC and ROAS — 'RUR' or a typo silently mislabelled every number.
  it('falls back to the first known currency for an unknown code', () => {
    expect(placementSpendPayload('COMPANY', '3000', 'RUR')).toEqual({
      spendAmountMinor: 300000,
      spendCurrency: 'RUB',
    })
  })
})

describe('request terms helpers', () => {
  it('detects counter-offer when approved window differs', () => {
    expect(isCounterOffer(90, 30)).toBe(true)
    expect(isCounterOffer(30, 30)).toBe(false)
    expect(isCounterOffer(30, null)).toBe(false)
  })

  it('formats terms for proposed / agreed / counter', () => {
    expect(formatRequestTerms({ proposedWindowDays: 90, approvedWindowDays: null, status: 'PENDING' })).toEqual({
      kind: 'proposed',
      proposed: 90,
      approved: null,
    })
    expect(formatRequestTerms({ proposedWindowDays: 30, approvedWindowDays: 30, status: 'ACTIVE' })).toEqual({
      kind: 'agreed',
      proposed: 30,
      approved: 30,
    })
    expect(formatRequestTerms({ proposedWindowDays: 90, approvedWindowDays: 30, status: 'COUNTERED' })).toEqual({
      kind: 'counter',
      proposed: 90,
      approved: 30,
    })
  })

  it('classifies history vs pending statuses', () => {
    expect(isHistoryRequest('PENDING')).toBe(false)
    expect(isHistoryRequest('COUNTERED')).toBe(true)
    expect(isHistoryRequest('ACTIVE')).toBe(true)
    expect(isHistoryRequest('REJECTED')).toBe(true)
  })
})
