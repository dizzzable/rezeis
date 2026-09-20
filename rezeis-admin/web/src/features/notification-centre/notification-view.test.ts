import { describe, expect, it } from 'vitest'

import {
  formatNotificationAge,
  formatUnreadBadge,
  notificationTone,
  toPanelPath,
} from './notification-view'

const NOW = Date.parse('2026-09-20T12:00:00.000Z')

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString()
}

describe('how one alert reads', () => {
  it('dates a fresh alert by how long ago it was, and an old one by the clock', () => {
    expect(formatNotificationAge(ago(20_000), NOW, 'только что')).toBe('только что')
    expect(formatNotificationAge(ago(5 * 60_000), NOW, 'только что')).toMatch(/5/)
    expect(formatNotificationAge(ago(3 * 60 * 60_000), NOW, 'только что')).toMatch(/3/)
    // Past a day the subtraction stops being useful and the date is what the
    // reader was after anyway.
    expect(formatNotificationAge(ago(3 * 24 * 60 * 60_000), NOW, 'только что')).toMatch(/2026/)
  })

  it('reads a clock that runs behind the server as «только что», not as the future', () => {
    // The browser's clock is the operator's, not the server's. A row written
    // two seconds into this panel's future must not say «через 3 минуты».
    expect(formatNotificationAge(ago(-3 * 60_000), NOW, 'только что')).toBe('только что')
  })

  it('says nothing rather than «Invalid Date» when the timestamp is not one', () => {
    expect(formatNotificationAge('not a date', NOW, 'только что')).toBe('—')
  })

  it('takes its tone from the severity, and treats anything unknown as ordinary', () => {
    expect(notificationTone('ERROR')).toBe('error')
    expect(notificationTone('WARNING')).toBe('warning')
    expect(notificationTone('INFO')).toBe('info')
    expect(notificationTone('SOMETHING_NEW')).toBe('info')
  })

  it('stops counting the badge before it outgrows the bell', () => {
    expect(formatUnreadBadge(0)).toBe('0')
    expect(formatUnreadBadge(99)).toBe('99')
    expect(formatUnreadBadge(100)).toBe('99+')
  })

  it('opens only paths inside the panel', () => {
    expect(toPanelPath('/support-tickets?ticket=t-1')).toBe('/support-tickets?ticket=t-1')
    // `//host` is an ADDRESS, not a path: handed to the router it leaves the
    // panel entirely, and it starts with a slash like every legitimate url here.
    expect(toPanelPath('//evil.example/steal')).toBeNull()
    expect(toPanelPath('https://evil.example')).toBeNull()
    expect(toPanelPath('')).toBeNull()
  })
})
